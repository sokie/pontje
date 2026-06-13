FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app

# ONE worker — the presence registry and rate limiter are in-process state.
# NEVER add --workers: a second worker silently breaks WS relay (PLAN.md §18).
CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", \
    "--host", "0.0.0.0", "--port", "8000", \
    "--proxy-headers", "--forwarded-allow-ips", "*", \
    "--ws-ping-interval", "20", "--ws-ping-timeout", "20"]
