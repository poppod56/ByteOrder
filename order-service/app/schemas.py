from datetime import datetime
from typing import Optional
from pydantic import BaseModel


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
    model_config = {"from_attributes": True}


class OrderItemOptionOut(BaseModel):
    option_id: int
    option_name: str
    group_name: str
    model_config = {"from_attributes": True}


class OrderItemOut(BaseModel):
    id: int
    menu_item_id: int
    menu_item_name: str
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
    items: list[OrderItemOut] = []
    queue_position: Optional[int] = None
    model_config = {"from_attributes": True}


class OrderStatusUpdate(BaseModel):
    status: str


class TableIn(BaseModel):
    label: str
    code: Optional[str] = None   # derived from label when omitted
    count: int = 1               # >1 creates label 1..N in one call


class TableUpdate(BaseModel):
    label: Optional[str] = None
    active: Optional[bool] = None


class TableOut(BaseModel):
    id: int
    kitchen_id: str
    code: str
    label: str
    active: bool
    created_at: datetime
    model_config = {"from_attributes": True}


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
