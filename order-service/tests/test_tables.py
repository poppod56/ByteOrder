import json


def _order(table_code=None, customer_name="Alice"):
    payload = {
        "customer_name": customer_name,
        "items": [
            {"menu_item_id": 1, "menu_item_name": "Cheeseburger", "ingredients": [], "options": []}
        ],
    }
    if table_code is not None:
        payload["table_code"] = table_code
    return payload


# ── Create ────────────────────────────────────────────────────────────────────

def test_create_single_table_slugifies_code(client):
    response = client.post("/orders/tables/", json={"label": "Table A1"})
    assert response.status_code == 201
    data = response.json()
    assert len(data) == 1
    assert data[0]["label"] == "Table A1"
    assert data[0]["code"] == "table-a1"
    assert data[0]["active"] is True


def test_create_multiple_tables_numbers_them(client):
    response = client.post("/orders/tables/", json={"label": "Table", "count": 4})
    assert response.status_code == 201
    data = response.json()
    assert [t["label"] for t in data] == ["Table 1", "Table 2", "Table 3", "Table 4"]
    assert [t["code"] for t in data] == ["table-1", "table-2", "table-3", "table-4"]


def test_create_non_ascii_label_still_gets_usable_code(client):
    """Thai (or any non-ASCII) labels slugify to nothing — a code must still be issued."""
    response = client.post("/orders/tables/", json={"label": "โต๊ะ"})
    assert response.status_code == 201
    code = response.json()[0]["code"]
    assert code
    assert response.json()[0]["label"] == "โต๊ะ"


def test_duplicate_labels_get_distinct_codes(client):
    first = client.post("/orders/tables/", json={"label": "Patio"}).json()[0]
    second = client.post("/orders/tables/", json={"label": "Patio"}).json()[0]
    assert first["code"] == "patio"
    assert second["code"] == "patio-2"


def test_create_rejects_empty_label(client):
    assert client.post("/orders/tables/", json={"label": "   "}).status_code == 400


def test_create_rejects_out_of_range_count(client):
    assert client.post("/orders/tables/", json={"label": "T", "count": 0}).status_code == 400
    assert client.post("/orders/tables/", json={"label": "T", "count": 500}).status_code == 400


def test_create_rejects_explicit_code_with_multiple_tables(client):
    response = client.post("/orders/tables/", json={"label": "T", "code": "t1", "count": 3})
    assert response.status_code == 400


def test_create_accepts_explicit_code(client):
    response = client.post("/orders/tables/", json={"label": "Window seat", "code": "w1"})
    assert response.status_code == 201
    assert response.json()[0]["code"] == "w1"


def test_create_rejects_malformed_explicit_code(client):
    assert client.post("/orders/tables/", json={"label": "T", "code": "Table 1!"}).status_code == 400


def test_create_rejects_duplicate_explicit_code(client):
    client.post("/orders/tables/", json={"label": "One", "code": "dup"})
    assert client.post("/orders/tables/", json={"label": "Two", "code": "dup"}).status_code == 409


# ── List / update / delete ───────────────────────────────────────────────────

def test_list_hides_inactive_unless_requested(client):
    table = client.post("/orders/tables/", json={"label": "Corner"}).json()[0]
    client.delete(f"/orders/tables/{table['id']}")

    assert client.get("/orders/tables/").json() == []
    inactive = client.get("/orders/tables/?include_inactive=true").json()
    assert len(inactive) == 1
    assert inactive[0]["active"] is False


def test_rename_keeps_code_so_printed_qr_still_works(client):
    table = client.post("/orders/tables/", json={"label": "Old name"}).json()[0]
    response = client.put(f"/orders/tables/{table['id']}", json={"label": "New name"})
    assert response.status_code == 200
    assert response.json()["label"] == "New name"
    assert response.json()["code"] == table["code"]


def test_rename_rejects_empty_label(client):
    table = client.post("/orders/tables/", json={"label": "Keep"}).json()[0]
    assert client.put(f"/orders/tables/{table['id']}", json={"label": " "}).status_code == 400


def test_reactivating_a_table_restores_it(client):
    table = client.post("/orders/tables/", json={"label": "Seasonal"}).json()[0]
    client.delete(f"/orders/tables/{table['id']}")
    client.put(f"/orders/tables/{table['id']}", json={"active": True})
    assert len(client.get("/orders/tables/").json()) == 1


def test_update_and_delete_unknown_table_404(client):
    assert client.put("/orders/tables/999", json={"label": "x"}).status_code == 404
    assert client.delete("/orders/tables/999").status_code == 404


