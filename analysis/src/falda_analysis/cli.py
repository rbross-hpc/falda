import argparse
import os
from pathlib import Path

from .app import HistoryApp
from .store import StoreError, load_summary


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Browse one Falda tenant's distillation history")
    result.add_argument(
        "--root",
        type=Path,
        default=Path(os.environ.get("FALDA_ROOT", "./falda-data")),
        help="Falda data root (default: FALDA_ROOT or ./falda-data)",
    )
    result.add_argument("--tenant", required=True, help="Tenant self-store to inspect")
    return result


def main() -> None:
    args = parser().parse_args()
    try:
        load_summary(args.root, args.tenant)
    except StoreError as error:
        parser().error(str(error))
    HistoryApp(args.root, args.tenant).run()


if __name__ == "__main__":
    main()
