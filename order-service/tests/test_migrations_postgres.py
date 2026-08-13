"""Integration tests for _run_migrations() against a real PostgreSQL.

The rest of the suite runs on SQLite with the lifespan patched out, so it never
executes the migration SQL at all — the ALTER/DO blocks are Postgres-specific and
were until now completely untested.

Set ORDER_SERVICE_TEST_DATABASE_URL to run these, e.g. against the compose stack:

    ORDER_SERVICE_TEST_DATABASE_URL=postgresql://byteorder:byteorder@localhost:5432/byteorder_migrationtest \\
        python -m pytest tests/test_migrations_postgres.py -v

Each test builds the pre-migration schema from scratch in its own schema
namespace, so it never touches application data.
"""
import os

import pytest
from sqlalchemy import create_engine, text

DATABASE_URL = os.environ.get("ORDER_SERVICE_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="ORDER_SERVICE_TEST_DATABASE_URL not set — needs a live PostgreSQL",
)


# The orders/tables shape as it existed before per-table ordering: order_number
# globally unique, no table columns, tables table without the label constraint.
_LEGACY_SCHEMA = """
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    public_id VARCHAR NOT NULL UNIQUE,
    kitchen_id VARCHAR NOT NULL DEFAULT '',
    order_number VARCHAR NOT NULL UNIQUE,
    customer_name VARCHAR NOT NULL,
    status VARCHAR DEFAULT 'pending',
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
CREATE TABLE printer_devices (
    id SERIAL PRIMARY KEY,
    mac_address VARCHAR NOT NULL UNIQUE,
    claim_code VARCHAR NOT NULL,
    kitchen_id VARCHAR,
    name VARCHAR,
    registered_at TIMESTAMP,
    claimed_at TIMESTAMP,
    last_seen_at TIMESTAMP
);
CREATE TABLE tables (
    id SERIAL PRIMARY KEY,
    kitchen_id VARCHAR NOT NULL,
    code VARCHAR NOT NULL,
    label VARCHAR NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP,
    CONSTRAINT tables_kitchen_code_key UNIQUE (kitchen_id, code)
);
"""


@pytest.fixture
def legacy_db(request):
    """A throwaway schema holding the pre-migration tables, with some data in them."""
    engine = create_engine(DATABASE_URL)
    schema = f"migtest_{abs(hash(request.node.name)) % 10**8}"

    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))

    scoped = create_engine(
        DATABASE_URL,
        connect_args={"options": f"-csearch_path={schema}"},
    )
    with scoped.begin() as conn:
        for statement in filter(None, (s.strip() for s in _LEGACY_SCHEMA.split(";"))):
            conn.execute(text(statement))
        conn.execute(text("""
            INSERT INTO orders (public_id, kitchen_id, order_number, customer_name, status)
            VALUES ('pid-1', 'kitchen-a', 'BO-20260101-001', 'Alice', 'completed'),
                   ('pid-2', 'kitchen-a', 'BO-20260101-002', 'Bob', 'pending')
        """))
        conn.execute(text("""
            INSERT INTO tables (kitchen_id, code, label)
            VALUES ('kitchen-a', 'aaaaaaaaaa', 'Table 1'),
                   ('kitchen-a', 'bbbbbbbbbb', 'Table 1'),
                   ('kitchen-a', 'cccccccccc', 'Patio')
        """))

    try:
        yield scoped
    finally:
        scoped.dispose()
        with engine.begin() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        engine.dispose()


def _migrate(scoped_engine, monkeypatch):
    """Run the real _run_migrations() against the throwaway schema."""
    import app.main as main

    monkeypatch.setattr(main, "engine", scoped_engine)
    main._run_migrations()


def _constraints(conn, table):
    rows = conn.execute(text("""
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = :t AND constraint_type = 'UNIQUE'
    """), {"t": table}).fetchall()
    return {r[0] for r in rows}


def test_existing_order_data_survives(legacy_db, monkeypatch):
    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        rows = conn.execute(text("SELECT order_number, customer_name FROM orders ORDER BY id")).fetchall()
    assert [tuple(r) for r in rows] == [
        ("BO-20260101-001", "Alice"),
        ("BO-20260101-002", "Bob"),
    ]


