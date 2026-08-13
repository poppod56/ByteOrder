"""Closing a bill at the till.

The QR sticker on a table never changes, so nothing about a new customer sitting
down tells the system that the last party has gone. The cashier confirming
payment is what separates one party from the next — until that happens, the
orders on the table are the current party's, and afterwards they are history.
"""
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import text

from app import models, pricing
from app.timeutil import utcnow
from tests.conftest import test_engine


def _order(table_code=None, customer_name="Alice", menu_item_id=1):
    payload = {
        "customer_name": customer_name,
        "items": [
            {"menu_item_id": menu_item_id, "menu_item_name": "Cheeseburger", "ingredients": [], "options": []}
        ],
    }
    if table_code is not None:
        payload["table_code"] = table_code
    return payload


def _make_table(client, label):
    return client.post("/orders/tables/", json={"label": label}).json()[0]


def _place(client, table, **kwargs):
    return client.post("/orders/", json=_order(table_code=table["code"], **kwargs)).json()


def _settle(client, orders, method=None):
    """A bill is a set of orders paid for together — a table's, or one takeaway."""
    return client.post(
        "/orders/cashier/settle",
        json={"order_ids": [o["id"] for o in orders], "payment_method": method},
    )


def _age(db, order_id, hours):
    """Backdate an order, for the bills nobody closed."""
    db.query(models.Order).filter(models.Order.id == order_id).update(
        {"created_at": utcnow() - timedelta(hours=hours)}
    )
    db.commit()


