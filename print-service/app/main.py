import ipaddress
import json
import logging
import os
import time
from urllib.parse import urlparse

import requests
import redis
from sqlalchemy import create_engine, text
from app.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("print-service")

# OpenTelemetry setup
_otel_exporter_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
if _otel_exporter_endpoint or settings.otel_endpoint:
    from opentelemetry import trace, metrics
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
    from opentelemetry.instrumentation.redis import RedisInstrumentor
    from opentelemetry.instrumentation.requests import RequestsInstrumentor

    resource = Resource.create({"service.name": settings.otel_service_name})

    if _otel_exporter_endpoint:
        trace_exporter = OTLPSpanExporter()
        metric_exporter = OTLPMetricExporter()
    else:
        trace_exporter = OTLPSpanExporter(endpoint=f"{settings.otel_endpoint}/v1/traces")
        metric_exporter = OTLPMetricExporter(endpoint=f"{settings.otel_endpoint}/v1/metrics")

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(trace_exporter))
    trace.set_tracer_provider(provider)

    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(metric_exporter)],
    )
    metrics.set_meter_provider(meter_provider)

    tracer = trace.get_tracer(__name__)
    _meter = metrics.get_meter(__name__)
    _orders_processed = _meter.create_counter(
        "print_service.orders_processed",
        description="Number of orders processed by the print service",
    )
    _print_errors = _meter.create_counter(
        "print_service.print_errors",
        description="Number of failed print attempts",
    )
else:
    tracer = None
    _orders_processed = None
    _print_errors = None

engine = create_engine(settings.database_url)

if _otel_exporter_endpoint or settings.otel_endpoint:
    SQLAlchemyInstrumentor().instrument(engine=engine)
    RedisInstrumentor().instrument()
    RequestsInstrumentor().instrument()

_BLOCKED_PRINTER_HOSTS = {
    "localhost", "postgres", "redis", "menu-service", "order-service",
    "admin", "print-service", "metadata.google.internal",
}


