from unittest.mock import MagicMock, patch
import requests
from byteorder_printer.print_client import _format_order, _format_receipt, run


# ── _format_order ─────────────────────────────────────────────────────────────

def test_format_order_uses_order_number():
    order = {"order_number": "0042", "customer_name": "Alice", "items": []}
    receipt = _format_order(order)
    assert "ORDER #0042" in receipt


def test_format_order_falls_back_to_order_id():
    order = {"order_id": 7, "customer_name": "Bob", "items": []}
    receipt = _format_order(order)
    assert "ORDER #7" in receipt


def test_format_order_includes_customer_and_items():
    order = {
        "order_number": "0001",
        "customer_name": "Carol",
        "items": [{"name": "Burger", "quantity": 1}],
    }
    receipt = _format_order(order)
    assert "Customer: Carol" in receipt
    assert "1x Burger" in receipt


def test_format_order_includes_table_above_customer():
    order = {
        "order_number": "0002",
        "customer_name": "Table 5",
        "table_label": "Table 5",
        "items": [],
    }
    receipt = _format_order(order)
    assert "TABLE: Table 5" in receipt
    # Staff read the table to know where the food goes, so it comes first.
    assert receipt.index("TABLE: Table 5") < receipt.index("Customer:")


def test_format_order_omits_table_for_takeaway():
    order = {"order_number": "0003", "customer_name": "Dave", "items": []}
    assert "TABLE" not in _format_order(order)

    order["table_label"] = None
    assert "TABLE" not in _format_order(order)


def test_format_order_renders_ingredients_from_the_published_payload():
    """The payload carries ingredients/options, not the notes field this used to read."""
    order = {
        "order_number": "0004",
        "customer_name": "Erin",
        "items": [
            {
                "name": "Salad",
                "ingredients": [
                    {"name": "Lettuce", "included": True},
                    {"name": "Onion", "included": False},
                ],
                "options": [
                    {"group": "Size", "name": "Large"},
                    {"group": "Size", "name": "Extra Sauce"},
                ],
            }
        ],
    }
    receipt = _format_order(order)
    assert "With: Lettuce" in receipt
    assert "NO:   Onion" in receipt
    assert "Size: Large, Extra Sauce" in receipt


def test_format_order_handles_items_without_customisations():
    order = {
        "order_number": "0005",
        "customer_name": "Frank",
        "items": [{"name": "Burger", "ingredients": [], "options": []}],
    }
    receipt = _format_order(order)
    assert "1x Burger" in receipt
    assert "With:" not in receipt
    assert "NO:" not in receipt


# ── run — reconnect behaviour ─────────────────────────────────────────────────

def _mock_sse_response(events_data):
    """Build a fake requests.Response + SSEClient that yields given event data strings."""
    mock_events = []
    for data in events_data:
        e = MagicMock()
        e.data = data
        mock_events.append(e)

    mock_sse = MagicMock()
    mock_sse.events.return_value = iter(mock_events)
    return mock_sse


