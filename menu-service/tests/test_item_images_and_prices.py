import base64

from app import models

# 1x1 transparent PNG
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAABzenr0AAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
)
PNG_B64 = base64.b64encode(PNG_BYTES).decode()
PNG_DATA_URL = f"data:image/png;base64,{PNG_B64}"


def _make_item(db, name="Cheeseburger", price=None):
    cat = models.Category(kitchen_id="test-kitchen", name="Food", sort_order=0, active=True)
    db.add(cat)
    db.commit()
    item = models.MenuItem(kitchen_id="test-kitchen", category_id=cat.id, name=name, price=price)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


# ── Images ────────────────────────────────────────────────────────────────────

def test_item_starts_with_no_image(client, db):
    item = _make_item(db)
    assert client.get(f"/items/{item.id}").json()["has_image"] is False
    assert client.get(f"/items/{item.id}/image").status_code == 404


def test_upload_then_serve_as_binary(client, db):
    """Served as bytes, not base64 — the browser caches it and the list stays small."""
    item = _make_item(db)

    put = client.put(f"/items/{item.id}/image", json={"data_url": PNG_DATA_URL})
    assert put.status_code == 200
    assert put.json()["has_image"] is True

    got = client.get(f"/items/{item.id}/image")
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/png"
    assert got.content == PNG_BYTES
    assert "max-age" in got.headers.get("cache-control", "")


def test_the_menu_list_never_carries_image_payloads(client, db):
    item = _make_item(db)
    client.put(f"/items/{item.id}/image", json={"data_url": PNG_DATA_URL})

    listed = client.get("/items/").json()[0]
    assert listed["has_image"] is True
    assert "image" not in listed
    assert PNG_B64 not in str(listed)


def test_categories_report_image_presence_too(client, db):
    item = _make_item(db)
    client.put(f"/items/{item.id}/image", json={"data_url": PNG_DATA_URL})

    cats = client.get("/categories/").json()
    assert cats[0]["items"][0]["has_image"] is True


def test_image_can_be_removed(client, db):
    item = _make_item(db)
    client.put(f"/items/{item.id}/image", json={"data_url": PNG_DATA_URL})

    assert client.delete(f"/items/{item.id}/image").json()["has_image"] is False
    assert client.get(f"/items/{item.id}/image").status_code == 404


def test_svg_is_rejected(client, db):
    """SVG is served back to browsers and can carry script."""
    item = _make_item(db)
    svg = base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>").decode()

    response = client.put(f"/items/{item.id}/image", json={"data_url": f"data:image/svg+xml;base64,{svg}"})
    assert response.status_code == 400
    assert "svg" in response.json()["detail"].lower()


def test_non_data_url_is_rejected(client, db):
    item = _make_item(db)
    for value in ("https://example.com/burger.png", "javascript:alert(1)", PNG_B64):
        assert client.put(f"/items/{item.id}/image", json={"data_url": value}).status_code == 400


def test_malformed_base64_is_rejected(client, db):
    item = _make_item(db)
    response = client.put(f"/items/{item.id}/image", json={"data_url": "data:image/png;base64,!!!not!!!"})
    assert response.status_code == 400


def test_oversized_image_is_rejected(client, db):
    item = _make_item(db)
    big = base64.b64encode(b"\x00" * (600 * 1024)).decode()

    response = client.put(f"/items/{item.id}/image", json={"data_url": f"data:image/png;base64,{big}"})
    assert response.status_code == 400
    assert "KB" in response.json()["detail"]


def test_cannot_touch_another_kitchens_image(client, db):
    cat = models.Category(kitchen_id="other-kitchen", name="Theirs", sort_order=0, active=True)
    db.add(cat)
    db.commit()
    theirs = models.MenuItem(kitchen_id="other-kitchen", category_id=cat.id, name="Theirs")
    db.add(theirs)
    db.commit()
    db.refresh(theirs)

    assert client.put(f"/items/{theirs.id}/image", json={"data_url": PNG_DATA_URL}).status_code == 404
    assert client.get(f"/items/{theirs.id}/image").status_code == 404
    assert client.delete(f"/items/{theirs.id}/image").status_code == 404


# ── Prices ────────────────────────────────────────────────────────────────────

def test_price_is_optional(client, db):
    item = _make_item(db)
    assert client.get(f"/items/{item.id}").json()["price"] is None


def test_price_round_trips_in_minor_units(client, db):
    cat = models.Category(kitchen_id="test-kitchen", name="Food", sort_order=0, active=True)
    db.add(cat)
    db.commit()

    created = client.post("/items/", json={"category_id": cat.id, "name": "Burger", "price": 12000})
    assert created.status_code == 201
    assert created.json()["price"] == 12000


def test_topping_and_option_price_deltas_are_exposed(client, db):
    item = _make_item(db, price=12000)
    ing = models.Ingredient(kitchen_id="test-kitchen", name="Bacon", active=True)
    db.add(ing)
    db.commit()

    client.post(f"/items/{item.id}/ingredients", json={
        "ingredient_id": ing.id, "is_default": False, "price_delta": 2000,
    })
    group = client.post(f"/items/{item.id}/option-groups", json={"name": "Size"}).json()
    client.post(f"/items/{item.id}/option-groups/{group['id']}/options", json={
        "name": "Large", "price_delta": 1500,
    })

    fetched = client.get(f"/items/{item.id}").json()
    assert fetched["item_ingredients"][0]["price_delta"] == 2000
    assert fetched["option_groups"][0]["options"][0]["price_delta"] == 1500


def test_price_deltas_default_to_zero(client, db):
    item = _make_item(db)
    ing = models.Ingredient(kitchen_id="test-kitchen", name="Lettuce", active=True)
    db.add(ing)
    db.commit()

    added = client.post(f"/items/{item.id}/ingredients", json={"ingredient_id": ing.id})
    assert added.json()["price_delta"] == 0
