import json
import asyncio
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app import models, schemas
from app.database import get_db, SessionLocal
from app.redis_client import get_redis
from app.auth import get_kitchen_id
from app.config import settings
from app.pricing import load_currency, load_language, load_prices, line_total
from app.timeutil import utcnow

log = logging.getLogger(__name__)

router = APIRouter(prefix="/orders", tags=["orders"])

ACTIVE_STATUSES = ("pending", "in_progress", "ready")

# Allocating an order number is read-then-insert, so simultaneous orders can pick
# the same one. The unique constraint is the arbiter; the loser simply retries.
MAX_ORDER_NUMBER_ATTEMPTS = 5
ORDER_NUMBER_CONSTRAINT = "orders_kitchen_order_number_key"


def _is_order_number_collision(exc: IntegrityError) -> bool:
    """True only for the (kitchen_id, order_number) unique violation.

    Retrying anything else would bury a real fault — a corrupt foreign key or a
    public_id clash would surface as "could not allocate an order number" after
    five pointless attempts. Postgres names the violated constraint in psycopg2's
    diagnostics; SQLite has no diagnostics, so its message (which names the
    columns) is matched instead.
    """
    orig = getattr(exc, "orig", None)
    constraint = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint:
        return constraint == ORDER_NUMBER_CONSTRAINT
    return "order_number" in str(orig or exc)


def _next_order_number(db: Session, kitchen_id: str) -> str:
    today = utcnow().strftime("%Y%m%d")
    prefix = f"BO-{today}-"
    last = (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == kitchen_id,
            models.Order.order_number.like(f"{prefix}%"),
        )
        .order_by(models.Order.id.desc())
        .first()
    )
    seq = int(last.order_number.split("-")[-1]) + 1 if last else 1
    return f"{prefix}{seq:03d}"


def _queue_position(order: models.Order, db: Session) -> int | None:
    if order.status not in ACTIVE_STATUSES:
        return None
    ahead = (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == order.kitchen_id,
            models.Order.status.in_(ACTIVE_STATUSES),
            models.Order.created_at < order.created_at,
        )
        .count()
    )
    return ahead + 1


def session_is_stale(orders: list[models.Order]) -> bool:
    """True when a table's unpaid orders look like a party that already left.

    Every bill is supposed to be closed by the cashier; this covers the one that
    was not, so the next customer to scan the QR is not shown someone else's
    food. Only a table whose orders are all finished can go stale — an order the
    kitchen is still cooking belongs to whoever is sitting there right now, no
    matter how long the queue has been.

    Nothing is written: the orders stay open on the cashier's screen, because
    money that was never collected must not quietly disappear.
    """
    if not orders or any(o.status != "completed" for o in orders):
        return False
    newest = max(o.created_at for o in orders)
    return newest < utcnow() - timedelta(hours=settings.table_session_hours)


def ticket_items(order: models.Order) -> list[dict]:
    """One order's lines in the shape both printer formatters expect.

    Shared with the receipt published at checkout so a dish reads the same on the
    kitchen ticket and on the bill.
    """
    return [
        {
            "name": oi.menu_item_name,
            "quantity": oi.quantity,
            "unit_price": oi.unit_price,
            "ingredients": [
                {"name": i.ingredient_name, "included": i.included, "price_delta": i.price_delta}
                for i in oi.ingredients
            ],
            "options": [
                {"group": o.group_name, "name": o.option_name, "price_delta": o.price_delta}
                for o in oi.options
            ],
        }
        for oi in order.items
    ]


def _resolve_table(table_code: str | None, kitchen_id: str, db: Session) -> models.Table | None:
    """Look up the table for a scanned QR code, or None for a takeaway order.

    An unknown code is rejected rather than silently dropped — a mis-printed QR
    must fail loudly instead of producing orders the kitchen can't deliver.
    """
    if not table_code:
        return None
    table = db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.code == table_code.strip().lower(),
        models.Table.active.is_(True),
    ).first()
    if not table:
        # Structured detail: the customer app has to tell this apart from the
        # other 400s so it can explain that the QR was replaced, rather than
        # telling the customer to retry something that can never succeed.
        raise HTTPException(status_code=400, detail={
            "code": "unknown_table",
            "message": "Unknown table code",
        })
    return table


