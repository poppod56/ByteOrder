import uuid
from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship
from app.database import Base


class Table(Base):
    """A physical table a customer can order from.

    `code` is what appears in the QR URL (?t=a1) and must stay stable once the
    QR is printed and stuck on the table. `label` is the human-facing name and
    can be renamed freely — orders snapshot it at creation time.
    """
    __tablename__ = "tables"
    __table_args__ = (UniqueConstraint("kitchen_id", "code", name="tables_kitchen_code_key"),)
    id = Column(Integer, primary_key=True, index=True)
    kitchen_id = Column(String, nullable=False, index=True)
    code = Column(String, nullable=False, index=True)
    label = Column(String, nullable=False)
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True, index=True)
    public_id = Column(String, nullable=False, unique=True, index=True, default=lambda: str(uuid.uuid4()))
    kitchen_id = Column(String, nullable=False, index=True)
    order_number = Column(String, unique=True, nullable=False)
    customer_name = Column(String, nullable=False)
    status = Column(String, default="pending")  # pending, in_progress, ready, completed
    # NULL table_id means takeaway — ordered from the kiosk QR, not a table QR.
    table_id = Column(Integer, ForeignKey("tables.id"), nullable=True)
    # Denormalised so renaming or deleting a table never rewrites order history.
    table_label = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")


class OrderItem(Base):
    __tablename__ = "order_items"
    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False)
    menu_item_id = Column(Integer, nullable=False)
    menu_item_name = Column(String, nullable=False)
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
    order_item = relationship("OrderItem", back_populates="ingredients")


class OrderItemOption(Base):
    __tablename__ = "order_item_options"
    id = Column(Integer, primary_key=True, index=True)
    order_item_id = Column(Integer, ForeignKey("order_items.id"), nullable=False)
    option_id = Column(Integer, nullable=False)
    option_name = Column(String, nullable=False)
    group_name = Column(String, nullable=False)
    order_item = relationship("OrderItem", back_populates="options")


class PrinterDevice(Base):
    __tablename__ = "printer_devices"
    id = Column(Integer, primary_key=True, index=True)
    mac_address = Column(String, unique=True, nullable=False, index=True)
    claim_code = Column(String, nullable=False, index=True)   # last 6 hex chars of MAC, uppercase
    kitchen_id = Column(String, nullable=True, index=True)    # set when claimed
    name = Column(String, nullable=True)
    ip_address = Column(String, nullable=True)
    registered_at = Column(DateTime, default=datetime.utcnow)
    claimed_at = Column(DateTime, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
