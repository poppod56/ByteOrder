import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.auth import get_kitchen_id
from app.database import get_db

router = APIRouter(prefix="/orders/tables", tags=["tables"])


def _slugify(label: str) -> str:
    """ASCII slug for use in the QR URL (?t=...).

    Non-ASCII labels (e.g. Thai) legitimately reduce to an empty string —
    callers must fall back to a generated code in that case, since the code
    ends up in a URL that staff may have to read or type off a printed sheet.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", label.strip().lower()).strip("-")
    return slug[:32]


def _code_taken(code: str, kitchen_id: str, db: Session) -> bool:
    return db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.code == code,
    ).first() is not None


def _unique_code(desired: str, kitchen_id: str, db: Session) -> str:
    """First free code from `desired`, `desired-2`, `desired-3`, …"""
    base = desired or "t"
    if not _code_taken(base, kitchen_id, db):
        return base
    n = 2
    while _code_taken(f"{base}-{n}", kitchen_id, db):
        n += 1
    return f"{base}-{n}"


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
    if data.code and data.count > 1:
        raise HTTPException(status_code=400, detail="Cannot set an explicit code when creating multiple tables")

    if data.code:
        code = data.code.strip().lower()
        if code != _slugify(code):
            raise HTTPException(status_code=400, detail="Code may only contain lowercase letters, numbers and dashes")
        if _code_taken(code, kitchen_id, db):
            raise HTTPException(status_code=409, detail=f"Code '{code}' is already in use")

    created = []
    for i in range(data.count):
        row_label = label if data.count == 1 else f"{label} {i + 1}"
        if data.code:
            row_code = data.code.strip().lower()
        else:
            row_code = _unique_code(_slugify(row_label), kitchen_id, db)
        table = models.Table(kitchen_id=kitchen_id, code=row_code, label=row_label)
        db.add(table)
        # Flush per row so _unique_code sees codes created earlier in this loop.
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
