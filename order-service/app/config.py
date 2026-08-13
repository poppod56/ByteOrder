from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://byteorder:byteorder@postgres:5432/byteorder"
    redis_url: str = "redis://redis:6379"
    otel_endpoint: str = ""
    otel_service_name: str = "order-service"
    # How long a table's unpaid-but-finished orders keep showing on the customer's
    # phone. The cashier is meant to close every bill; this only covers the one
    # they forgot, so the next party to scan the QR does not inherit it.
    table_session_hours: int = 4

    class Config:
        env_file = ".env"


settings = Settings()
