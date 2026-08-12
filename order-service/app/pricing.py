"""Authoritative pricing for an incoming order.

Prices are never taken from the request. The customer app is public and
unauthenticated, so anything it sent could be edited to zero — every figure here
is looked up from the menu tables instead.

Those tables belong to menu-service, which shares this database. Reading them
directly mirrors print-service, which already reads `settings` the same way. The
alternative — an HTTP call to menu-service on every order — would put a second
service in the path of placing an order for no gain in correctness.
"""
import logging

from sqlalchemy import bindparam, inspect as sa_inspect, text
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

_MENU_TABLES = {"menu_items", "menu_item_ingredients", "options"}
DEFAULT_CURRENCY = "THB"

# Both services migrate at startup with no ordering between them, so menu-service's
# tables may briefly be absent. Once seen, a table cannot disappear, so positive
# results are cached and the inspection cost is paid at most once per table.
_confirmed_tables: set[str] = set()


class MenuPrices:
    """Prices for one order, read in three queries rather than per line."""

    def __init__(self, items: dict[int, int | None], ingredients: dict[tuple[int, int], int], options: dict[int, int]):
        self._items = items
        self._ingredients = ingredients
        self._options = options
        # A menu with no prices at all is a kitchen not using the feature — the
        # order still goes through, it just carries no total.
        self.priced = any(v is not None for v in items.values())

    def item_price(self, menu_item_id: int) -> int | None:
        return self._items.get(menu_item_id)

    def ingredient_delta(self, menu_item_id: int, ingredient_id: int) -> int:
        return self._ingredients.get((menu_item_id, ingredient_id), 0)

    def option_delta(self, option_id: int) -> int:
        return self._options.get(option_id, 0)


_EMPTY = MenuPrices({}, {}, {})


def _table_available(db: Session, *names: str) -> bool:
    wanted = set(names)
    if wanted <= _confirmed_tables:
        return True
    present = set(sa_inspect(db.get_bind()).get_table_names())
    _confirmed_tables.update(present)
    return wanted <= present


def _menu_tables_available(db: Session) -> bool:
    return _table_available(db, *_MENU_TABLES)


def _in_query(sql: str, *expanding: str):
    return text(sql).bindparams(*(bindparam(name, expanding=True) for name in expanding))


def load_prices(data, kitchen_id: str, db: Session) -> MenuPrices:
    """Look up every price this order touches, scoped to the kitchen.

    Missing menu tables are handled explicitly rather than by catching database
    errors: a kiosk that stops taking orders because pricing is unavailable is
    worse than a ticket with no total, but a malformed query is a bug and has to
    surface as one instead of quietly turning every order free.
    """
    item_ids = {i.menu_item_id for i in data.items}
    if not item_ids or not _menu_tables_available(db):
        return _EMPTY

    ingredient_ids = {ing.ingredient_id for i in data.items for ing in i.ingredients}
    option_ids = {opt.option_id for i in data.items for opt in i.options}

    items = {
        row[0]: row[1] for row in db.execute(
            _in_query(
                "SELECT id, price FROM menu_items WHERE kitchen_id = :kid AND id IN :ids",
                "ids",
            ),
            {"kid": kitchen_id, "ids": list(item_ids)},
        )
    }

    ingredients = {}
    if ingredient_ids:
        ingredients = {
            (row[0], row[1]): row[2] or 0 for row in db.execute(
                _in_query("""
                    SELECT menu_item_id, ingredient_id, price_delta
                    FROM menu_item_ingredients
                    WHERE menu_item_id IN :items AND ingredient_id IN :ings
                """, "items", "ings"),
                {"items": list(item_ids), "ings": list(ingredient_ids)},
            )
        }

    options = {}
    if option_ids:
        options = {
            row[0]: row[1] or 0 for row in db.execute(
                _in_query("SELECT id, price_delta FROM options WHERE id IN :ids", "ids"),
                {"ids": list(option_ids)},
            )
        }

    return MenuPrices(items, ingredients, options)


def load_currency(kitchen_id: str, db: Session) -> str:
    """Currency code for the kitchen, defaulting to THB.

    Read here and published with the order so both ticket formatters use the same
    value instead of each looking it up.
    """
    if not _table_available(db, "settings"):
        return DEFAULT_CURRENCY
    row = db.execute(
        text("SELECT value FROM settings WHERE kitchen_id = :kid AND key = 'currency'"),
        {"kid": kitchen_id},
    ).fetchone()
    return (row[0] if row and row[0] else "") or DEFAULT_CURRENCY


def line_total(unit_price: int | None, ingredient_deltas: list[int], option_deltas: list[int]) -> int | None:
    """Total for one line, or None when the dish itself has no price."""
    if unit_price is None:
        return None
    return unit_price + sum(ingredient_deltas) + sum(option_deltas)