def _is_safe_printer_url(url: str) -> bool:
    """Return True only if url is a safe http/https URL not pointing to internal resources."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower()
        if not host or host in _BLOCKED_PRINTER_HOSTS:
            return False
        try:
            addr = ipaddress.ip_address(host)
            # Allow private LAN IPs — printer lives on the local network.
            # Block loopback and link-local (169.254.x — cloud metadata endpoints) only.
            if addr.is_loopback or addr.is_link_local:
                return False
        except ValueError:
            pass
        return True
    except Exception:
        return False


def get_printer_url(kitchen_id: str) -> str | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT value FROM settings WHERE kitchen_id = :kid AND key = 'printer_url'"),
            {"kid": kitchen_id},
        ).fetchone()
    return row[0] if row and row[0] else None


def get_kitchen_name(kitchen_id: str) -> str:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT value FROM settings WHERE kitchen_id = :kid AND key = 'kitchen_name'"),
            {"kid": kitchen_id},
        ).fetchone()
    return row[0] if row and row[0] else "ByteOrder Kitchen"


# Ticket labels only — menu item/ingredient/option names print in whatever
# language the kitchen entered them in and are never translated here.
TICKET_LABELS = {
    "en": {
        "order": "Order", "table": "TABLE", "name": "Name",
        "with": "With", "no": "NO", "total": "TOTAL", "ea": "ea",
        "receipt": "RECEIPT", "paid_by": "Paid by", "thank_you": "Thank you",
        "cash": "Cash", "transfer": "Transfer", "card": "Card", "other": "Other",
    },
    "th": {
        "order": "ออเดอร์", "table": "โต๊ะ", "name": "ชื่อ",
        "with": "ใส่", "no": "ไม่ใส่", "total": "ยอดรวม", "ea": "ต่อชิ้น",
        "receipt": "ใบเสร็จ", "paid_by": "ชำระโดย", "thank_you": "ขอบคุณครับ/ค่ะ",
        "cash": "เงินสด", "transfer": "โอน", "card": "บัตร", "other": "อื่นๆ",
    },
}


def money(minor: int | None, currency: str) -> str:
    """Minor units to a printable amount. Prices are stored as integers so this
    is the only place rounding happens."""
    if minor is None:
        return ""
    return f"{minor / 100:,.2f} {currency}"


def _item_lines(item: dict, currency: str, labels: dict) -> list[str]:
    """One dish with its choices, as it reads on both the ticket and the bill."""
    unit = item.get("unit_price")
    qty = item.get("quantity", 1)
    # Quantity always shown: "1x" reads the same way as "3x" and removes any
    # doubt about whether a count was simply left off.
    head = f">> {qty}x {item['name']}"
    lines = [head + (f"   {money(unit, currency)} {labels['ea']}" if unit is not None else "")]

    included = [i["name"] for i in item.get("ingredients", []) if i["included"]]
    excluded = [i["name"] for i in item.get("ingredients", []) if not i["included"]]

    if included:
        lines.append(f"   {labels['with']}: {', '.join(included)}")
    for i in item.get("ingredients", []):
        if i["included"] and i.get("price_delta"):
            lines.append(f"     + {i['name']}  {money(i['price_delta'], currency)}")
    if excluded:
        lines.append(f"   {labels['no']}:   {', '.join(excluded)}")

    options_by_group: dict[str, list[str]] = {}
    for opt in item.get("options", []):
        options_by_group.setdefault(opt["group"], []).append(opt["name"])
    for group, opts in options_by_group.items():
        lines.append(f"   {group}: {', '.join(opts)}")
    for opt in item.get("options", []):
        if opt.get("price_delta"):
            lines.append(f"     + {opt['name']}  {money(opt['price_delta'], currency)}")

    return lines


def format_receipt(receipt: dict, kitchen_id: str) -> dict:
    """The bill for one table or one takeaway order, printed on payment.

    Covers every order settled together, so a table that ordered three times
    gets one piece of paper rather than three.
    """
    kitchen = get_kitchen_name(kitchen_id)
    currency = receipt.get("currency") or "THB"
    lang = receipt.get("ticket_language") or "en"
    labels = TICKET_LABELS.get(lang, TICKET_LABELS["en"])

    lines = [kitchen, labels["receipt"]]
    # A takeaway bill has no table, so the customer is what identifies it.
    if receipt.get("table_label"):
        lines.append(f"{labels['table']}: {receipt['table_label']}")
    elif receipt.get("customer_name"):
        lines.append(f"{labels['name']}: {receipt['customer_name']}")
    lines.append("")

    for order in receipt.get("orders", []):
        lines.append(f"{labels['order']}: {order.get('order_number', '')}")
        for item in order.get("items", []):
            lines += _item_lines(item, currency, labels)
        lines.append("")

    if receipt.get("total") is not None:
        lines.append("-" * 32)
        lines.append(f"{labels['total']}: {money(receipt['total'], currency)}")

    method = receipt.get("payment_method")
    if method:
        # An unrecognised method still prints, rather than the bill silently
        # claiming nothing was paid.
        lines.append(f"{labels['paid_by']}: {labels.get(method, method)}")

    lines += ["", labels["thank_you"], ""]
    return {"text": "\n".join(lines)}


def format_order(order: dict, kitchen_id: str) -> dict:
    kitchen = get_kitchen_name(kitchen_id)
    # Carried on the payload rather than read here, so this formatter and
    # pi-printer-client's cannot disagree about the currency or language.
    currency = order.get("currency") or "THB"
    lang = order.get("ticket_language") or "en"
    labels = TICKET_LABELS.get(lang, TICKET_LABELS["en"])
    lines = [
        f"{kitchen}",
        f"{labels['order']}: {order['order_number']}",
    ]
    # Table first and unabbreviated — it's what staff read to deliver the food.
    if order.get("table_label"):
        lines.append(f"{labels['table']}: {order['table_label']}")
    lines += [
        f"{labels['name']}:  {order['customer_name']}",
        "",
    ]

    for item in order["items"]:
        lines += _item_lines(item, currency, labels)
        lines.append("")

    if order.get("total") is not None:
        lines.append("-" * 32)
        lines.append(f"{labels['total']}: {money(order['total'], currency)}")
        lines.append("")

    return {"text": "\n".join(lines)}


def send_to_printer(payload: dict, printer_url: str) -> bool:
    try:
        resp = requests.post(f"{printer_url.rstrip('/')}/print", json=payload, timeout=10)
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error("Failed to send to printer: %s", e)
        return False


def process_order(message_data: bytes):
    try:
        order = json.loads(message_data)
    except json.JSONDecodeError:
        log.error("Invalid JSON in order message")
        return

    kitchen_id = order.get("kitchen_id", "")
    if not kitchen_id:
        log.warning("Order %s has no kitchen_id — skipping", order.get("order_number"))
        return

    # A message with no `kind` is a kitchen ticket published by an older build.
    is_receipt = order.get("kind") == "receipt"
    # Named once and reused by every log line below: a receipt has no order
    # number, and "order None not printed" tells whoever reads the log nothing.
    what = (
        f"receipt {order.get('bill_id')}" if is_receipt
        else f"order {order.get('order_number')}"
    )
    # Takeaway has no table, so the customer is what identifies the bill.
    who = order.get("table_label") or order.get("customer_name") or "takeaway"
    log.info("Processing %s for %s (kitchen: %s)", what, who, kitchen_id)

    printer_url = get_printer_url(kitchen_id)
    if not printer_url:
        log.warning("No printer URL configured for kitchen %s — %s not printed", kitchen_id, what)
        return
    if not _is_safe_printer_url(printer_url):
        log.error("Printer URL is not a safe external URL — refusing to connect for %s", what)
        return

    payload = format_receipt(order, kitchen_id) if is_receipt else format_order(order, kitchen_id)

    if tracer:
        with tracer.start_as_current_span("print_order") as span:
            span.set_attribute("print.kind", "receipt" if is_receipt else "order")
            # Empty on a receipt, which carries a bill_id instead of either.
            span.set_attribute("order.number", order.get("order_number", ""))
            span.set_attribute("order.customer", order.get("customer_name", ""))
            span.set_attribute("bill.id", order.get("bill_id", ""))
            span.set_attribute("order.kitchen_id", kitchen_id)
            span.set_attribute("printer.url", printer_url)
            success = send_to_printer(payload, printer_url)
            span.set_attribute("print.success", success)
            if _orders_processed:
                _orders_processed.add(1, {"kitchen_id": kitchen_id, "success": str(success)})
            if not success and _print_errors:
                _print_errors.add(1, {"kitchen_id": kitchen_id})
    else:
        send_to_printer(payload, printer_url)


def main():
    log.info("Print service starting, connecting to Redis at %s", settings.redis_url)

    r = redis.from_url(settings.redis_url, decode_responses=False)
    pubsub = r.pubsub()
    pubsub.subscribe("new_orders")

    log.info("Subscribed to new_orders channel, waiting for orders...")

    for message in pubsub.listen():
        if message["type"] != "message":
            continue
        process_order(message["data"])


if __name__ == "__main__":
    # Brief delay to allow Redis to be ready on cold start
    time.sleep(2)
    main()
