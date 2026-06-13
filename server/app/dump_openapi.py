"""Dump the OpenAPI schema to stdout — consumed by web/'s `gen:api` script."""

import json

from app.main import app


def main() -> None:
    print(json.dumps(app.openapi(), indent=2))


if __name__ == "__main__":
    main()