def test_run_sleeps_after_clean_stream_end():
    """If the SSE stream ends without an exception, still sleep before reconnecting."""
    # First iteration: stream ends cleanly. Second: raise to exit the loop.
    call_count = 0

    def fake_get(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count > 1:
            raise KeyboardInterrupt  # break out of while True
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        return resp

    with patch("byteorder_printer.print_client.requests.get", side_effect=fake_get), \
         patch("byteorder_printer.print_client.SSEClient") as mock_sse_cls, \
         patch("byteorder_printer.print_client.time") as mock_time:

        mock_sse_cls.return_value.events.return_value = iter([])  # empty stream

        try:
            run("http://test", "AA:BB:CC:DD:EE:FF")
        except KeyboardInterrupt:
            # Expected: used to break out of run()'s infinite loop during testing.
            pass

    # sleep must have been called after the clean stream end
    mock_time.sleep.assert_called()
    assert mock_time.sleep.call_args[0][0] == 5


def test_run_sleeps_after_connection_error():
    """Connection errors also trigger the reconnect sleep."""
    call_count = 0

    def fake_get(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count > 1:
            raise KeyboardInterrupt
        raise requests.RequestException("connection refused")

    with patch("byteorder_printer.print_client.requests.get", side_effect=fake_get), \
         patch("byteorder_printer.print_client.time") as mock_time:

        try:
            run("http://test", "AA:BB:CC:DD:EE:FF")
        except KeyboardInterrupt:
            # Expected: used to break out of run()'s infinite loop during testing.
            pass

    mock_time.sleep.assert_called()


def test_format_order_shows_quantity_price_and_total():
    """quantity was read here long before the payload carried it, so it always
    printed 1x. These assert it now reflects what was ordered."""
    order = {
        "order_number": "0006",
        "customer_name": "Gina",
        "currency": "THB",
        "total": 36000,
        "items": [{"name": "Burger", "quantity": 3, "unit_price": 12000, "ingredients": [], "options": []}],
    }
    receipt = _format_order(order)
    assert "3x Burger" in receipt
    assert "120.00 THB ea" in receipt
    assert "TOTAL: 360.00 THB" in receipt


def test_format_order_prints_modifier_charges():
    order = {
        "order_number": "0007",
        "customer_name": "Jo",
        "currency": "GBP",
        "total": 15500,
        "items": [{
            "name": "Burger", "quantity": 1, "unit_price": 12000,
            "ingredients": [{"name": "Bacon", "included": True, "price_delta": 2000}],
            "options": [{"group": "Size", "name": "Large", "price_delta": 1500}],
        }],
    }
    receipt = _format_order(order)
    assert "+ Bacon  20.00 GBP" in receipt
    assert "+ Large  15.00 GBP" in receipt
    assert "TOTAL: 155.00 GBP" in receipt


def test_format_order_stays_quiet_about_money_when_unpriced():
    order = {
        "order_number": "0008",
        "customer_name": "Ivy",
        "items": [{"name": "Burger", "quantity": 2, "ingredients": [], "options": []}],
    }
    receipt = _format_order(order)
    assert "2x Burger" in receipt
    assert "TOTAL" not in receipt


# ── _format_receipt ───────────────────────────────────────────────────────────
# Mirrors print-service's format_receipt over the same payload: whichever
# printer backend a kitchen runs, the bill has to say the same thing.

RECEIPT = {
    "kind": "receipt",
    "bill_id": "bill-1",
    "table_label": "Table 4",
    "payment_method": "cash",
    "total": 16000,
    "currency": "THB",
    "orders": [
        {"order_number": "BO-001", "items": [
            {"name": "Burger", "quantity": 1, "unit_price": 12000,
             "ingredients": [{"name": "Onion", "included": False}], "options": []},
        ]},
        {"order_number": "BO-002", "items": [
            {"name": "Fries", "quantity": 1, "unit_price": 4000},
        ]},
    ],
}


def test_receipt_covers_every_order_settled_together():
    text = _format_receipt(RECEIPT)
    assert "RECEIPT" in text
    assert "BO-001" in text and "BO-002" in text
    assert "1x Burger" in text and "1x Fries" in text


def test_receipt_shows_the_table_the_total_and_the_method():
    text = _format_receipt(RECEIPT)
    assert "TABLE: Table 4" in text
    assert "TOTAL: 160.00 THB" in text
    assert "Paid by: Cash" in text


def test_receipt_keeps_what_was_left_off_the_dish():
    assert "NO:   Onion" in _format_receipt(RECEIPT)


def test_receipt_follows_the_kitchens_language():
    text = _format_receipt({**RECEIPT, "ticket_language": "th"})
    assert "ใบเสร็จ" in text
    assert "ชำระโดย: เงินสด" in text


def test_receipt_omits_the_total_for_an_unpriced_menu():
    assert "TOTAL" not in _format_receipt({**RECEIPT, "total": None})


def test_receipt_prints_an_unknown_method_rather_than_dropping_it():
    assert "Paid by: promptpay" in _format_receipt({**RECEIPT, "payment_method": "promptpay"})


def test_run_prints_a_receipt_message_as_a_bill():
    """Receipts arrive on the same stream as tickets, told apart by `kind`."""
    import json

    def fake_get(*args, **kwargs):
        if getattr(fake_get, "called", False):
            raise KeyboardInterrupt
        fake_get.called = True
        resp = MagicMock()
        resp.status_code = 200
        resp.raise_for_status = MagicMock()
        return resp

    with patch("byteorder_printer.print_client.requests.get", side_effect=fake_get), \
         patch("byteorder_printer.print_client.SSEClient") as mock_sse_cls, \
         patch("byteorder_printer.print_client._send_to_printer") as send, \
         patch("byteorder_printer.print_client.time"):

        mock_sse_cls.return_value.events.return_value = iter(
            [MagicMock(data=json.dumps(RECEIPT))]
        )
        try:
            run("http://test", "AA:BB:CC:DD:EE:FF")
        except KeyboardInterrupt:
            pass

    assert "RECEIPT" in send.call_args.args[0]


def test_a_takeaway_receipt_names_the_customer_since_there_is_no_table():
    text = _format_receipt({**RECEIPT, "table_label": None, "customer_name": "Somchai"})

    assert "Customer: Somchai" in text
    assert "TABLE" not in text
