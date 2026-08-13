"""Closing a bill at the till.

The QR sticker on a table never changes, so nothing about a new customer sitting
down tells the system that the last party has gone. The cashier confirming
payment is what separates one party from the next — until that happens, the
orders on the table are the current party's, and afterwards they are history.
"""
from datetime import timedelta

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


def _settle(client, table, orders):
    return client.post(
        f"/orders/tables/{table['id']}/settle",
        json={"order_ids": [o["id"] for o in orders]},
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

    _settle(client, table, first_party)

    assert client.get(f"/orders/by-table/{table['code']}").json() == []


def test_a_new_order_after_payment_starts_a_clean_list(client):
    table = _make_table(client, "Table 1")
    _settle(client, table, [_place(client, table)])

    second_party = _place(client, table, customer_name="Bob")

    listed = client.get(f"/orders/by-table/{table['code']}").json()
    assert [o["id"] for o in listed] == [second_party["id"]]


def test_paying_is_per_table(client):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 2}).json()
    theirs = client.post("/orders/", json=_order(table_code=tables[1]["code"])).json()
    _settle(client, tables[0], [client.post("/orders/", json=_order(table_code=tables[0]["code"])).json()])

    assert [o["id"] for o in client.get(f"/orders/by-table/{tables[1]['code']}").json()] == [theirs["id"]]


# ── Paying does not cancel the cooking ───────────────────────────────────────

def test_food_still_being_cooked_stays_in_the_kitchen_queue(client):
    """Paying at the counter before the last dish arrives is normal."""
    table = _make_table(client, "Table 1")
    order = _place(client, table)

    _settle(client, table, [order])

    queued = client.get("/orders/queue").json()
    assert [o["id"] for o in queued] == [order["id"]]
    assert queued[0]["status"] == "pending"


def test_settling_leaves_the_order_in_history(client):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    client.put(f"/orders/{order['id']}/status", json={"status": "completed"})

    _settle(client, table, [order])

    assert [o["id"] for o in client.get("/orders/history").json()] == [order["id"]]


# ── The race that would lose money ───────────────────────────────────────────

def test_an_order_placed_mid_checkout_is_not_marked_paid(client):
    """The cashier collected for what was on screen, and only for that."""
    table = _make_table(client, "Table 1")
    on_screen = _place(client, table)
    slipped_in = _place(client, table, customer_name="Bob")

    body = _settle(client, table, [on_screen]).json()

    assert [o["id"] for o in body["settled"]] == [on_screen["id"]]
    assert [o["id"] for o in body["outstanding"]] == [slipped_in["id"]]
    # And the customer still sees the dish they have not paid for.
    assert [o["id"] for o in client.get(f"/orders/by-table/{table['code']}").json()] == [slipped_in["id"]]


def test_nothing_outstanding_when_the_whole_table_is_paid(client):
    table = _make_table(client, "Table 1")
    assert _settle(client, table, [_place(client, table)]).json()["outstanding"] == []


def test_paying_twice_is_rejected_rather_than_charged_twice(client):
    table = _make_table(client, "Table 1")
    order = _place(client, table)
    _settle(client, table, [order])

    response = _settle(client, table, [order])
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "already_settled"


def test_orders_settled_together_share_one_bill_id(client):
    table = _make_table(client, "Table 1")
    body = _settle(client, table, [_place(client, table), _place(client, table)]).json()

    assert len({o["bill_id"] for o in body["settled"]}) == 1
    assert body["settled"][0]["bill_id"] == body["bill_id"]


def test_settling_no_orders_is_rejected(client):
    table = _make_table(client, "Table 1")
    assert client.post(f"/orders/tables/{table['id']}/settle", json={"order_ids": []}).status_code == 400


def test_another_tables_order_cannot_be_settled_from_this_one(client):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 2}).json()
    theirs = client.post("/orders/", json=_order(table_code=tables[1]["code"])).json()

    response = client.post(f"/orders/tables/{tables[0]['id']}/settle", json={"order_ids": [theirs["id"]]})

    assert response.status_code == 409
    assert client.get(f"/orders/by-table/{tables[1]['code']}").json() != []


def test_another_kitchens_table_cannot_be_settled(client, db):
    other = models.Table(kitchen_id="other-kitchen", code="theircode9", label="Theirs")
    db.add(other)
    db.commit()

    assert client.post(f"/orders/tables/{other.id}/settle", json={"order_ids": [1]}).status_code == 404


def test_the_customers_phone_is_told_to_reload(client, mock_redis):
    table = _make_table(client, "Table 1")
    _settle(client, table, [_place(client, table)])

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

    open_tables = client.get("/orders/tables/open").json()
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
    _settle(client, table, [_place(client, table)])

    assert client.get("/orders/tables/open").json() == []


def test_an_open_table_carries_what_the_cashier_needs(client, priced_menu):
    table = _make_table(client, "Table 1")
    first = _place(client, table)
    _place(client, table, customer_name="Bob")
    client.put(f"/orders/{first['id']}/status", json={"status": "completed"})

    open_table = client.get("/orders/tables/open").json()[0]

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

    assert client.get("/orders/tables/open").json()[0]["total"] is None


def test_takeaway_orders_never_appear_at_a_table(client):
    client.post("/orders/", json=_order())   # no table_code

    assert client.get("/orders/tables/open").json() == []


def test_the_longest_waiting_table_comes_first(client, db):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 2}).json()
    newer = client.post("/orders/", json=_order(table_code=tables[0]["code"])).json()
    client.post("/orders/", json=_order(table_code=tables[1]["code"]))
    _age(db, newer["id"], hours=-1)   # placed an hour from now, so it sorts last

    assert [t["table_id"] for t in client.get("/orders/tables/open").json()] == [tables[1]["id"], tables[0]["id"]]


def test_a_deactivated_table_still_shows_its_unpaid_bill(client):
    """Taking a table out of service must not hide money that is owed."""
    table = _make_table(client, "Table 1")
    _place(client, table)
    client.delete(f"/orders/tables/{table['id']}")

    open_tables = client.get("/orders/tables/open").json()
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

    assert client.get("/orders/tables/open").json() == []
