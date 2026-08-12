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


def _make_table(client, label):
    """Create one table and return it, including its generated code."""
    return client.post("/orders/tables/", json={"label": label}).json()[0]


# ── Create ────────────────────────────────────────────────────────────────────

def test_create_single_table(client):
    response = client.post("/orders/tables/", json={"label": "Table A1"})
    assert response.status_code == 201
    data = response.json()
    assert len(data) == 1
    assert data[0]["label"] == "Table A1"
    assert data[0]["active"] is True


def test_create_multiple_tables_numbers_them(client):
    response = client.post("/orders/tables/", json={"label": "Table", "count": 4})
    assert response.status_code == 201
    data = response.json()
    assert [t["label"] for t in data] == ["Table 1", "Table 2", "Table 3", "Table 4"]


def test_generated_codes_are_unguessable(client):
    """A code derived from the label would make rotation pointless."""
    code = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]["code"]
    assert len(code) == 10
    assert "table" not in code
    assert set(code) <= set("abcdefghjkmnpqrstuvwxyz23456789")


def test_codes_are_distinct_across_tables(client):
    codes = [t["code"] for t in client.post("/orders/tables/", json={"label": "T", "count": 20}).json()]
    assert len(set(codes)) == 20


def test_create_works_for_non_ascii_labels(client):
    response = client.post("/orders/tables/", json={"label": "โต๊ะ"})
    assert response.status_code == 201
    assert response.json()[0]["label"] == "โต๊ะ"
    assert response.json()[0]["code"]


def test_create_rejects_empty_label(client):
    assert client.post("/orders/tables/", json={"label": "   "}).status_code == 400


def test_create_rejects_out_of_range_count(client):
    assert client.post("/orders/tables/", json={"label": "T", "count": 0}).status_code == 400
    assert client.post("/orders/tables/", json={"label": "T", "count": 500}).status_code == 400


# ── Rotate ────────────────────────────────────────────────────────────────────

def test_rotate_issues_a_new_code(client):
    table = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]
    rotated = client.post(f"/orders/tables/{table['id']}/rotate")
    assert rotated.status_code == 200
    assert rotated.json()["code"] != table["code"]


def test_rotate_keeps_identity_and_label(client):
    table = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]
    rotated = client.post(f"/orders/tables/{table['id']}/rotate").json()
    assert rotated["id"] == table["id"]
    assert rotated["label"] == "Table 1"
    assert rotated["active"] is True


def test_rotate_kills_the_old_code_immediately(client):
    """No grace period — a leaked code is exactly what this cuts off."""
    table = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]
    client.post(f"/orders/tables/{table['id']}/rotate")

    assert client.get(f"/orders/tables/by-code/{table['code']}").status_code == 404
    assert client.post("/orders/", json=_order(table_code=table["code"])).status_code == 400


def test_rotated_code_works_for_new_orders(client):
    table = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]
    new_code = client.post(f"/orders/tables/{table['id']}/rotate").json()["code"]

    assert client.get(f"/orders/tables/by-code/{new_code}").status_code == 200
    response = client.post("/orders/", json=_order(table_code=new_code))
    assert response.status_code == 201
    assert response.json()["table_id"] == table["id"]
    assert response.json()["table_label"] == "Table 1"


def test_rotate_does_not_affect_past_orders(client):
    table = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]
    order_id = client.post("/orders/", json=_order(table_code=table["code"])).json()["id"]

    client.post(f"/orders/tables/{table['id']}/rotate")

    order = client.get(f"/orders/{order_id}").json()
    assert order["table_id"] == table["id"]
    assert order["table_label"] == "Table 1"


def test_rotate_leaves_other_tables_alone(client):
    tables = client.post("/orders/tables/", json={"label": "T", "count": 3}).json()
    client.post(f"/orders/tables/{tables[0]['id']}/rotate")

    still_valid = client.get(f"/orders/tables/by-code/{tables[1]['code']}")
    assert still_valid.status_code == 200


def test_rotate_repeatedly_keeps_changing_the_code(client):
    table = client.post("/orders/tables/", json={"label": "Table 1"}).json()[0]
    seen = {table["code"]}
    for _ in range(5):
        code = client.post(f"/orders/tables/{table['id']}/rotate").json()["code"]
        assert code not in seen
        seen.add(code)


def test_rotate_unknown_table_404(client):
    assert client.post("/orders/tables/999/rotate").status_code == 404


def test_rotate_another_kitchens_table_404(client, db):
    from app import models

    other = models.Table(kitchen_id="other-kitchen", code="theircode1", label="Theirs")
    db.add(other)
    db.commit()

    assert client.post(f"/orders/tables/{other.id}/rotate").status_code == 404
    # …and their code still resolves for them, i.e. it was left untouched.
    db.refresh(other)
    assert other.code == "theircode1"


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
    table = _make_table(client, "Table 7")
    response = client.get(f"/orders/tables/by-code/{table['code']}")
    assert response.status_code == 200
    assert response.json() == {"code": table["code"], "label": "Table 7"}


def test_by_code_is_case_insensitive(client):
    """Some QR scanners upper-case the path they hand to the browser."""
    table = _make_table(client, "Table 7")
    assert client.get(f"/orders/tables/by-code/{table['code'].upper()}").status_code == 200


def test_by_code_unknown_returns_404(client):
    assert client.get("/orders/tables/by-code/nope").status_code == 404


