from datetime import UTC, datetime

# Convention: all DB timestamps are NAIVE UTC. SQLite stores them as ISO strings
# without offset; clients re-attach "Z" when parsing (web/src/lib/time.ts).


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)
