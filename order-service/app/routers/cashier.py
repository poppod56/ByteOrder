"""Taking payment.

A bill is a set of orders paid for together, not a property of a table. Sitting
down groups orders into one bill by which table they came from; ordering to take
away makes one bill of one order. Both are settled the same way, and both have
to reach the end-of-day count — takeaway money that no till ever recorded is the
kind of gap that makes a report worse than having none.
"""
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.auth import get_kitchen_id
from app.database import get_db
from app.pricing import load_currency, load_language
from app.redis_client import get_redis
from app.routers.orders import session_is_stale, ticket_items
from app.timeutil import utcnow

router = APIRouter(prefix="/orders/cashier", tags=["cashier"])

# What the till can record. A closed set because these are counted at the end of
# the day — free text would produce "cash", "Cash" and "เงินสด" as three columns.
PAYMENT_METHODS = ("cash", "transfer", "card", "other")


def _unsettled(kitchen_id: str, db: Session) -> list[models.Order]:
    """Every order with money still owed on it, oldest first.

    Never scoped to a calendar day: a bill nobody closed yesterday is still a
    bill, and dropping it off this list would lose the only record that it was
    never collected.
    """
    return (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == kitchen_id,
            models.Order.settled_at.is_(None),
        )
        .order_by(models.Order.created_at)
        .all()
    )


def _totalled(orders: list[models.Order]) -> int | None:
    """None rather than 0 when nothing carries a price: a kitchen that prices
    nothing has no total, which is not the same as owing nothing."""
    priced = [o.total for o in orders if o.total is not None]
    return sum(priced) if priced else None


@router.get("/open", response_model=list[schemas.OpenBillOut])
def list_open_bills(
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Everything that still owes money, as the cashier screen shows it.

    Tables include deactivated ones that have not paid — taking a table out of
    service must not make its outstanding bill unreachable.
    """
    by_table: dict[int, list[models.Order]] = {}
    takeaway: list[models.Order] = []
    for order in _unsettled(kitchen_id, db):
        if order.table_id is None:
            takeaway.append(order)
        else:
            by_table.setdefault(order.table_id, []).append(order)

    labels = {}
    if by_table:
        labels = {
            t.id: t for t in db.query(models.Table).filter(
                models.Table.kitchen_id == kitchen_id,
                models.Table.id.in_(by_table.keys()),
            ).all()
        }

    bills = []
    for table_id, orders in by_table.items():
        table = labels.get(table_id)
        if not table:
            # The row is gone but the money is not. Better an unlabelled bill on
            # screen than one that cannot be closed at all.
            continue
        bills.append(schemas.OpenBillOut(
            kind="table",
            table_id=table.id,
            code=table.code,
            label=table.label,
            active=table.active,
            order_count=len(orders),
            total=_totalled(orders),
            opened_at=orders[0].created_at,
            last_order_at=orders[-1].created_at,
            unserved_count=sum(1 for o in orders if o.status != "completed"),
            stale=session_is_stale(orders),
            orders=[schemas.OrderOut.model_validate(o) for o in orders],
        ))

    # One order, one bill: takeaway customers do not share a tab, so grouping
    # them by anything would put two strangers' food on one receipt.
    for order in takeaway:
        bills.append(schemas.OpenBillOut(
            kind="takeaway",
            label=order.customer_name,
            order_count=1,
            total=_totalled([order]),
            opened_at=order.created_at,
            last_order_at=order.created_at,
            unserved_count=0 if order.status == "completed" else 1,
            stale=session_is_stale([order]),
            orders=[schemas.OrderOut.model_validate(order)],
        ))

    # Longest-waiting first: that is whoever is about to ask for the bill.
    bills.sort(key=lambda b: b.opened_at)
    return bills


@router.post("/settle", response_model=schemas.SettleOut)
def settle_bill(
    data: schemas.SettleIn,
    db: Session = Depends(get_db),
    kitchen_id: str = Depends(get_kitchen_id),
):
    """Confirm the customer has paid, closing their bill.

    Settling only marks the orders paid — it never touches their status, so food
    the kitchen has not finished stays in the queue and still gets cooked and
    delivered. Paying at the counter before the last dish arrives is normal.

    Only the orders the cashier had on screen are closed. One ordered in the
    seconds between reading the bill out and confirming it comes back as
    `outstanding` instead of being silently marked paid.
    """
    ids = list(dict.fromkeys(data.order_ids))
    if not ids:
        raise HTTPException(status_code=400, detail="No orders to settle")

    method = (data.payment_method or "").strip().lower() or None
    if method and method not in PAYMENT_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid payment_method. Must be one of: {PAYMENT_METHODS}",
        )

    orders = (
        db.query(models.Order)
        .filter(
            models.Order.kitchen_id == kitchen_id,
            models.Order.id.in_(ids),
            models.Order.settled_at.is_(None),
        )
        .order_by(models.Order.created_at)
        .all()
    )
    if not orders:
        # Two cashiers on two tills, or a double-tap. Distinguishable from the
        # other 4xx so the screen can just refresh rather than claim a failure.
        raise HTTPException(status_code=409, detail={
            "code": "already_settled",
            "message": "Those orders have already been paid for",
        })

    # One payment covers one party. Two tables on one bill would leave the other
    # table looking paid to whoever sits there next.
    table_ids = {o.table_id for o in orders}
    if len(table_ids) > 1:
        raise HTTPException(status_code=400, detail={
            "code": "mixed_bill",
            "message": "A bill cannot span more than one table",
        })
    table_id = table_ids.pop()

    bill_id = str(uuid.uuid4())
    now = utcnow()
    for order in orders:
        order.settled_at = now
        order.bill_id = bill_id
        order.payment_method = method
    db.commit()
    for order in orders:
        db.refresh(order)

    # Only a table can gain an order mid-checkout: a takeaway bill is one order
    # that already exists, and anything ordered afterwards is a new customer.
    outstanding = []
    if table_id is not None:
        outstanding = [
            o for o in _unsettled(kitchen_id, db) if o.table_id == table_id
        ]

    redis = get_redis()
    # The customer's phone reloads its list off this channel, so the table clears
    # itself without anyone having to close the tab.
    redis.publish(f"queue_updates:{kitchen_id}", json.dumps({
        "event": "bill_settled",
        "table_id": table_id,
        "bill_id": bill_id,
    }))

    # The receipt goes out on the same channels as kitchen tickets, told apart by
    # `kind`. Both formatters — print-service's and pi-printer-client's — render
    # it, so whichever printer backend a kitchen runs prints the same bill.
    receipt = json.dumps({
        "kind": "receipt",
        "bill_id": bill_id,
        "kitchen_id": kitchen_id,
        "table_label": orders[0].table_label,
        # What a takeaway bill is identified by, there being no table on it.
        "customer_name": orders[0].customer_name,
        "payment_method": method,
        "settled_at": now.isoformat(),
        "total": _totalled(orders),
        "currency": load_currency(kitchen_id, db),
        "ticket_language": load_language(kitchen_id, db),
        "orders": [
            {"order_number": o.order_number, "items": ticket_items(o)}
            for o in orders
        ],
    })
    redis.publish("new_orders", receipt)
    redis.publish(f"new_orders:{kitchen_id}", receipt)

    return schemas.SettleOut(
        bill_id=bill_id,
        payment_method=method,
        settled=[schemas.OrderOut.model_validate(o) for o in orders],
        outstanding=[schemas.OrderOut.model_validate(o) for o in outstanding],
    )
