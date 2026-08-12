import secrets

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.auth import get_kitchen_id
from app.database import get_db

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

    created = []
    for i in range(data.count):
        row_label = label if data.count == 1 else f"{label} {i + 1}"
        table = models.Table(kitchen_id=kitchen_id, code=_random_code(kitchen_id, db), label=row_label)
        db.add(table)
        # Flush per row so _random_code sees codes issued earlier in this loop.
        db.flush()
        created.append(table)

    db.commit()
    for table in created:
        db.refresh(table)
    return created


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
    db.commit()
    db.refresh(table)
    return table


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
