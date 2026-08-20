# falda-analysis

Offline distillation history browser and live store inspector for Falda.
Built with [Textual](https://textual.textualize.io/).

## Usage

```bash
uv run --project analysis falda-analysis --root=/path/to/falda-data --tenant=my-agent
```

## Development

All commands run from the **repo root** (`/workspaces/falda`), not from `analysis/`.

### Install dev dependencies

```bash
uv sync --project analysis
```

### Verification loop

Run this full loop before committing any change to `analysis/`:

```bash
uv run --project analysis ruff format --check analysis   # formatting
uv run --project analysis ruff check analysis/src analysis/tests  # lint
uv run --project analysis mypy analysis/src              # type checking
uv run --project analysis pytest analysis/tests -q       # tests
```

To auto-fix formatting:

```bash
uv run --project analysis ruff format analysis
```