def _persist_order(
    data: schemas.OrderIn,
    kitchen_id: str,
    customer_name: str,
    table_id: int | None,
    table_label: str | None,
    db: Session,
) -> models.Order:
    """Insert the order and its items under a freshly allocated order number.

    Raises IntegrityError if a concurrent order claimed the same number first.
    """
    prices = load_prices(data, kitchen_id, db)

    order = models.Order(
        order_number=_next_order_number(db, kitchen_id),
        customer_name=customer_name,
        kitchen_id=kitchen_id,
        table_id=table_id,
        table_label=table_label,
    )
    db.add(order)
    db.flush()

    order_total = 0
    for item_data in data.items:
        unit_price = prices.item_price(item_data.menu_item_id)
        item = models.OrderItem(
            order_id=order.id,
            menu_item_id=item_data.menu_item_id,
            menu_item_name=item_data.menu_item_name,
            quantity=item_data.quantity,
            unit_price=unit_price,
        )
        db.add(item)
        db.flush()

        charged_deltas = []
        for ing in item_data.ingredients:
            # Only a topping actually on the dish is charged for.
            delta = prices.ingredient_delta(item_data.menu_item_id, ing.ingredient_id) if ing.included else 0
            if ing.included:
                charged_deltas.append(delta)
            db.add(models.OrderItemIngredient(
                order_item_id=item.id,
                ingredient_id=ing.ingredient_id,
                ingredient_name=ing.ingredient_name,
                included=ing.included,
                price_delta=delta,
            ))
        option_deltas = []
        for opt in item_data.options:
            delta = prices.option_delta(opt.option_id)
            option_deltas.append(delta)
            db.add(models.OrderItemOption(
                order_item_id=item.id,
                option_id=opt.option_id,
                option_name=opt.option_name,
                group_name=opt.group_name,
                price_delta=delta,
            ))

        line = line_total(unit_price, charged_deltas, option_deltas, item_data.quantity)
        if line is not None:
            order_total += line

    order.total = order_total if prices.priced else None

    db.commit()
    db.refresh(order)
    return order


