import json
import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.auth import get_kitchen_id
from app.database import get_db
from app.redis_client import get_redis
from app.routers.orders import session_is_stale
from app.timeutil import utcnow

router = APIRouter(prefix="/orders/tables", tags=["tables"])

# Ambiguous glyphs (0/O, 1/l/I) are excluded so a code read off a printed sheet
# is never transcribed wrongly.
_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_CODE_LENGTH = 10


def _code_taken(code: str, kitchen_id: str, db: Session) -> bool:
    return db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.code == code,
    ).first() is not None


def _label_taken(label: str, kitchen_id: str, db: Session) -> bool:
    """Includes deactivated tables — their label still appears in order history."""
    return db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.label == label,
    ).first() is not None


def _existing_labels(kitchen_id: str, db: Session) -> set[str]:
    return {
        row[0] for row in
        db.query(models.Table.label).filter(models.Table.kitchen_id == kitchen_id).all()
    }


def _next_free_label(base: str, taken: set[str]) -> str:
    """`base 1`, `base 2`, … skipping numbers already in use.

    Numbering continues past existing tables rather than restarting, so adding
    four more "Table"s to four existing ones gives Table 5-8, not a second set
    of Table 1-4 that the kitchen could not tell apart. `taken` is read once and
    updated by the caller, so creating 200 tables is one query, not 200 × 200.
    """
    n = 1
    while f"{base} {n}" in taken:
        n += 1
    return f"{base} {n}"


def _random_code(kitchen_id: str, db: Session) -> str:
    """An unguessable code for the QR URL.

    Codes must be random rather than derived from the label: rotating a
    guessable code (table-1 → table-2) would not actually revoke anything, which
    is the whole point of rotation.
    """
    while True:
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))
        if not _code_taken(code, kitchen_id, db):
            return code


# ── Public endpoint — called by the customer app to resolve a scanned QR ──────