def test_by_code_inactive_returns_404(client):
    table = _make_table(client, "Gone")
    client.delete(f"/orders/tables/{table['id']}")
    assert client.get(f"/orders/tables/by-code/{table['code']}").status_code == 404


# ── Orders placed from a table ───────────────────────────────────────────────

def test_order_from_table_records_id_and_label(client):
    table = _make_table(client, "Table 3")
    response = client.post("/orders/", json=_order(table_code=table["code"]))
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
    table = _make_table(client, "Retired")
    client.delete(f"/orders/tables/{table['id']}")
    assert client.post("/orders/", json=_order(table_code=table["code"])).status_code == 400


def test_order_from_table_defaults_name_to_table_label(client):
    table = _make_table(client, "Table 9")
    response = client.post("/orders/", json=_order(table_code=table["code"], customer_name=""))
    assert response.status_code == 201
    assert response.json()["customer_name"] == "Table 9"


def test_order_from_table_keeps_given_name(client):
    table = _make_table(client, "Table 9")
    response = client.post("/orders/", json=_order(table_code=table["code"], customer_name="Bob"))
    assert response.json()["customer_name"] == "Bob"


def test_takeaway_order_still_requires_a_name(client):
    assert client.post("/orders/", json=_order(customer_name="  ")).status_code == 400


def test_renaming_a_table_does_not_rewrite_past_orders(client):
    table = _make_table(client, "Table 3")
    order_id = client.post("/orders/", json=_order(table_code=table["code"])).json()["id"]

    client.put(f"/orders/tables/{table['id']}", json={"label": "Table 3 (moved)"})

    assert client.get(f"/orders/{order_id}").json()["table_label"] == "Table 3"


def test_queue_exposes_table_label(client):
    table = _make_table(client, "Table 5")
    client.post("/orders/", json=_order(table_code=table["code"]))
    assert client.get("/orders/queue").json()[0]["table_label"] == "Table 5"


def test_published_payload_includes_table_label(client, mock_redis):
    """print-service reads table_label off the Redis payload to head the ticket."""
    table = _make_table(client, "Table 2")
    client.post("/orders/", json=_order(table_code=table["code"]))

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


# ── Label uniqueness ─────────────────────────────────────────────────────────
# The label is what lands on the printed ticket, so two tables sharing one
# leaves the kitchen unable to tell where the food goes.

def test_duplicate_single_label_is_rejected(client):
    _make_table(client, "Patio")
    response = client.post("/orders/tables/", json={"label": "Patio"})
    assert response.status_code == 409
    assert "Patio" in response.json()["detail"]


def test_bulk_create_continues_numbering_instead_of_restarting(client):
    first = client.post("/orders/tables/", json={"label": "Table", "count": 4}).json()
    second = client.post("/orders/tables/", json={"label": "Table", "count": 4}).json()

    assert [t["label"] for t in first] == ["Table 1", "Table 2", "Table 3", "Table 4"]
    assert [t["label"] for t in second] == ["Table 5", "Table 6", "Table 7", "Table 8"]


def test_single_create_uses_the_label_verbatim(client):
    """count=1 is how a table gets a real name rather than a number."""
    assert _make_table(client, "Window seat")["label"] == "Window seat"


def test_bulk_create_skips_labels_already_taken(client):
    tables = client.post("/orders/tables/", json={"label": "Table", "count": 3}).json()
    client.delete(f"/orders/tables/{tables[1]['id']}")   # deactivate "Table 2"

    added = client.post("/orders/tables/", json={"label": "Table", "count": 2}).json()
    # "Table 2" is deactivated but still named in past orders, so it stays reserved.
    assert [t["label"] for t in added] == ["Table 4", "Table 5"]


def test_rename_onto_an_existing_label_is_rejected(client):
    _make_table(client, "Patio")
    other = _make_table(client, "Garden")

    response = client.put(f"/orders/tables/{other['id']}", json={"label": "Patio"})
    assert response.status_code == 409


def test_rename_to_its_own_label_is_allowed(client):
    table = _make_table(client, "Patio")
    response = client.put(f"/orders/tables/{table['id']}", json={"label": "Patio"})
    assert response.status_code == 200


def test_a_deactivated_table_still_reserves_its_label(client):
    table = _make_table(client, "Seasonal")
    client.delete(f"/orders/tables/{table['id']}")
    assert client.post("/orders/tables/", json={"label": "Seasonal"}).status_code == 409


def test_labels_are_unique_only_within_a_kitchen(client, db):
    from app import models

    db.add(models.Table(kitchen_id="other-kitchen", code="theircode1", label="Patio"))
    db.commit()

    assert client.post("/orders/tables/", json={"label": "Patio"}).status_code == 201


# ── Error shape for a rotated-away code ──────────────────────────────────────

def test_unknown_table_code_error_is_machine_readable(client):
    """The customer app must tell this apart from other 400s to explain it."""
    response = client.post("/orders/", json=_order(table_code="gone-forever"))
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unknown_table"


def test_rotated_code_reports_unknown_table(client):
    table = _make_table(client, "Table 1")
    client.post(f"/orders/tables/{table['id']}/rotate")

    response = client.post("/orders/", json=_order(table_code=table["code"]))
    assert response.json()["detail"]["code"] == "unknown_table"


def test_missing_name_error_is_distinct_from_unknown_table(client):
    response = client.post("/orders/", json=_order(customer_name="  "))
    assert response.status_code == 400
    assert response.json()["detail"] != {"code": "unknown_table", "message": "Unknown table code"}
