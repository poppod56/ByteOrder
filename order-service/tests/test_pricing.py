"""Totals are computed from the menu tables, never from the request.

The customer app is public and unauthenticated, so a price it sent could be
edited to anything. These tests create the menu-service tables in the test
database — order-service reads them directly, the same way print-service reads
`settings`.
"""
import json

import pytest
from sqlalchemy import text

from app import models, pricing
from tests.conftest import test_engine


@pytest.fixture(autouse=True)
def forget_table_probe():
    """pricing caches that the menu tables exist, which is sound in production but
    not across a fixture that drops them again."""
    pricing._confirmed_tables.clear()
    yield
    pricing._confirmed_tables.clear()


MENU_SCHEMA = """
CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY,
    kitchen_id VARCHAR NOT NULL,
    name VARCHAR,
    price INTEGER
);
CREATE TABLE IF NOT EXISTS menu_item_ingredients (
    id INTEGER PRIMARY KEY,
    menu_item_id INTEGER NOT NULL,
    ingredient_id INTEGER NOT NULL,
    is_default BOOLEAN,
    price_delta INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS options (
    id INTEGER PRIMARY KEY,
    group_id INTEGER,
    name VARCHAR,
    price_delta INTEGER NOT NULL DEFAULT 0
);
"""


@pytest.fixture
def menu():
    """A priced menu: burger 120.00, bacon +20.00, Large +15.00, Regular +0."""
    with test_engine.begin() as conn:
        for statement in filter(None, (s.strip() for s in MENU_SCHEMA.split(";"))):
            conn.execute(text(statement))
        conn.execute(text("DELETE FROM menu_items"))
        conn.execute(text("DELETE FROM menu_item_ingredients"))
        conn.execute(text("DELETE FROM options"))
        conn.execute(text("""
            INSERT INTO menu_items (id, kitchen_id, name, price) VALUES
                (1, 'test-kitchen', 'Burger', 12000),
                (2, 'test-kitchen', 'Fries', 4000),
                (3, 'test-kitchen', 'Water', NULL),
                (9, 'other-kitchen', 'Theirs', 99900)
        """))
        conn.execute(text("""
            INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, is_default, price_delta) VALUES
                (1, 10, 1, 0),
                (1, 11, 0, 2000)
        """))
        conn.execute(text("""
            INSERT INTO options (id, group_id, name, price_delta) VALUES
                (100, 1, 'Regular', 0),
                (101, 1, 'Large', 1500)
        """))
    yield
    with test_engine.begin() as conn:
        for t in ("menu_items", "menu_item_ingredients", "options"):
            conn.execute(text(f"DROP TABLE IF EXISTS {t}"))


def _order(items, customer_name="Alice"):
    return {"customer_name": customer_name, "items": items}


def _burger(ingredients=None, options=None):
    return {
        "menu_item_id": 1,
        "menu_item_name": "Burger",
        "ingredients": ingredients or [],
        "options": options or [],
    }


BACON_ON = {"ingredient_id": 11, "ingredient_name": "Bacon", "included": True}
BACON_OFF = {"ingredient_id": 11, "ingredient_name": "Bacon", "included": False}
LARGE = {"option_id": 101, "option_name": "Large", "group_name": "Size"}


def test_plain_item_totals_its_own_price(client, menu):
    data = client.post("/orders/", json=_order([_burger()])).json()
    assert data["items"][0]["unit_price"] == 12000
    assert data["total"] == 12000


def test_several_lines_add_up(client, menu):
    data = client.post("/orders/", json=_order([
        _burger(),
        {"menu_item_id": 2, "menu_item_name": "Fries", "ingredients": [], "options": []},
    ])).json()
    assert data["total"] == 16000


def test_a_topping_that_is_on_is_charged(client, menu):
    data = client.post("/orders/", json=_order([_burger(ingredients=[BACON_ON])])).json()
    assert data["items"][0]["ingredients"][0]["price_delta"] == 2000
    assert data["total"] == 14000


def test_a_topping_that_is_off_is_not_charged(client, menu):
    data = client.post("/orders/", json=_order([_burger(ingredients=[BACON_OFF])])).json()
    assert data["items"][0]["ingredients"][0]["price_delta"] == 0
    assert data["total"] == 12000


def test_options_are_charged(client, menu):
    data = client.post("/orders/", json=_order([_burger(options=[LARGE])])).json()
    assert data["items"][0]["options"][0]["price_delta"] == 1500
    assert data["total"] == 13500


def test_toppings_and_options_stack(client, menu):
    data = client.post("/orders/", json=_order([_burger(ingredients=[BACON_ON], options=[LARGE])])).json()
    assert data["total"] == 15500


