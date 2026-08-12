from datetime import datetime, timedelta, timezone

from app.timeutil import utcnow


def test_utcnow_is_naive():
    """Must stay naive to match the timezone-naive DateTime columns.

    Returning an aware datetime would put a timestamptz parameter into queries
    that compare against `timestamp` columns, and would raise on any Python-side
    comparison with a value read back from the database.
    """
    assert utcnow().tzinfo is None


def test_utcnow_is_actually_utc():
    assert abs(utcnow() - datetime.now(timezone.utc).replace(tzinfo=None)) < timedelta(seconds=5)


def test_stored_timestamps_are_comparable_to_utcnow(client):
    """The queue ordering relies on comparing stored timestamps with each other."""
    client.post("/orders/", json={
        "customer_name": "Alice",
        "items": [{"menu_item_id": 1, "menu_item_name": "Burger", "ingredients": [], "options": []}],
    })
    created_at = datetime.fromisoformat(client.get("/orders/queue").json()[0]["created_at"])

    assert created_at.tzinfo is None
    assert created_at <= utcnow() + timedelta(seconds=5)