@pytest.fixture
def priced_menu():
    """order-service reads menu-service's tables directly; see test_pricing.py."""
    pricing._confirmed_tables.clear()
    with test_engine.begin() as conn:
        # Pricing needs all three tables present before it will price anything.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS menu_items (
                id INTEGER PRIMARY KEY, kitchen_id VARCHAR NOT NULL, name VARCHAR, price INTEGER
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS menu_item_ingredients (
                id INTEGER PRIMARY KEY, menu_item_id INTEGER NOT NULL,
                ingredient_id INTEGER NOT NULL, is_default BOOLEAN, price_delta INTEGER NOT NULL DEFAULT 0
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS options (
                id INTEGER PRIMARY KEY, group_id INTEGER, name VARCHAR, price_delta INTEGER NOT NULL DEFAULT 0
            )
        """))
        conn.execute(text("DELETE FROM menu_items"))
        conn.execute(text("""
            INSERT INTO menu_items (id, kitchen_id, name, price)
            VALUES (1, 'test-kitchen', 'Cheeseburger', 12000), (2, 'test-kitchen', 'Water', NULL)
        """))
    yield
    with test_engine.begin() as conn:
        for name in ("menu_items", "menu_item_ingredients", "options"):
            conn.execute(text(f"DROP TABLE IF EXISTS {name}"))
    pricing._confirmed_tables.clear()


# ── The bug this exists to fix ───────────────────────────────────────────────

def test_the_next_customer_to_scan_sees_nothing_of_the_last_party(client):
    table = _make_table(client, "Table 1")
    first_party = [_place(client, table), _place(client, table)]

    _settle(client, first_party)

    assert client.get(f"/orders/by-table/{table['code']}").json() == []


def test_a_new_order_after_payment_starts_a_clean_list(client):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)])

    second_party = _place(client, table, customer_name="Bob")

    listed = client.get(f"/orders/by-table/{table['code']}").json()
    assert [o["id"] for o in listed] == [second_party["id"]]


def test_paying_is_per_table(client):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 2}).json()
    theirs = client.post("/orders/", json=_order(table_code=tables[1]["code"])).json()
    _settle(client, [client.post("/orders/", json=_order(table_code=tables[0]["code"])).json()])

    assert [o["id"] for o in client.get(f"/orders/by-table/{tables[1]['code']}").json()] == [theirs["id"]]


# ── Paying does not cancel the cooking ───────────────────────────────────────

def test_food_still_being_cooked_stays_in_the_kitchen_queue(client):
    """Paying at the counter before the last dish arrives is normal."""
    table = _make_table(client, "Table 1")
    order = _place(client, table)

    _settle(client, [order])

    queued = client.get("/orders/queue").json()
    assert [o["id"] for o in queued] == [order["id"]]
    assert queued[0]["status"] == "pending"


def test_settling_leaves_the_order_in_history(client):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    client.put(f"/orders/{order['id']}/status", json={"status": "completed"})

    _settle(client, [order])

    assert [o["id"] for o in client.get("/orders/history").json()] == [order["id"]]


# ── The race that would lose money ───────────────────────────────────────────

def test_an_order_placed_mid_checkout_is_not_marked_paid(client):
    """The cashier collected for what was on screen, and only for that."""
    table = _make_table(client, "Table 1")
    on_screen = _place(client, table)
    slipped_in = _place(client, table, customer_name="Bob")

    body = _settle(client, [on_screen]).json()

    assert [o["id"] for o in body["settled"]] == [on_screen["id"]]
    assert [o["id"] for o in body["outstanding"]] == [slipped_in["id"]]
    # And the customer still sees the dish they have not paid for.
    assert [o["id"] for o in client.get(f"/orders/by-table/{table['code']}").json()] == [slipped_in["id"]]


def test_nothing_outstanding_when_the_whole_table_is_paid(client):
    table = _make_table(client, "Table 1")
    assert _settle(client, [_place(client, table)]).json()["outstanding"] == []


def test_paying_twice_is_rejected_rather_than_charged_twice(client):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    _settle(client, [order])

    response = _settle(client, [order])
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "already_settled"


def test_orders_settled_together_share_one_bill_id(client):
    table = _make_table(client, "Table 1")
    body = _settle(client, [_place(client, table), _place(client, table)]).json()

    assert len({o["bill_id"] for o in body["settled"]}) == 1
    assert body["settled"][0]["bill_id"] == body["bill_id"]


def test_settling_no_orders_is_rejected(client):
    table = _make_table(client, "Table 1")
    assert client.post("/orders/cashier/settle", json={"order_ids": []}).status_code == 400


def test_one_payment_cannot_close_two_tables(client):
    """The other table would look paid to whoever sits down at it next."""
    tables = client.post("/orders/tables/", json={"label": "T", "count": 2}).json()
    first = client.post("/orders/", json=_order(table_code=tables[0]["code"])).json()
    second = client.post("/orders/", json=_order(table_code=tables[1]["code"])).json()

    response = _settle(client, [first, second])

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "mixed_bill"
    assert client.get(f"/orders/by-table/{tables[0]['code']}").json() != []
    assert client.get(f"/orders/by-table/{tables[1]['code']}").json() != []


def test_another_kitchens_order_cannot_be_settled(client, db):
    theirs = models.Order(
        kitchen_id="other-kitchen", order_number="BO-T1", customer_name="Theirs",
    )
    db.add(theirs)
    db.commit()

    response = client.post("/orders/cashier/settle", json={"order_ids": [theirs.id]})

    assert response.status_code == 409
    db.refresh(theirs)
    assert theirs.settled_at is None


def test_the_customers_phone_is_told_to_reload(client, mock_redis):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)])

    channels = [call.args[0] for call in mock_redis.publish.call_args_list]
    assert "queue_updates:test-kitchen" in channels


# ── The bill nobody closed ───────────────────────────────────────────────────

def test_a_forgotten_bill_stops_following_the_table_around(client, db):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    client.put(f"/orders/{order['id']}/status", json={"status": "completed"})
    _age(db, order["id"], hours=9)

    assert client.get(f"/orders/by-table/{table['code']}").json() == []


def test_a_forgotten_bill_still_owes_money_at_the_till(client, db):
    """Hidden from the customer, never from the cashier — it was never collected."""
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    client.put(f"/orders/{order['id']}/status", json={"status": "completed"})
    _age(db, order["id"], hours=9)

    open_tables = client.get("/orders/cashier/open").json()
    assert [t["table_id"] for t in open_tables] == [table["id"]]
    assert open_tables[0]["stale"] is True


def test_a_long_meal_is_not_mistaken_for_a_forgotten_bill(client, db):
    """An order the kitchen has not finished belongs to whoever is sitting there."""
    table = _make_table(client, "Table 1")
    old = _place(client, table)
    client.put(f"/orders/{old['id']}/status", json={"status": "completed"})
    _age(db, old["id"], hours=9)
    still_cooking = _place(client, table)
    _age(db, still_cooking["id"], hours=8)

    listed = client.get(f"/orders/by-table/{table['code']}").json()
    assert {o["id"] for o in listed} == {old["id"], still_cooking["id"]}


def test_a_bill_from_before_midnight_is_still_the_same_party(client, db):
    """The old calendar-day filter split one late-night table into two."""
    table = _make_table(client, "Table 1")
    earlier = _place(client, table)
    _age(db, earlier["id"], hours=3)
    later = _place(client, table)

    assert {o["id"] for o in client.get(f"/orders/by-table/{table['code']}").json()} == {earlier["id"], later["id"]}


# ── The cashier's list of open tables ────────────────────────────────────────

def test_open_tables_are_empty_when_everyone_has_paid(client):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)])

    assert client.get("/orders/cashier/open").json() == []


def test_an_open_table_carries_what_the_cashier_needs(client, priced_menu):
    table = _make_table(client, "Table 1")
    first = _place(client, table)
    _place(client, table, customer_name="Bob")
    client.put(f"/orders/{first['id']}/status", json={"status": "completed"})

    open_table = client.get("/orders/cashier/open").json()[0]

    assert open_table["label"] == "Table 1"
    assert open_table["code"] == table["code"]
    assert open_table["order_count"] == 2
    assert open_table["total"] == 24000
    assert open_table["unserved_count"] == 1
    assert open_table["stale"] is False
    assert len(open_table["orders"][0]["items"]) == 1


def test_an_unpriced_menu_shows_no_total_rather_than_zero(client):
    table = _make_table(client, "Table 1")
    _place(client, table)

    assert client.get("/orders/cashier/open").json()[0]["total"] is None


def test_takeaway_is_never_attached_to_a_table(client):
    """It reaches the till as its own bill, not as somebody's table."""
    client.post("/orders/", json=_order())   # no table_code

    bills = client.get("/orders/cashier/open").json()
    assert [b["kind"] for b in bills] == ["takeaway"]
    assert bills[0]["table_id"] is None and bills[0]["code"] is None


def test_the_longest_waiting_table_comes_first(client, db):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 2}).json()
    newer = client.post("/orders/", json=_order(table_code=tables[0]["code"])).json()
    client.post("/orders/", json=_order(table_code=tables[1]["code"]))
    _age(db, newer["id"], hours=-1)   # placed an hour from now, so it sorts last

    assert [t["table_id"] for t in client.get("/orders/cashier/open").json()] == [tables[1]["id"], tables[0]["id"]]