# ── Public lookup by code ────────────────────────────────────────────────────

def test_by_code_returns_label_only(client):
    client.post("/orders/tables/", json={"label": "Table 7", "code": "t7"})
    response = client.get("/orders/tables/by-code/t7")
    assert response.status_code == 200
    assert response.json() == {"code": "t7", "label": "Table 7"}


def test_by_code_is_case_insensitive(client):
    client.post("/orders/tables/", json={"label": "Table 7", "code": "t7"})
    assert client.get("/orders/tables/by-code/T7").status_code == 200


def test_by_code_unknown_returns_404(client):
    assert client.get("/orders/tables/by-code/nope").status_code == 404


def test_by_code_inactive_returns_404(client):
    table = client.post("/orders/tables/", json={"label": "Gone", "code": "gone"}).json()[0]
    client.delete(f"/orders/tables/{table['id']}")
    assert client.get("/orders/tables/by-code/gone").status_code == 404


# ── Orders placed from a table ───────────────────────────────────────────────

def test_order_from_table_records_id_and_label(client):
    table = client.post("/orders/tables/", json={"label": "Table 3", "code": "t3"}).json()[0]
    response = client.post("/orders/", json=_order(table_code="t3"))
    assert response.status_code == 201
    data = response.json()
    assert data["table_id"] == table["id"]
    assert data["table_label"] == "Table 3"


def test_order_without_table_is_takeaway(client):
    response = client.post("/orders/", json=_order())
    assert response.status_code == 201
    assert response.json()["table_id"] is None
    assert response.json()["table_label"] is None


def test_order_with_unknown_table_code_is_rejected(client):
    """A mis-printed QR must fail loudly, not silently become a takeaway order."""
    response = client.post("/orders/", json=_order(table_code="does-not-exist"))
    assert response.status_code == 400


def test_order_with_inactive_table_code_is_rejected(client):
    table = client.post("/orders/tables/", json={"label": "Retired", "code": "old"}).json()[0]
    client.delete(f"/orders/tables/{table['id']}")
    assert client.post("/orders/", json=_order(table_code="old")).status_code == 400


def test_order_from_table_defaults_name_to_table_label(client):
    client.post("/orders/tables/", json={"label": "Table 9", "code": "t9"})
    response = client.post("/orders/", json=_order(table_code="t9", customer_name=""))
    assert response.status_code == 201
    assert response.json()["customer_name"] == "Table 9"


def test_order_from_table_keeps_given_name(client):
    client.post("/orders/tables/", json={"label": "Table 9", "code": "t9"})
    response = client.post("/orders/", json=_order(table_code="t9", customer_name="Bob"))
    assert response.json()["customer_name"] == "Bob"


def test_takeaway_order_still_requires_a_name(client):
    assert client.post("/orders/", json=_order(customer_name="  ")).status_code == 400


def test_renaming_a_table_does_not_rewrite_past_orders(client):
    table = client.post("/orders/tables/", json={"label": "Table 3", "code": "t3"}).json()[0]
    order_id = client.post("/orders/", json=_order(table_code="t3")).json()["id"]

    client.put(f"/orders/tables/{table['id']}", json={"label": "Table 3 (moved)"})

    assert client.get(f"/orders/{order_id}").json()["table_label"] == "Table 3"


def test_queue_exposes_table_label(client):
    client.post("/orders/tables/", json={"label": "Table 5", "code": "t5"})
    client.post("/orders/", json=_order(table_code="t5"))
    assert client.get("/orders/queue").json()[0]["table_label"] == "Table 5"


def test_published_payload_includes_table_label(client, mock_redis):
    """print-service reads table_label off the Redis payload to head the ticket."""
    client.post("/orders/tables/", json={"label": "Table 2", "code": "t2"})
    client.post("/orders/", json=_order(table_code="t2"))

    payloads = [
        json.loads(call.args[1])
        for call in mock_redis.publish.call_args_list
        if call.args[0] == "new_orders"
    ]
    assert payloads
    assert payloads[0]["table_label"] == "Table 2"


def test_tables_are_scoped_per_kitchen(client, db):
    """A code from another kitchen must not resolve for this one."""
    from app import models

    db.add(models.Table(kitchen_id="other-kitchen", code="shared", label="Their table"))
    db.commit()

    assert client.get("/orders/tables/by-code/shared").status_code == 404
    assert client.post("/orders/", json=_order(table_code="shared")).status_code == 400
    assert client.get("/orders/tables/").json() == []