@router.get("/by-code/{code}", response_model=schemas.TablePublicOut)
def get_table_by_code(
    code: str,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Resolve a QR code to its table label. No admin auth — customers call this."""
    table = db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.code == code.strip().lower(),
        models.Table.active.is_(True),
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    return table


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.get("/", response_model=list[schemas.TableOut])
def list_tables(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    q = db.query(models.Table).filter(models.Table.kitchen_id == kitchen_id)
    if not include_inactive:
        q = q.filter(models.Table.active.is_(True))
    return q.order_by(models.Table.created_at, models.Table.id).all()


@router.post("/", response_model=list[schemas.TableOut], status_code=201)
def create_tables(
    data: schemas.TableIn,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Create one table, or `count` tables numbered from the label as a prefix."""
    label = data.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Label is required")
    if data.count < 1 or data.count > 200:
        raise HTTPException(status_code=400, detail="Count must be between 1 and 200")

    taken = _existing_labels(kitchen_id, db)
    if data.count == 1 and label in taken:
        raise HTTPException(status_code=409, detail=f"A table called '{label}' already exists")

    created = []
    for _ in range(data.count):
        row_label = label if data.count == 1 else _next_free_label(label, taken)
        taken.add(row_label)
        table = models.Table(kitchen_id=kitchen_id, code=_random_code(kitchen_id, db), label=row_label)
        db.add(table)
        # Flush per row so _random_code sees codes issued earlier in this loop.
        db.flush()
        created.append(table)

    db.commit()
    for table in created:
        db.refresh(table)
    return created


# ── Cashier ───────────────────────────────────────────────────────────────────

def _unsettled(kitchen_id: str, db: Session, table_id: int | None = None) -> list[models.Order]:
    """Orders with money still owed on them, oldest first.

    Never scoped to a calendar day: a bill nobody closed yesterday is still a
    bill, and dropping it off this list would lose the only record that it was
    never collected.
    """
    q = db.query(models.Order).filter(
        models.Order.kitchen_id == kitchen_id,
        models.Order.table_id.isnot(None),
        models.Order.settled_at.is_(None),
    )
    if table_id is not None:
        q = q.filter(models.Order.table_id == table_id)
    return q.order_by(models.Order.created_at).all()


@router.get("/open", response_model=list[schemas.OpenTableOut])
def list_open_tables(
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Every table with an unpaid bill, for the cashier screen.

    Includes deactivated tables that still owe money — taking a table out of
    service must not make its outstanding bill unreachable.
    """
    by_table: dict[int, list[models.Order]] = {}
    for order in _unsettled(kitchen_id, db):
        by_table.setdefault(order.table_id, []).append(order)
    if not by_table:
        return []

    tables = db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.id.in_(by_table.keys()),
    ).all()

    results = []
    for table in tables:
        orders = by_table[table.id]
        # A kitchen that prices nothing has no total at all, rather than a 0.00
        # that reads as "already paid".
        priced = [o.total for o in orders if o.total is not None]
        results.append(schemas.OpenTableOut(
            table_id=table.id,
            code=table.code,
            label=table.label,
            active=table.active,
            order_count=len(orders),
            total=sum(priced) if priced else None,
            opened_at=orders[0].created_at,
            last_order_at=orders[-1].created_at,
            unserved_count=sum(1 for o in orders if o.status != "completed"),
            stale=session_is_stale(orders),
            orders=[schemas.OrderOut.model_validate(o) for o in orders],
        ))
    # Longest-waiting table first: that is the one about to ask for the bill.
    results.sort(key=lambda t: t.opened_at)
    return results


@router.post("/{table_id}/settle", response_model=schemas.SettleOut)
def settle_table(
    table_id: int,
    data: schemas.TableSettleIn,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Confirm the customer has paid, closing their bill and freeing the table.

    Settling only marks the orders paid — it never touches their status, so food
    the kitchen has not finished stays in the queue and still gets cooked and
    delivered. Paying at the counter before the last dish arrives is normal.

    Only the orders the cashier had on screen are closed. One ordered in the
    seconds between reading the bill and confirming it comes back as
    `outstanding` instead of being silently marked paid.
    """
    table = db.query(models.Table).filter(
        models.Table.id == table_id,
        models.Table.kitchen_id == kitchen_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    ids = list(dict.fromkeys(data.order_ids))
    if not ids:
        raise HTTPException(status_code=400, detail="No orders to settle")

    orders = db.query(models.Order).filter(
        models.Order.kitchen_id == kitchen_id,
        models.Order.table_id == table.id,
        models.Order.id.in_(ids),
        models.Order.settled_at.is_(None),
    ).order_by(models.Order.created_at).all()
    if not orders:
        # Two cashiers on two tills, or a double-tap. Distinguishable from the
        # other 4xx so the screen can just refresh rather than claim a failure.
        raise HTTPException(status_code=409, detail={
            "code": "already_settled",
            "message": "Those orders have already been paid for",
        })

    bill_id = str(uuid.uuid4())
    now = utcnow()
    for order in orders:
        order.settled_at = now
        order.bill_id = bill_id
    db.commit()
    for order in orders:
        db.refresh(order)

    outstanding = _unsettled(kitchen_id, db, table.id)

    # The customer's phone reloads its list off this channel, so the table clears
    # itself without anyone having to close the tab.
    get_redis().publish(f"queue_updates:{kitchen_id}", json.dumps({
        "event": "bill_settled",
        "table_id": table.id,
        "bill_id": bill_id,
    }))

    return schemas.SettleOut(
        bill_id=bill_id,
        settled=[schemas.OrderOut.model_validate(o) for o in orders],
        outstanding=[schemas.OrderOut.model_validate(o) for o in outstanding],
    )


# ── Admin: editing tables ─────────────────────────────────────────────────────

@router.put("/{table_id}", response_model=schemas.TableOut)
def update_table(
    table_id: int,
    data: schemas.TableUpdate,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    table = db.query(models.Table).filter(
        models.Table.id == table_id,
        models.Table.kitchen_id == kitchen_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    if data.label is not None:
        label = data.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Label cannot be empty")
        if label != table.label and _label_taken(label, kitchen_id, db):
            raise HTTPException(status_code=409, detail=f"A table called '{label}' already exists")
        # `code` is deliberately left alone — printed QR codes must keep working.
        table.label = label
    if data.active is not None:
        table.active = data.active

    db.commit()
    db.refresh(table)
    return table


@router.post("/{table_id}/rotate", response_model=schemas.TableOut)
def rotate_table_code(
    table_id: int,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Issue a new QR code for a table, for when the old one has leaked.

    The old code stops working immediately and with no grace period — anyone
    who kept a photo of it is exactly who this is meant to cut off. The sticker
    on the table must be reprinted.
    """
    table = db.query(models.Table).filter(
        models.Table.id == table_id,
        models.Table.kitchen_id == kitchen_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    table.code = _random_code(kitchen_id, db)
    # The printed sticker is now wrong, so this code counts as unprinted again.
    table.code_printed_at = None
    db.commit()
    db.refresh(table)
    return table


@router.post("/mark-printed", response_model=list[schemas.TableOut])
def mark_codes_printed(
    data: schemas.TablesPrinted,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Record that the stickers for these tables have been replaced.

    Confirmed explicitly rather than inferred from opening the print dialog —
    printing can be cancelled, and the paper still has to reach the table.
    """
    tables = db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.id.in_(data.ids or []),
    ).all()
    now = utcnow()
    for table in tables:
        table.code_printed_at = now
    db.commit()
    for table in tables:
        db.refresh(table)
    return tables


@router.delete("/{table_id}", status_code=204)
def deactivate_table(
    table_id: int,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Soft delete — past orders keep referencing the row, and the code stays
    reserved so a reprinted sheet can never point at a different table."""
    table = db.query(models.Table).filter(
        models.Table.id == table_id,
        models.Table.kitchen_id == kitchen_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    table.active = False
    db.commit()