def test_a_deactivated_table_still_shows_its_unpaid_bill(client):
    """Taking a table out of service must not hide money that is owed."""
    table = _make_table(client, "Table 1")
    _place(client, table)
    client.delete(f"/orders/tables/{table['id']}")

    open_tables = client.get("/orders/cashier/open").json()
    assert [t["table_id"] for t in open_tables] == [table["id"]]
    assert open_tables[0]["active"] is False


def test_another_kitchens_open_tables_are_not_listed(client, db):
    other = models.Table(kitchen_id="other-kitchen", code="theircode8", label="Theirs")
    db.add(other)
    db.commit()
    db.add(models.Order(
        kitchen_id="other-kitchen", order_number="BO-1", customer_name="Theirs",
        table_id=other.id, table_label="Theirs",
    ))
    db.commit()

    assert client.get("/orders/cashier/open").json() == []


# ── How the money came in ────────────────────────────────────────────────────

def test_the_method_is_recorded_on_every_order_in_the_bill(client):
    table = _make_table(client, "Table 1")
    orders = [_place(client, table), _place(client, table)]

    body = client.post(
        "/orders/cashier/settle",
        json={"order_ids": [o["id"] for o in orders], "payment_method": "transfer"},
    ).json()

    assert body["payment_method"] == "transfer"
    assert {o["payment_method"] for o in body["settled"]} == {"transfer"}


