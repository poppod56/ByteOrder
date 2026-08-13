from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class OrderItemIngredientIn(BaseModel):
    ingredient_id: int
    ingredient_name: str
    included: bool = True


class OrderItemOptionIn(BaseModel):
    option_id: int
    option_name: str
    group_name: str


class OrderItemIn(BaseModel):
    menu_item_id: int
    menu_item_name: str
    # Bounded so a typo or a stuck stepper cannot book a thousand burgers.
    quantity: int = Field(default=1, ge=1, le=99)
    ingredients: list[OrderItemIngredientIn] = []
    options: list[OrderItemOptionIn] = []


class OrderIn(BaseModel):
    # Optional when table_code is given — the table label is used as the name.
    customer_name: str = ""
    items: list[OrderItemIn]
    table_code: Optional[str] = None


class OrderItemIngredientOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    included: bool
    price_delta: int = 0
    model_config = {"from_attributes": True}


class OrderItemOptionOut(BaseModel):
    option_id: int
    option_name: str
    group_name: str
    price_delta: int = 0
    model_config = {"from_attributes": True}


class OrderItemOut(BaseModel):
    id: int
    menu_item_id: int
    menu_item_name: str
    quantity: int = 1
    unit_price: Optional[int] = None
    ingredients: list[OrderItemIngredientOut] = []
    options: list[OrderItemOptionOut] = []
    model_config = {"from_attributes": True}


class OrderOut(BaseModel):
    id: int
    public_id: str
    order_number: str
    customer_name: str
    status: str
    created_at: datetime
    updated_at: datetime
    table_id: Optional[int] = None
    table_label: Optional[str] = None
    total: Optional[int] = None
    settled_at: Optional[datetime] = None
    bill_id: Optional[str] = None
    payment_method: Optional[str] = None
    items: list[OrderItemOut] = []
    queue_position: Optional[int] = None
    model_config = {"from_attributes": True}


class OrderStatusUpdate(BaseModel):
    status: str


class TableIn(BaseModel):
    label: str
    count: int = 1   # >1 creates label 1..N in one call; codes are always generated


class TableUpdate(BaseModel):
    label: Optional[str] = None
    active: Optional[bool] = None


class TablesPrinted(BaseModel):
    ids: list[int] = []


class TableOut(BaseModel):
    id: int
    kitchen_id: str
    code: str
    label: str
    active: bool
    code_printed_at: Optional[datetime] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class TableSettleIn(BaseModel):
    """The orders the cashier had on screen when they pressed confirm.

    Sent explicitly rather than settling "everything open for this table": a
    dish ordered while the cashier was reading the bill would otherwise be
    marked paid without anyone having collected the money for it.
    """
    order_ids: list[int] = []
    # Recorded for the end-of-day reconciliation, not enforced: the money has
    # already changed hands by the time this is sent. Optional, so a kitchen
    # that only ever takes cash need not answer the question.
    payment_method: Optional[str] = None


class OpenTableOut(BaseModel):
    """One table with money still owed on it."""
    table_id: int
    code: str
    label: str
    active: bool
    order_count: int
    # Sum of the orders that carry a price. NULL when the kitchen prices nothing,
    # so the cashier screen shows a checklist rather than a bogus 0.00 total.
    total: Optional[int] = None
    opened_at: datetime
    last_order_at: datetime
    # Orders the kitchen has not finished yet — the cashier is told before they
    # take payment, they are not stopped from taking it.
    unserved_count: int
    # All finished and untouched for hours: almost certainly a bill nobody closed.
    # Hidden from the customer app already; flagged here so it can be cleared.
    stale: bool
    orders: list[OrderOut] = []
    model_config = {"from_attributes": True}


class SettleOut(BaseModel):
    bill_id: str
    payment_method: Optional[str] = None
    settled: list[OrderOut] = []
    # Anything still unpaid for the table once this bill closed — normally empty,
    # non-empty exactly when an order landed while the cashier was confirming.
    outstanding: list[OrderOut] = []


class TablePublicOut(BaseModel):
    """Shape returned to unauthenticated customers resolving a QR code."""
    code: str
    label: str
    model_config = {"from_attributes": True}


class PrinterRegistration(BaseModel):
    mac_address: str
    ip_address: Optional[str] = None


class PrinterClaim(BaseModel):
    claim_code: str
    name: str


class PrinterRename(BaseModel):
    name: str


class PrinterDeviceOut(BaseModel):
    id: int
    mac_address: str
    claim_code: str
    name: Optional[str]
    ip_address: Optional[str]
    kitchen_id: Optional[str]
    registered_at: datetime
    claimed_at: Optional[datetime]
    last_seen_at: Optional[datetime]
    model_config = {"from_attributes": True}


class PrinterRegisterResponse(BaseModel):
    claim_code: str
    claimed: bool
    kitchen_id: Optional[str]