def test_global_order_number_constraint_is_dropped(legacy_db, monkeypatch):
    with legacy_db.connect() as conn:
        assert "orders_order_number_key" in _constraints(conn, "orders")

    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        assert "orders_order_number_key" not in _constraints(conn, "orders")


def test_composite_order_number_constraint_is_added(legacy_db, monkeypatch):
    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        assert "orders_kitchen_order_number_key" in _constraints(conn, "orders")


def test_two_kitchens_can_hold_the_same_order_number(legacy_db, monkeypatch):
    _migrate(legacy_db, monkeypatch)

    with legacy_db.begin() as conn:
        conn.execute(text("""
            INSERT INTO orders (public_id, kitchen_id, order_number, customer_name)
            VALUES ('pid-3', 'kitchen-b', 'BO-20260101-001', 'Carol')
        """))
    with legacy_db.connect() as conn:
        count = conn.execute(text(
            "SELECT count(*) FROM orders WHERE order_number = 'BO-20260101-001'"
        )).scalar()
    assert count == 2


def test_the_same_kitchen_still_cannot_reuse_an_order_number(legacy_db, monkeypatch):
    from sqlalchemy.exc import IntegrityError

    _migrate(legacy_db, monkeypatch)

    with pytest.raises(IntegrityError):
        with legacy_db.begin() as conn:
            conn.execute(text("""
                INSERT INTO orders (public_id, kitchen_id, order_number, customer_name)
                VALUES ('pid-4', 'kitchen-a', 'BO-20260101-001', 'Dave')
            """))


def test_table_columns_are_added(legacy_db, monkeypatch):
    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        cols = {r[0] for r in conn.execute(text("""
            SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'
        """)).fetchall()}
        table_cols = {r[0] for r in conn.execute(text("""
            SELECT column_name FROM information_schema.columns WHERE table_name = 'tables'
        """)).fetchall()}

    assert {"table_id", "table_label"} <= cols
    assert "code_printed_at" in table_cols


def test_duplicate_table_labels_are_suffixed_then_constrained(legacy_db, monkeypatch):
    """An earlier build allowed two "Table 1"s; the constraint must not fail startup."""
    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        labels = sorted(r[0] for r in conn.execute(text(
            "SELECT label FROM tables WHERE kitchen_id = 'kitchen-a'"
        )).fetchall())
        assert labels == ["Patio", "Table 1", "Table 1 (2)"]
        assert "tables_kitchen_label_key" in _constraints(conn, "tables")


def test_existing_orders_start_out_unpaid(legacy_db, monkeypatch):
    """Unsettled is the safe default: an old bill lands on the cashier's screen
    to be closed rather than counting itself as already collected."""
    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        cols = {r[0] for r in conn.execute(text("""
            SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'
        """)).fetchall()}
        assert {"settled_at", "bill_id", "payment_method"} <= cols

        unsettled = conn.execute(text(
            "SELECT count(*) FROM orders WHERE settled_at IS NULL"
        )).scalar()
        assert unsettled == 2

        indexes = {r[0] for r in conn.execute(text(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'orders'"
        )).fetchall()}
        assert "orders_open_bills_idx" in indexes


def test_migration_is_idempotent(legacy_db, monkeypatch):
    _migrate(legacy_db, monkeypatch)
    _migrate(legacy_db, monkeypatch)
    _migrate(legacy_db, monkeypatch)

    with legacy_db.connect() as conn:
        assert "orders_kitchen_order_number_key" in _constraints(conn, "orders")
        assert "tables_kitchen_label_key" in _constraints(conn, "tables")
        # Re-running must not keep suffixing the labels it already fixed.
        labels = sorted(r[0] for r in conn.execute(text(
            "SELECT label FROM tables WHERE kitchen_id = 'kitchen-a'"
        )).fetchall())
        assert labels == ["Patio", "Table 1", "Table 1 (2)"]
        assert conn.execute(text("SELECT count(*) FROM orders")).scalar() == 2