def test_a_kitchen_that_only_takes_cash_need_not_answer(client):
    table = _make_table(client, "Table 1")
    body = _settle(client, [_place(client, table)]).json()

    assert body["payment_method"] is None


def test_an_invented_method_is_rejected(client):
    """The till is counted by method, so free text would fragment the columns."""
    table = _make_table(client, "Table 1")
    order = _place(client, table)

    response = client.post(
        "/orders/cashier/settle",
        json={"order_ids": [order["id"]], "payment_method": "bitcoin"},
    )

    assert response.status_code == 400
    # And nothing was settled on the way to being rejected.
    assert client.get(f"/orders/by-table/{table['code']}").json() != []


def test_the_method_is_normalised_so_the_totals_group(client):
    table = _make_table(client, "Table 1")
    body = client.post(
        "/orders/cashier/settle",
        json={"order_ids": [_place(client, table)["id"]], "payment_method": " Cash "},
    ).json()

    assert body["payment_method"] == "cash"


# ── The receipt that prints at the till ──────────────────────────────────────

def _receipts(mock_redis):
    """Payloads published to the ticket channel that are bills, not orders."""
    out = []
    for call in mock_redis.publish.call_args_list:
        channel, raw = call.args
        if channel.startswith("new_orders"):
            payload = json.loads(raw)
            if payload.get("kind") == "receipt":
                out.append((channel, payload))
    return out


def test_settling_publishes_one_receipt_to_both_printer_backends(client, mock_redis):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table), _place(client, table)])

    channels = [c for c, _ in _receipts(mock_redis)]
    assert sorted(channels) == ["new_orders", "new_orders:test-kitchen"]


def test_the_receipt_carries_the_whole_bill(client, mock_redis, priced_menu):
    table = _make_table(client, "Table 1")
    first, second = _place(client, table), _place(client, table)

    body = _settle(client, [first, second]).json()
    _, receipt = _receipts(mock_redis)[0]

    assert receipt["bill_id"] == body["bill_id"]
    assert receipt["table_label"] == "Table 1"
    assert receipt["total"] == 24000
    assert [o["order_number"] for o in receipt["orders"]] == [first["order_number"], second["order_number"]]
    assert receipt["orders"][0]["items"][0]["name"] == "Cheeseburger"


def test_the_receipt_says_how_it_was_paid(client, mock_redis):
    table = _make_table(client, "Table 1")
    client.post(
        "/orders/cashier/settle",
        json={"order_ids": [_place(client, table)["id"]], "payment_method": "card"},
    )

    assert _receipts(mock_redis)[0][1]["payment_method"] == "card"


def test_the_receipt_has_no_total_when_the_menu_is_unpriced(client, mock_redis):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)])

    assert _receipts(mock_redis)[0][1]["total"] is None


def test_a_kitchen_ticket_is_marked_as_one(client, mock_redis):
    """Both formatters read `kind`; a ticket must not be mistaken for a bill."""
    table = _make_table(client, "Table 1")
    _place(client, table)

    tickets = [json.loads(c.args[1]) for c in mock_redis.publish.call_args_list
               if c.args[0] == "new_orders"]
    assert [t["kind"] for t in tickets] == ["order"]


