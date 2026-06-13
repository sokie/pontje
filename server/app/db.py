from collections.abc import Iterator

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

from app.config import settings

# Sync engine by design: DB helpers are sync, HTTP endpoints are plain `def`
# (FastAPI runs them in its threadpool), async code (WS handler, enrichment,
# sweeper) calls DB helpers via asyncio.to_thread (PLAN.md §18).
engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def init_db() -> None:
    # Import for side effect: register all tables on SQLModel.metadata.
    from app import models  # noqa: F401

    SQLModel.metadata.create_all(engine)
    # create_all never ALTERs existing tables — columns added after a table
    # first shipped are backfilled here (idempotent).
    _ensure_column("links", "summary", "TEXT")


def _ensure_column(table: str, column: str, ddl_type: str) -> None:
    """Add a column if missing. Args are code constants, never user input."""
    with engine.begin() as conn:
        existing = [row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")]
        if column not in existing:
            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}")


def get_db() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
