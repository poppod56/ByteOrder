from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from app.database import Base
from app.timeutil import utcnow


class Setting(Base):
    __tablename__ = "settings"
    kitchen_id = Column(String, primary_key=True, nullable=False)
    key = Column(String, primary_key=True, nullable=False)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class Category(Base):
    __tablename__ = "categories"
    id = Column(Integer, primary_key=True, index=True)
    kitchen_id = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    sort_order = Column(Integer, default=0)
    active = Column(Boolean, default=True)
    items = relationship("MenuItem", back_populates="category")


class MenuItem(Base):
    __tablename__ = "menu_items"
    id = Column(Integer, primary_key=True, index=True)
    kitchen_id = Column(String, nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    active = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    # Minor units (satang/cents) as an integer: menu maths has to be exact, and
    # floats cannot represent most prices. NULL means no price has been set.
    price = Column(Integer, nullable=True)
    # Base64 payload, deliberately excluded from list responses — twenty items
    # would otherwise put megabytes of image data in every menu fetch. Served
    # instead by GET /items/{id}/image, which the browser can cache.
    image = Column(Text, nullable=True)
    image_mime = Column(String, nullable=True)

    category = relationship("Category", back_populates="items")
    item_ingredients = relationship("MenuItemIngredient", back_populates="menu_item", cascade="all, delete-orphan")
    option_groups = relationship("OptionGroup", back_populates="menu_item", cascade="all, delete-orphan")

    @property
    def has_image(self) -> bool:
        """Read by MenuItemOut so every endpoint reports it without remembering to."""
        return bool(self.image)


class Ingredient(Base):
    __tablename__ = "ingredients"
    id = Column(Integer, primary_key=True, index=True)
    kitchen_id = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    active = Column(Boolean, default=True)
    item_ingredients = relationship("MenuItemIngredient", back_populates="ingredient")


class MenuItemIngredient(Base):
    __tablename__ = "menu_item_ingredients"
    id = Column(Integer, primary_key=True, index=True)
    menu_item_id = Column(Integer, ForeignKey("menu_items.id"), nullable=False)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id"), nullable=False)
    is_default = Column(Boolean, default=True)
    # Charged when the customer switches this topping on. Minor units, and may be
    # negative for a discount when something is left out.
    price_delta = Column(Integer, nullable=False, default=0)
    menu_item = relationship("MenuItem", back_populates="item_ingredients")
    ingredient = relationship("Ingredient", back_populates="item_ingredients")


class OptionGroup(Base):
    __tablename__ = "option_groups"
    id = Column(Integer, primary_key=True, index=True)
    menu_item_id = Column(Integer, ForeignKey("menu_items.id"), nullable=False)
    name = Column(String, nullable=False)
    required = Column(Boolean, default=False)
    min_select = Column(Integer, default=0)
    max_select = Column(Integer, default=1)
    menu_item = relationship("MenuItem", back_populates="option_groups")
    options = relationship("Option", back_populates="group", cascade="all, delete-orphan")


class Option(Base):
    __tablename__ = "options"
    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("option_groups.id"), nullable=False)
    name = Column(String, nullable=False)
    price_delta = Column(Integer, nullable=False, default=0)
    group = relationship("OptionGroup", back_populates="options")


class Kitchen(Base):
    __tablename__ = "kitchens"
    kitchen_id = Column(String, primary_key=True)
    slug = Column(String, unique=True, nullable=False, index=True)


class AdminUser(Base):
    __tablename__ = "admin_users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=utcnow)