@router.post("/", response_model=schemas.OrderOut, status_code=201)
def create_order(data: schemas.OrderIn, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    table = _resolve_table(data.table_code, kitchen_id, db)

    # With a table the name is optional — the label is what the kitchen serves by.
    customer_name = data.customer_name.strip()
    if not customer_name:
        if not table:
            raise HTTPException(status_code=400, detail="customer_name is required")
        customer_name = table.label

    # Read off the table before any rollback expires the instance.
    table_id = table.id if table else None
    table_label = table.label if table else None

    for attempt in range(MAX_ORDER_NUMBER_ATTEMPTS):
        try:
            order = _persist_order(data, kitchen_id, customer_name, table_id, table_label, db)
            break
        except IntegrityError as exc:
            db.rollback()
            if not _is_order_number_collision(exc):
                log.exception("Order insert violated an unexpected constraint")
                raise
            # Someone else took this number between our SELECT and INSERT. Start
            # over — the retry re-reads and sees the row that beat us.
            log.warning(
                "Order number collision for kitchen %s (attempt %d/%d)",
                kitchen_id, attempt + 1, MAX_ORDER_NUMBER_ATTEMPTS,
            )
    else:
        raise HTTPException(status_code=503, detail="Could not allocate an order number — please try again")

    # Publish to Redis for print-service and queue watchers
    redis = get_redis()
    redis.publish(f"queue_updates:{kitchen_id}", json.dumps({"order_id": order.id, "status": order.status}))
    # Ticket payload. Two independent formatters consume this — print-service's
    # format_order() and pi-printer-client's _format_order() — so a field added
    # here has to be rendered in both or the printer backends disagree.
    order_payload = json.dumps({
        # Both formatters now also receive receipts on this channel. Absent means
        # a kitchen ticket, so messages published by an older build still print.
        "kind": "order",
        "order_id": order.id,
        "order_number": order.order_number,
        "customer_name": order.customer_name,
        "table_label": order.table_label,
        "kitchen_id": order.kitchen_id,
        "total": order.total,
        "currency": load_currency(kitchen_id, db),
        "ticket_language": load_language(kitchen_id, db),
        "items": ticket_items(order),
    })
    redis.publish("new_orders", order_payload)
    # Kitchen-scoped channel for Pi printer clients
    redis.publish(f"new_orders:{order.kitchen_id}", order_payload)

    result = schemas.OrderOut.model_validate(order)
    result.queue_position = _queue_position(order, db)
    return result


@router.get("/queue", response_model=list[schemas.OrderOut])
def get_queue(db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    orders = (
        db.query(models.Order)
        .filter(models.Order.kitchen_id == kitchen_id, models.Order.status.in_(ACTIVE_STATUSES))
        .order_by(models.Order.created_at)
        .all()
    )
    results = []
    for order in orders:
        out = schemas.OrderOut.model_validate(order)
        out.queue_position = _queue_position(order, db)
        results.append(out)
    return results


@router.get("/queue/stream")
async def queue_stream(kitchen_id: str = Depends(get_kitchen_id)):
    async def event_generator():
        redis = get_redis()
        pubsub = redis.pubsub()
        # Scoped per kitchen: on a shared deployment an unscoped channel woke
        # every kitchen's kiosk on every other kitchen's orders.
        pubsub.subscribe(f"queue_updates:{kitchen_id}")
        try:
            while True:
                message = pubsub.get_message(ignore_subscribe_messages=True, timeout=0)
                if message:
                    yield f"data: {message['data'].decode()}\n\n"
                else:
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.5)
        finally:
            pubsub.unsubscribe()
            pubsub.close()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/history", response_model=list[schemas.OrderOut])
def get_history(date: str | None = None, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    q = db.query(models.Order).filter(models.Order.kitchen_id == kitchen_id, models.Order.status == "completed")
    if date:
        try:
            d = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Use YYYY-MM-DD") from e
        q = q.filter(func.date(models.Order.created_at) == d)
    else:
        q = q.filter(func.date(models.Order.created_at) == utcnow().date())
    return q.order_by(models.Order.created_at.desc()).all()


def _local_day(date: str | None, tz_offset: int) -> tuple[datetime, datetime, str]:
    """The UTC window covering one local calendar day, and the day's own name.

    Timestamps are stored as naive UTC, so a day counted in UTC would cut a
    Bangkok kitchen's trading day at 07:00 and file the evening's takings under
    two dates. The offset comes from the browser doing the asking, which is the
    till standing in the restaurant.

    Returned as a half-open window so it can be compared directly against the
    stored column — no database-specific date arithmetic, and the index on
    settled_at still applies.
    """
    if not -14 * 60 <= tz_offset <= 14 * 60:
        raise HTTPException(status_code=400, detail="tz_offset must be within ±14 hours")
    offset = timedelta(minutes=tz_offset)
    if date:
        try:
            day = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Use YYYY-MM-DD") from e
    else:
        day = (utcnow() + offset).date()
    start = datetime(day.year, day.month, day.day) - offset
    return start, start + timedelta(days=1), day.isoformat()


@router.get("/takings", response_model=schemas.TakingsOut)
def get_takings(
    date: str | None = None,
    tz_offset: int = 0,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """What the till took in on one day, broken down by how it was paid.

    Counted by when the money was taken, not when the food was ordered: a table
    that ordered before midnight and paid after belongs to the day it paid for,
    which is the day whose cash drawer has to balance.

    The unpaid figures are the other way round — orders placed that day that
    nobody has settled — so a short till has somewhere obvious to look. Both
    figures cover takeaway as well as tables: a bill of one is still a bill, and
    leaving it out made the total quietly short for a kitchen that sells much of
    its food over the counter.
    """
    start, end, day = _local_day(date, tz_offset)

    settled = (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == kitchen_id,
            models.Order.settled_at >= start,
            models.Order.settled_at < end,
        )
        .all()
    )

    by_method: dict[str | None, list[models.Order]] = {}
    bills: dict[str | None, set[str]] = {}
    for order in settled:
        by_method.setdefault(order.payment_method, []).append(order)
        bills.setdefault(order.payment_method, set()).add(order.bill_id)

    def totalled(orders: list[models.Order]) -> int | None:
        # None rather than 0 when nothing carried a price: an unpriced menu has
        # no takings to report, which is not the same as having taken nothing.
        priced = [o.total for o in orders if o.total is not None]
        return sum(priced) if priced else None

    rows = [
        schemas.TakingsByMethodOut(
            method=method,
            bill_count=len(bills[method]),
            order_count=len(orders),
            total=totalled(orders),
        )
        # Largest first, so the biggest column to verify is at the top. Bills
        # with no recorded method sort last whatever their size.
        for method, orders in sorted(
            by_method.items(),
            key=lambda kv: (kv[0] is None, -(totalled(kv[1]) or 0), kv[0] or ""),
        )
    ]

    unpaid = (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == kitchen_id,
            models.Order.settled_at.is_(None),
            models.Order.created_at >= start,
            models.Order.created_at < end,
        )
        .all()
    )

    return schemas.TakingsOut(
        date=day,
        bill_count=len({o.bill_id for o in settled}),
        order_count=len(settled),
        total=totalled(settled),
        by_method=rows,
        unpaid_order_count=len(unpaid),
        unpaid_total=totalled(unpaid),
    )


@router.get("/by-table/{code}", response_model=list[schemas.OrderOut])
def get_orders_for_table(
    code: str,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """The current party's orders for one table, for the "already ordered" list.

    Keyed off the table's QR code rather than anything held in the browser, so the
    list survives a reload, a flat battery or a second phone — and everyone sitting
    at the table sees the same orders, which is the point of a shared table.

    Scoped to the orders that have not been paid for: the QR sticker is the same
    one the last party scanned, so the cashier confirming payment is the only
    thing that separates one party from the next. Still not filtered by status —
    a customer should see the order they just collected, right up until they pay.
    """
    table = db.query(models.Table).filter(
        models.Table.kitchen_id == kitchen_id,
        models.Table.code == code.strip().lower(),
        models.Table.active.is_(True),
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    orders = (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == kitchen_id,
            models.Order.table_id == table.id,
            models.Order.settled_at.is_(None),
        )
        .order_by(models.Order.created_at.desc())
        .all()
    )
    # No calendar-day filter: a party that sits down at 23:50 and orders again at
    # 00:10 is one party, and paying is what ends it. A bill the cashier never
    # closed is caught by the staleness rule instead.
    if session_is_stale(orders):
        return []

    results = []
    for order in orders:
        out = schemas.OrderOut.model_validate(order)
        out.queue_position = _queue_position(order, db)
        results.append(out)
    return results


@router.get("/track/{public_id}", response_model=schemas.OrderOut)
def get_order_by_public_id(public_id: str, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    order = db.query(models.Order).filter(
        models.Order.public_id == public_id,
        models.Order.kitchen_id == kitchen_id,
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    out = schemas.OrderOut.model_validate(order)
    out.queue_position = _queue_position(order, db)
    return out


@router.get("/track/{public_id}/stream")
async def order_stream_by_public_id(public_id: str, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    order = db.query(models.Order).filter(
        models.Order.public_id == public_id,
        models.Order.kitchen_id == kitchen_id,
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    order_id = order.id

    async def event_generator():
        redis = get_redis()
        pubsub = redis.pubsub()
        pubsub.subscribe(f"order_status:{order_id}")
        try:
            current_db = SessionLocal()
            try:
                current = current_db.query(models.Order).filter(models.Order.id == order_id).first()
                pos = _queue_position(current, current_db)
                yield f"data: {json.dumps({'status': current.status, 'queue_position': pos})}\n\n"
            finally:
                current_db.close()

            while True:
                message = pubsub.get_message(ignore_subscribe_messages=True, timeout=0)
                if message:
                    yield f"data: {message['data'].decode()}\n\n"
                else:
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.5)
        finally:
            pubsub.unsubscribe()
            pubsub.close()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/{order_id}", response_model=schemas.OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    order = db.query(models.Order).filter(models.Order.id == order_id, models.Order.kitchen_id == kitchen_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    out = schemas.OrderOut.model_validate(order)
    out.queue_position = _queue_position(order, db)
    return out


@router.put("/{order_id}/status", response_model=schemas.OrderOut)
def update_status(order_id: int, data: schemas.OrderStatusUpdate, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    valid = ("pending", "in_progress", "ready", "completed")
    if data.status not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid}")

    order = db.query(models.Order).filter(models.Order.id == order_id, models.Order.kitchen_id == kitchen_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    order.status = data.status
    db.commit()
    db.refresh(order)

    # Publish status change for SSE
    redis = get_redis()
    redis.publish(f"order_status:{order.id}", json.dumps({
        "order_id": order.id,
        "order_number": order.order_number,
        "status": order.status,
    }))
    # Also publish to the kitchen's queue channel so its kiosk updates
    redis.publish(f"queue_updates:{order.kitchen_id}", json.dumps({"order_id": order.id, "status": order.status}))

    out = schemas.OrderOut.model_validate(order)
    out.queue_position = _queue_position(order, db)
    return out


@router.get("/{order_id}/stream")
async def order_stream(order_id: int, db: Session = Depends(get_db), kitchen_id: str = Depends(get_kitchen_id)):
    order = db.query(models.Order).filter(models.Order.id == order_id, models.Order.kitchen_id == kitchen_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    async def event_generator():
        redis = get_redis()
        pubsub = redis.pubsub()
        pubsub.subscribe(f"order_status:{order_id}")
        try:
            # Send current status immediately
            current_db = SessionLocal()
            try:
                current = current_db.query(models.Order).filter(models.Order.id == order_id).first()
                pos = _queue_position(current, current_db)
                yield f"data: {json.dumps({'status': current.status, 'queue_position': pos})}\n\n"
            finally:
                current_db.close()

            while True:
                message = pubsub.get_message(ignore_subscribe_messages=True, timeout=0)
                if message:
                    yield f"data: {message['data'].decode()}\n\n"
                else:
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.5)
        finally:
            pubsub.unsubscribe()
            pubsub.close()

    return StreamingResponse(event_generator(), media_type="text/event-stream")
