"""
Connects to the ByteOrder backend SSE stream and forwards print jobs to the
local ble-print-server running on localhost:8080.
"""
import json
import logging
import time

import requests
from sseclient import SSEClient

log = logging.getLogger(__name__)

BLE_PRINT_URL = "http://localhost:8080/print"
RECONNECT_DELAY = 5  # seconds between SSE reconnect attempts

# Ticket labels only — menu item/ingredient/option names print in whatever
# language the kitchen entered them in and are never translated here. Kept in
# step with print-service's TICKET_LABELS: this client has no DB of its own, so
# the language travels on the order payload as "ticket_language" instead.
TICKET_LABELS = {
    "en": {
        "table": "TABLE", "customer": "Customer", "with": "With",
        "no": "NO", "note": "Note", "total": "TOTAL", "ea": "ea",
        "receipt": "RECEIPT", "order": "Order", "paid_by": "Paid by",
        "thank_you": "Thank you",
        "cash": "Cash", "transfer": "Transfer", "card": "Card", "other": "Other",
    },
    "th": {
        "table": "โต๊ะ", "customer": "ลูกค้า", "with": "ใส่",
        "no": "ไม่ใส่", "note": "หมายเหตุ", "total": "ยอดรวม", "ea": "ต่อชิ้น",
        "receipt": "ใบเสร็จ", "order": "ออเดอร์", "paid_by": "ชำระโดย",
        "thank_you": "ขอบคุณครับ/ค่ะ",
        "cash": "เงินสด", "transfer": "โอน", "card": "บัตร", "other": "อื่นๆ",
    },
}


def _money(minor, currency: str) -> str:
    """Minor units to a printable amount; prices are stored as integers."""
    if minor is None:
        return ""
    return f"{minor / 100:,.2f} {currency}"


def _item_lines(item: dict, currency: str, labels: dict) -> list[str]:
    """One dish with its choices, as it reads on both the ticket and the bill."""
    name = item.get("name", "?")
    qty = item.get("quantity", 1)
    notes = item.get("notes") or ""
    unit = item.get("unit_price")
    lines = [f"  {qty}x {name}" + (f"   {_money(unit, currency)} {labels['ea']}" if unit is not None else "")]
    if notes:
        lines.append(f"     * {notes}")

    ingredients = item.get("ingredients") or []
    included = [i["name"] for i in ingredients if i.get("included")]
    excluded = [i["name"] for i in ingredients if not i.get("included")]
    if included:
        lines.append(f"     {labels['with']}: {', '.join(included)}")
    for i in ingredients:
        if i.get("included") and i.get("price_delta"):
            lines.append(f"       + {i['name']}  {_money(i['price_delta'], currency)}")
    if excluded:
        lines.append(f"     {labels['no']}:   {', '.join(excluded)}")

    options_by_group: dict[str, list[str]] = {}
    for opt in item.get("options") or []:
        options_by_group.setdefault(opt.get("group", ""), []).append(opt["name"])
    for group, opts in options_by_group.items():
        lines.append(f"     {group}: {', '.join(opts)}")
    for opt in item.get("options") or []:
        if opt.get("price_delta"):
            lines.append(f"       + {opt['name']}  {_money(opt['price_delta'], currency)}")

    return lines


def _format_receipt(receipt: dict) -> str:
    """The bill for one table or one takeaway order, printed on payment.

    Mirrors print-service's format_receipt() over the same payload — the two
    printer backends must not disagree about what a bill says.
    """
    lang = receipt.get("ticket_language") or "en"
    labels = TICKET_LABELS.get(lang, TICKET_LABELS["en"])
    currency = receipt.get("currency") or "THB"

    lines = ["=" * 32, labels["receipt"], "=" * 32]
    # A takeaway bill has no table, so the customer is what identifies it.
    if receipt.get("table_label"):
        lines.append(f"{labels['table']}: {receipt['table_label']}")
    elif receipt.get("customer_name"):
        lines.append(f"{labels['customer']}: {receipt['customer_name']}")

    for order in receipt.get("orders") or []:
        lines.append(f"{labels['order']}: {order.get('order_number', '')}")
        for item in order.get("items") or []:
            lines += _item_lines(item, currency, labels)

    if receipt.get("total") is not None:
        lines.append("-" * 32)
        lines.append(f"{labels['total']}: {_money(receipt['total'], currency)}")

    method = receipt.get("payment_method")
    if method:
        # An unrecognised method still prints, rather than the bill silently
        # claiming nothing was paid.
        lines.append(f"{labels['paid_by']}: {labels.get(method, method)}")

    lines += ["=" * 32, labels["thank_you"], ""]
    return "\n".join(lines)


def _format_order(order: dict) -> str:
    """Convert an order dict to a plain-text receipt string.

    The order dict is the payload published by order-service's create_order.
    print-service has a second formatter over the same payload — anything added
    to one ticket has to be added to the other, or the two printer backends
    print different things.
    """
    lang = order.get("ticket_language") or "en"
    labels = TICKET_LABELS.get(lang, TICKET_LABELS["en"])

    lines = []
    lines.append("=" * 32)
    # Redis payload uses order_number; fall back to order_id then unknown
    order_ref = order.get("order_number") or str(order.get("order_id", "?"))
    lines.append(f"ORDER #{order_ref}")
    lines.append("=" * 32)

    # Table first: it is what staff read to know where the food goes. Absent for
    # takeaway orders placed from the kiosk QR.
    if order.get("table_label"):
        lines.append(f"{labels['table']}: {order['table_label']}")

    customer = order.get("customer_name") or order.get("customer_phone") or ""
    if customer:
        lines.append(f"{labels['customer']}: {customer}")

    currency = order.get("currency") or "THB"

    for item in order.get("items") or []:
        lines += _item_lines(item, currency, labels)

    if order.get("notes"):
        lines.append("")
        lines.append(f"{labels['note']}: {order['notes']}")

    if order.get("total") is not None:
        lines.append("-" * 32)
        lines.append(f"{labels['total']}: {_money(order['total'], currency)}")

    lines.append("=" * 32)
    lines.append("")
    return "\n".join(lines)


def _send_to_printer(text: str) -> None:
    resp = requests.post(BLE_PRINT_URL, json={"text": text}, timeout=10)
    resp.raise_for_status()
    log.info("Print job sent (%d bytes)", len(text))


def run(api_base: str, mac_address: str) -> None:
    """
    Stream SSE events from the backend and print each new order.
    Reconnects automatically on error or if the stream ends.
    """
    url = f"{api_base}/orders/printers/stream"
    headers = {"Authorization": f"Bearer {mac_address}"}

    log.info("Connecting to print stream: %s", url)

    while True:
        try:
            response = requests.get(url, headers=headers, stream=True, timeout=None)
            if response.status_code == 401:
                log.error("Printer not claimed — waiting for claim before retrying")
                time.sleep(30)
                continue
            response.raise_for_status()

            client = SSEClient(response)
            for event in client.events():
                if not event.data or event.data == ":keepalive":
                    continue
                try:
                    order = json.loads(event.data)
                    # No `kind` means a kitchen ticket from an older backend.
                    text = (_format_receipt(order) if order.get("kind") == "receipt"
                            else _format_order(order))
                    _send_to_printer(text)
                except (json.JSONDecodeError, requests.RequestException) as exc:
                    log.error("Print error: %s", exc)

            log.warning("SSE stream ended cleanly, reconnecting in %ds", RECONNECT_DELAY)

        except requests.RequestException as exc:
            log.warning("SSE connection lost (%s), retrying in %ds", exc, RECONNECT_DELAY)

        time.sleep(RECONNECT_DELAY)