# ── The end-of-day count ─────────────────────────────────────────────────────

def test_takings_split_by_how_each_bill_was_paid(client, priced_menu):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 3}).json()
    _settle(client, [_place(client, tables[0])], "cash")
    _settle(client, [_place(client, tables[1]), _place(client, tables[1])], "cash")
    _settle(client, [_place(client, tables[2])], "card")

    takings = client.get("/orders/takings").json()

    assert takings["bill_count"] == 3
    assert takings["order_count"] == 4
    assert takings["total"] == 48000
    assert [(r["method"], r["bill_count"], r["total"]) for r in takings["by_method"]] == [
        ("cash", 2, 36000),
        ("card", 1, 12000),
    ]


def test_takings_keep_unrecorded_methods_in_their_own_column(client, priced_menu):
    """Folding them into cash would invent money in a column that must balance."""
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)])

    rows = client.get("/orders/takings").json()["by_method"]
    assert [(r["method"], r["total"]) for r in rows] == [(None, 12000)]


def test_takings_count_the_day_the_money_arrived(client, db, priced_menu):
    """A table that ordered before midnight and paid after belongs to the day it
    paid for — that is the drawer that has to balance."""
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    _age(db, order["id"], hours=30)
    _settle(client, [order], "cash")

    assert client.get("/orders/takings").json()["total"] == 12000


def test_takings_exclude_another_days_bills(client, db, priced_menu):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    _settle(client, [order], "cash")
    db.query(models.Order).filter(models.Order.id == order["id"]).update(
        {"settled_at": utcnow() - timedelta(days=2)}
    )
    db.commit()

    takings = client.get("/orders/takings").json()
    assert takings["bill_count"] == 0
    assert takings["total"] is None


def test_takings_can_be_asked_for_an_earlier_day(client, db, priced_menu):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    _settle(client, [order], "cash")
    yesterday = utcnow() - timedelta(days=1)
    db.query(models.Order).filter(models.Order.id == order["id"]).update({"settled_at": yesterday})
    db.commit()

    takings = client.get("/orders/takings", params={"date": yesterday.date().isoformat()}).json()
    assert takings["date"] == yesterday.date().isoformat()
    assert takings["total"] == 12000


def test_takings_follow_the_tills_own_midnight(client, db, priced_menu):
    """Counted in UTC, a Bangkok kitchen's day would break at 07:00 and file one
    evening's takings under two dates."""
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    _settle(client, [order], "cash")
    # 20:30 Bangkok on the 2nd is 13:30 UTC on the 2nd — same date either way.
    # 00:30 Bangkok on the 3rd is 17:30 UTC on the 2nd, and belongs to the 3rd.
    db.query(models.Order).filter(models.Order.id == order["id"]).update(
        {"settled_at": datetime(2026, 8, 2, 17, 30)}
    )
    db.commit()

    bangkok = {"tz_offset": 420}
    assert client.get("/orders/takings", params={"date": "2026-08-03", **bangkok}).json()["total"] == 12000
    assert client.get("/orders/takings", params={"date": "2026-08-02", **bangkok}).json()["total"] is None
    # And read in UTC it lands on the 2nd, which is exactly the mistake.
    assert client.get("/orders/takings", params={"date": "2026-08-02"}).json()["total"] == 12000


def test_takings_show_what_has_not_been_collected_yet(client, priced_menu):
    table = _make_table(client, "Table 1")
    _place(client, table)
    paid = _make_table(client, "Table 2")
    _settle(client, [_place(client, paid)], "cash")

    takings = client.get("/orders/takings").json()
    assert takings["unpaid_order_count"] == 1
    assert takings["unpaid_total"] == 12000
    assert takings["total"] == 12000


def test_takings_report_nothing_rather_than_zero_for_an_unpriced_menu(client):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)], "cash")

    takings = client.get("/orders/takings").json()
    assert takings["bill_count"] == 1
    assert takings["total"] is None


