"""Order-number allocation and per-kitchen channel scoping."""
import json
from unittest.mock import patch

from app import models
from app.routers import orders as orders_router


MINIMAL_ORDER = {
    "customer_name": "Alice",
    "items": [
        {"menu_item_id": 1, "menu_item_name": "Cheeseburger", "ingredients": [], "options": []}
    ],
}


# ── Per-kitchen numbering ─────────────────────────────────────────────────────

def test_numbers_increment_within_a_kitchen(client):
    numbers = [client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"] for _ in range(3)]
    assert [n.split("-")[-1] for n in numbers] == ["001", "002", "003"]


def test_another_kitchens_orders_do_not_advance_our_numbering(client, db):
    """Two kitchens sharing the database must not share a number space."""
    first = client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"]
    prefix = first.rsplit("-", 1)[0]

    # Three orders belonging to a different kitchen, same day.
    for seq in range(2, 5):
        db.add(models.Order(
            kitchen_id="other-kitchen",
            order_number=f"{prefix}-{seq:03d}",
            customer_name="Theirs",
            public_id=f"other-{seq}",
        ))
    db.commit()

    nxt = client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"]
    assert nxt == f"{prefix}-002"


def test_two_kitchens_can_hold_the_same_order_number(client, db):
    ours = client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"]

    # The same number under a different kitchen must not violate the constraint.
    db.add(models.Order(
        kitchen_id="other-kitchen",
        order_number=ours,
        customer_name="Theirs",
        public_id="other-1",
    ))
    db.commit()

    assert db.query(models.Order).filter(models.Order.order_number == ours).count() == 2


# ── Concurrent allocation ─────────────────────────────────────────────────────

def test_collision_is_retried_and_the_order_still_lands(client):
    """Simulates a second phone winning the race between our SELECT and INSERT."""
    taken = client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"]
    real = orders_router._next_order_number

    calls = {"n": 0}

    def collide_once(db, kitchen_id):
        calls["n"] += 1
        return taken if calls["n"] == 1 else real(db, kitchen_id)

    with patch.object(orders_router, "_next_order_number", side_effect=collide_once):
        response = client.post("/orders/", json=MINIMAL_ORDER)

    assert response.status_code == 201
    assert response.json()["order_number"] != taken
    assert calls["n"] == 2  # collided once, then succeeded


def test_persistent_collision_returns_503_not_500(client):
    """If a number can never be allocated, fail with a retryable status."""
    taken = client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"]

    with patch.object(orders_router, "_next_order_number", return_value=taken):
        response = client.post("/orders/", json=MINIMAL_ORDER)

    assert response.status_code == 503


def test_retry_does_not_leave_a_partial_order_behind(client, db):
    taken = client.post("/orders/", json=MINIMAL_ORDER).json()["order_number"]

    with patch.object(orders_router, "_next_order_number", return_value=taken):
        client.post("/orders/", json=MINIMAL_ORDER)

    # Only the original order and its single item survived.
    assert db.query(models.Order).count() == 1
    assert db.query(models.OrderItem).count() == 1


# ── Queue channel scoping ─────────────────────────────────────────────────────

def test_new_order_publishes_to_the_kitchens_queue_channel(client, mock_redis):
    client.post("/orders/", json=MINIMAL_ORDER)

    channels = [call.args[0] for call in mock_redis.publish.call_args_list]
    assert "queue_updates:test-kitchen" in channels
    assert "queue_updates" not in channels


def test_status_change_publishes_to_the_kitchens_queue_channel(client, mock_redis):
    order_id = client.post("/orders/", json=MINIMAL_ORDER).json()["id"]
    mock_redis.publish.reset_mock()

    client.put(f"/orders/{order_id}/status", json={"status": "in_progress"})

    channels = [call.args[0] for call in mock_redis.publish.call_args_list]
    assert "queue_updates:test-kitchen" in channels
    assert "queue_updates" not in channels


def test_queue_stream_is_bound_to_a_kitchen():
    """The stream used to take no kitchen at all and subscribe to a global channel.

    Asserted on the signature rather than over HTTP: the endpoint is an endless
    SSE generator, so consuming it in a test cannot terminate.
    """
    import inspect

    from app.auth import get_kitchen_id

    dependency = inspect.signature(orders_router.queue_stream).parameters["kitchen_id"].default
    assert dependency.dependency is get_kitchen_id


def test_queue_payload_shape_is_unchanged(client, mock_redis):
    """The kiosk only re-fetches on any event, but keep the contract stable."""
    client.post("/orders/", json=MINIMAL_ORDER)

    payload = next(
        json.loads(call.args[1])
        for call in mock_redis.publish.call_args_list
        if call.args[0] == "queue_updates:test-kitchen"
    )
    assert set(payload) == {"order_id", "status"}
    assert payload["status"] == "pending"
