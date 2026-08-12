from datetime import datetime, timezone


def utcnow() -> datetime:
    """Current UTC time, without a tzinfo.

    Naive on purpose. The DateTime columns are timezone-naive, so values read
    back out are naive too; returning an aware datetime here would mean mixing
    the two in comparisons — `created_at < :param` would ask Postgres to compare
    timestamp against timestamptz, and Python-side comparisons would raise
    outright. Replaces datetime.utcnow(), which is deprecated.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