def test_another_kitchens_takings_are_not_counted(client, db, priced_menu):
    table = _make_table(client, "Table 1")
    _settle(client, [_place(client, table)], "cash")
    db.add(models.Order(
        kitchen_id="other-kitchen", order_number="BO-X", customer_name="Theirs",
        table_id=999, table_label="Theirs", total=99900,
        settled_at=utcnow(), bill_id="their-bill", payment_method="cash",
    ))
    db.commit()

    assert client.get("/orders/takings").json()["total"] == 12000


def test_a_nonsense_date_or_offset_is_rejected(client):
    assert client.get("/orders/takings", params={"date": "yesterday"}).status_code == 400
    assert client.get("/orders/takings", params={"tz_offset": 5000}).status_code == 400


# ── Takeaway ─────────────────────────────────────────────────────────────────
# A bill of one. Before the cashier existed there was no way to settle it at
# all, so takeaway money reached no till and no report.

def test_takeaway_appears_at_the_till_as_its_own_bill(client, priced_menu):
    client.post("/orders/", json=_order(customer_name="Alice"))

    bills = client.get("/orders/cashier/open").json()

    assert [b["kind"] for b in bills] == ["takeaway"]
    assert bills[0]["label"] == "Alice"
    assert bills[0]["order_count"] == 1
    assert bills[0]["total"] == 12000
    assert bills[0]["table_id"] is None


def test_two_takeaway_customers_are_never_put_on_one_bill(client):
    """They are strangers — one receipt would charge one for the other's food."""
    client.post("/orders/", json=_order(customer_name="Alice"))
    client.post("/orders/", json=_order(customer_name="Bob"))

    bills = client.get("/orders/cashier/open").json()

    assert sorted(b["label"] for b in bills) == ["Alice", "Bob"]
    assert all(b["order_count"] == 1 for b in bills)


def test_taking_payment_for_takeaway_clears_it_from_the_till(client):
    order = client.post("/orders/", json=_order(customer_name="Alice")).json()

    _settle(client, [order], "cash")

    assert client.get("/orders/cashier/open").json() == []


def test_takeaway_money_reaches_the_end_of_day_count(client, priced_menu):
    """The gap this closes: a kitchen selling over the counter was quietly short."""
    order = client.post("/orders/", json=_order(customer_name="Alice")).json()
    _settle(client, [order], "cash")

    takings = client.get("/orders/takings").json()

    assert takings["total"] == 12000
    assert [(r["method"], r["total"]) for r in takings["by_method"]] == [("cash", 12000)]


def test_uncollected_takeaway_is_reported_alongside_the_takings(client, priced_menu):
    client.post("/orders/", json=_order(customer_name="Alice"))

    takings = client.get("/orders/takings").json()

    assert takings["unpaid_order_count"] == 1
    assert takings["unpaid_total"] == 12000


def test_a_takeaway_bill_never_reports_outstanding_orders(client):
    """Anything ordered after it is a different customer, not the same tab."""
    order = client.post("/orders/", json=_order(customer_name="Alice")).json()
    client.post("/orders/", json=_order(customer_name="Bob"))

    assert _settle(client, [order], "cash").json()["outstanding"] == []


def test_a_takeaway_receipt_is_identified_by_the_customer(client, mock_redis):
    order = client.post("/orders/", json=_order(customer_name="Alice")).json()

    _settle(client, [order], "cash")

    _, receipt = _receipts(mock_redis)[0]
    assert receipt["customer_name"] == "Alice"
    assert receipt["table_label"] is None


def test_tables_and_takeaway_share_one_queue_at_the_till(client):
    table = _make_table(client, "Table 1")
    _place(client, table)
    client.post("/orders/", json=_order(customer_name="Alice"))

    kinds = [b["kind"] for b in client.get("/orders/cashier/open").json()]

    assert sorted(kinds) == ["table", "takeaway"]
