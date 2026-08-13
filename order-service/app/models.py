import uuid
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship
from app.database import Base
from app.timeutil import utcnow


class Table(Base):
    """A physical table a customer can order from.

    `code` is what appears in the QR URL (?t=a1) and must stay stable once the
    QR is printed and stuck on the table. `label` is the human-facing name and
    can be renamed freely — orders snapshot it at creation time.
    """
    __tablename__ = "tables"
    __table_args__ = (
        UniqueConstraint("kitchen_id", "code", name="tables_kitchen_code_key"),
        # Labels must be unique too: the label is what lands on the ticket, and
        # two tables sharing one tells the kitchen nothing about where to deliver.
        UniqueConstraint("kitchen_id", "label", name="tables_kitchen_label_key"),
    )
    id = Column(Integer, primary_key=True, index=True)
    kitchen_id = Column(String, nullable=False, index=True)
    code = Column(String, nullable=False, index=True)
    label = Column(String, nullable=False)
    active = Column(Boolean, nullable=False, default=True)
    # NULL means the current code has never been printed — set on creation and
    # reset on every rotation. Kept server-side so the reminder to replace a
    # sticker follows the kitchen, not the browser that happened to rotate it.
    code_printed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)


class Order(Base):
    __tablename__ = "orders"
    # Order numbers restart per kitchen, so they are only unique within one.
    __table_args__ = (UniqueConstraint("kitchen_id", "order_number", name="orders_kitchen_order_number_key"),)
    id = Column(Integer, primary_key=True, index=True)
    public_id = Column(String, nullable=False, unique=True, index=True, default=lambda: str(uuid.uuid4()))
    kitchen_id = Column(String, nullable=False, index=True)
    order_number = Column(String, nullable=False)
    customer_name = Column(String, nullable=False)
    status = Column(String, default="pending")  # pending, in_progress, ready, completed
    # NULL table_id means takeaway — ordered from the kiosk QR, not a table QR.
    table_id = Column(Integer, ForeignKey("tables.id"), nullable=True)
    # Denormalised so renaming or deleting a table never rewrites order history.
    table_label = Column(String, nullable=True)
    # Minor units, snapshotted at order time. NULL when the menu carried no
    # prices — the kitchen is then simply not using the pricing feature.
    total = Column(Integer, nullable=True)
    # Set when the cashier confirms payment. Until then the order belongs to
    # whoever is sitting at the table now, which is what decides whether the
    # next person to scan the QR sees it. Never used to hide an order from the
    # kitchen or from history — a settled order is paid, not gone.
    settled_at = Column(DateTime, nullable=True)
    # Orders closed by one press of "confirm payment" share this, so a bill can
    # be reconciled or reprinted as a unit without a separate sessions table.
    bill_id = Column(String, nullable=True, index=True)
    # How the bill was paid, for reconciling the till at the end of the day.
    # NULL on an unsettled order, and on bills closed before this was recorded.
    payment_method = Column(String, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")


class OrderItem(Base):
    __tablename__ = "order_items"
    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False)
    menu_item_id = Column(Integer, nullable=False)
    menu_item_name = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False, default=1)
    # Price of one of the dish when the order was placed, so later menu changes
    # never rewrite an old bill. Modifier charges live on the rows below and are
    # also per unit.
    unit_price = Column(Integer, nullable=True)
    order = relationship("Order", back_populates="items")
    ingredients = relationship("OrderItemIngredient", back_populates="order_item", cascade="all, delete-orphan")
    options = relationship("OrderItemOption", back_populates="order_item", cascade="all, delete-orphan")


class OrderItemIngredient(Base):
    __tablename__ = "order_item_ingredients"
    id = Column(Integer, primary_key=True, index=True)
    order_item_id = Column(Integer, ForeignKey("order_items.id"), nullable=False)
    ingredient_id = Column(Integer, nullable=False)
    ingredient_name = Column(String, nullable=False)
    included = Column(Boolean, default=True)
    price_delta = Column(Integer, nullable=False, default=0)
    order_item = relationship("OrderItem", back_populates="ingredients")


class OrderItemOption(Base):
    __tablename__ = "order_item_options"
    id = Column(Integer, primary_key=True, index=True)
    order_item_id = Column(Integer, ForeignKey("order_items.id"), nullable=False)
    option_id = Column(Integer, nullable=False)
    option_name = Column(String, nullable=False)
    group_name = Column(String, nullable=False)
    price_delta = Column(Integer, nullable=False, default=0)
    order_item = relationship("OrderItem", back_populates="options")


class PrinterDevice(Base):
    __tablename__ = "printer_devices"
    id = Column(Integer, primary_key=True, index=True)
    mac_address = Column(String, unique=True, nullable=False, index=True)
    claim_code = Column(String, nullable=False, index=True)   # last 6 hex chars of MAC, uppercase
    kitchen_id = Column(String, nullable=True, index=True)    # set when claimed
    name = Column(String, nullable=True)
    ip_address = Column(String, nullable=True)
    registered_at = Column(DateTime, default=utcnow)
    claimed_at = Column(DateTime, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