# ── Prices come from the menu, not the request ────────────────────────────────

def test_a_price_sent_by_the_client_is_ignored(client, menu):
    """Anyone can POST to this endpoint, so nothing about money is taken on trust."""
    payload = _order([{**_burger(), "unit_price": 1, "price": 1}])
    payload["total"] = 1

    data = client.post("/orders/", json=payload).json()

    assert data["items"][0]["unit_price"] == 12000
    assert data["total"] == 12000


def test_a_delta_sent_by_the_client_is_ignored(client, menu):
    payload = _order([_burger(ingredients=[{**BACON_ON, "price_delta": -12000}])])

    data = client.post("/orders/", json=payload).json()

    assert data["items"][0]["ingredients"][0]["price_delta"] == 2000
    assert data["total"] == 14000


def test_another_kitchens_item_is_not_priced(client, menu):
    """Item 9 belongs to another kitchen, so this kitchen gets no price for it."""
    data = client.post("/orders/", json=_order([
        {"menu_item_id": 9, "menu_item_name": "Theirs", "ingredients": [], "options": []}
    ])).json()
    assert data["items"][0]["unit_price"] is None


# ── Menus without prices ─────────────────────────────────────────────────────

def test_an_unpriced_item_carries_no_price(client, menu):
    data = client.post("/orders/", json=_order([
        {"menu_item_id": 3, "menu_item_name": "Water", "ingredients": [], "options": []}
    ])).json()
    assert data["items"][0]["unit_price"] is None
    assert data["total"] is None


def test_a_priced_order_ignores_the_unpriced_line_in_the_total(client, menu):
    data = client.post("/orders/", json=_order([
        _burger(),
        {"menu_item_id": 3, "menu_item_name": "Water", "ingredients": [], "options": []},
    ])).json()
    assert data["total"] == 12000


def test_orders_still_go_through_without_any_menu_tables(client):
    """No `menu` fixture here: the tables do not exist. Taking the order matters
    more than pricing it, so it is recorded with no total rather than refused."""
    response = client.post("/orders/", json=_order([_burger()]))
    assert response.status_code == 201
    assert response.json()["total"] is None


# ── Snapshotting ─────────────────────────────────────────────────────────────

def test_a_later_menu_price_change_does_not_rewrite_the_order(client, menu, db):
    order_id = client.post("/orders/", json=_order([_burger()])).json()["id"]

    with test_engine.begin() as conn:
        conn.execute(text("UPDATE menu_items SET price = 20000 WHERE id = 1"))

    assert client.get(f"/orders/{order_id}").json()["total"] == 12000


def test_the_total_reaches_the_printers(client, menu, mock_redis):
    client.post("/orders/", json=_order([_burger(options=[LARGE])]))

    payload = next(
        json.loads(call.args[1])
        for call in mock_redis.publish.call_args_list
        if call.args[0] == "new_orders"
    )
    assert payload["total"] == 13500
    assert payload["items"][0]["unit_price"] == 12000
    assert payload["items"][0]["options"][0]["price_delta"] == 1500


def test_history_and_queue_expose_the_total(client, menu):
    client.post("/orders/", json=_order([_burger()]))
    assert client.get("/orders/queue").json()[0]["total"] == 12000


# ── Quantity ──────────────────────────────────────────────────────────────────

def test_quantity_multiplies_the_line(client, menu):
    data = client.post("/orders/", json=_order([{**_burger(), "quantity": 3}])).json()
    assert data["items"][0]["quantity"] == 3
    assert data["total"] == 36000


def test_modifier_charges_apply_per_unit(client, menu):
    """Bacon is +20.00 on each burger, not once for the line."""
    data = client.post("/orders/", json=_order([
        {**_burger(ingredients=[BACON_ON], options=[LARGE]), "quantity": 2},
    ])).json()
    assert data["total"] == (12000 + 2000 + 1500) * 2


def test_quantity_defaults_to_one(client, menu):
    data = client.post("/orders/", json=_order([_burger()])).json()
    assert data["items"][0]["quantity"] == 1
    assert data["total"] == 12000


def test_quantity_is_bounded(client, menu):
    for bad in (0, -1, 100, 10_000):
        response = client.post("/orders/", json=_order([{**_burger(), "quantity": bad}]))
        assert response.status_code == 422, bad


def test_quantity_reaches_the_printers(client, menu, mock_redis):
    client.post("/orders/", json=_order([{**_burger(), "quantity": 4}]))

    payload = next(
        json.loads(call.args[1])
        for call in mock_redis.publish.call_args_list
        if call.args[0] == "new_orders"
    )
    assert payload["items"][0]["quantity"] == 4
