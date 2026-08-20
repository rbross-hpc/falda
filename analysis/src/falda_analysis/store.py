import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from .models import (
    AtomView,
    CoreEffect,
    DataGap,
    Decision,
    EvidenceTurn,
    LiveRecall,
    LiveState,
    Pass,
    RecallItem,
    ReconstructionQuality,
    SceneEffect,
    SceneMembership,
    StoreSummary,
)

REQUIRED_TABLES = {
    "atoms",
    "consolidation_decisions",
    "distillation_passes",
    "pass_core_effects",
    "pass_scene_effects",
    "scenes",
    "stream",
}


class StoreError(RuntimeError):
    pass


def store_paths(root: Path, tenant: str) -> tuple[Path, Path]:
    if not tenant or tenant in {".", ".."} or "/" in tenant or "\\" in tenant:
        raise StoreError("tenant must be a single non-empty path segment")
    store_dir = root.expanduser().resolve() / "tenants" / tenant / "self"
    return store_dir / "falda.db", store_dir / "blobs"


@contextmanager
def open_store(root: Path, tenant: str) -> Iterator[sqlite3.Connection]:
    db_path, _ = store_paths(root, tenant)
    if not db_path.is_file():
        raise StoreError(f"tenant self-store does not exist: {db_path}")
    uri = f"file:{quote(str(db_path))}?mode=ro"
    try:
        db = sqlite3.connect(uri, uri=True)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = REQUIRED_TABLES - tables
        if missing:
            raise StoreError(
                f"store lacks required inspection tables: {', '.join(sorted(missing))}"
            )
        yield db
    except sqlite3.Error as error:
        raise StoreError(f"cannot read store {db_path}: {error}") from error
    finally:
        if "db" in locals():
            db.close()


def _count(
    db: sqlite3.Connection, table: str, where: str = "", args: tuple[object, ...] = ()
) -> int:
    row = db.execute(f"SELECT COUNT(*) FROM {table} {where}", args).fetchone()
    return int(row[0])


def load_summary(root: Path, tenant: str) -> StoreSummary:
    db_path, blob_dir = store_paths(root, tenant)
    with open_store(root, tenant) as db:
        stream_head = db.execute("SELECT MAX(seq) FROM stream").fetchone()[0]
        atoms = {
            status: _count(db, "atoms", "WHERE status=?", (status,))
            for status in ("active", "superseded", "merged", "archived")
        }
        scenes = {
            f"{kind}_{status}": _count(
                db, "scenes", "WHERE scene_kind=? AND status=?", (kind, status)
            )
            for kind in ("episode", "topic")
            for status in ("active", "retired")
        }
        dirty = None
        has_dirty = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_dirty'"
        ).fetchone()
        if has_dirty:
            dirty = db.execute(
                "SELECT reason, marked_at FROM store_dirty WHERE store_key=?", (f"{tenant}:self",)
            ).fetchone()
    core_path = blob_dir / "core.md"
    return StoreSummary(
        label=f"{tenant}:self",
        db_path=db_path,
        stream_total=_count_readonly(root, tenant, "stream"),
        stream_head_seq=int(stream_head) if stream_head is not None else None,
        atoms=atoms,
        atoms_pinned=_count_readonly(root, tenant, "atoms", "WHERE status='active' AND pinned=1"),
        scenes=scenes,
        core_present=core_path.is_file(),
        core_chars=len(core_path.read_text(encoding="utf-8")) if core_path.is_file() else 0,
        dirty_reason=str(dirty[0]) if dirty else None,
        dirty_marked_at=str(dirty[1]) if dirty else None,
    )


def _count_readonly(
    root: Path, tenant: str, table: str, where: str = "", args: tuple[object, ...] = ()
) -> int:
    with open_store(root, tenant) as db:
        return _count(db, table, where, args)


def load_passes(root: Path, tenant: str, since: timedelta | None = None) -> list[Pass]:
    with open_store(root, tenant) as db:
        rows = db.execute("SELECT * FROM distillation_passes ORDER BY started_at, rowid").fetchall()
        if since is not None:
            cutoff = datetime.now(UTC) - since
            rows = [row for row in rows if _parse_time(row["started_at"]) >= cutoff]
        return [_load_pass(db, row) for row in rows]


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def reconstruct_scene_membership(
    root: Path,
    tenant: str,
    passes: list[Pass],
    selected_pass: Pass,
    scene: SceneEffect,
) -> SceneMembership:
    selected_index = passes.index(selected_pass)
    history = [
        (pass_index, effect)
        for pass_index, item in enumerate(passes[: selected_index + 1])
        for effect in item.scenes
        if effect.scene_id == scene.scene_id
    ]
    baseline = next(
        (
            (history_index, pass_index)
            for history_index, (pass_index, effect) in enumerate(history)
            if effect.effect == "created"
            and effect.members_before == 0
            and len(effect.added) == effect.members_after
        ),
        None,
    )
    if baseline is None:
        return _membership_result(
            root,
            tenant,
            scene,
            "unavailable",
            "No trustworthy creation baseline is available; showing exact delta atoms only.",
            (),
            (),
        )

    baseline_index, baseline_pass_index = baseline
    members: list[str] = []
    before: tuple[str, ...] = ()
    quality: ReconstructionQuality = "complete"
    message = "Reconstructed from a recorded creation baseline and subsequent scene deltas."
    effects_by_pass = {pass_index: effect for pass_index, effect in history[baseline_index:]}
    for pass_index in range(baseline_pass_index, selected_index + 1):
        effect = effects_by_pass.get(pass_index)
        if effect is None:
            quality = "partial"
            message = (
                "One or more passes have no effect row for this scene; "
                "membership may be incomplete."
            )
            continue
        before = tuple(members)
        invalid_removed = any(atom_id not in members for atom_id in effect.removed)
        invalid_added = any(atom_id in members for atom_id in effect.added)
        if effect.members_before != len(members) or invalid_removed or invalid_added:
            quality = "partial"
            message = (
                "A recorded delta does not match the replayed membership; "
                "membership may be incomplete."
            )
        members = [atom_id for atom_id in members if atom_id not in effect.removed]
        members.extend(atom_id for atom_id in effect.added if atom_id not in members)
        if effect.members_after != len(members):
            quality = "partial"
            message = (
                "A recorded member count does not match the replayed deltas; "
                "membership may be incomplete."
            )

    return _membership_result(
        root,
        tenant,
        scene,
        quality,
        message,
        before,
        tuple(members),
    )


def _membership_result(
    root: Path,
    tenant: str,
    scene: SceneEffect,
    quality: ReconstructionQuality,
    message: str,
    before_ids: tuple[str, ...],
    after_ids: tuple[str, ...],
) -> SceneMembership:
    requested = tuple(dict.fromkeys((*before_ids, *after_ids, *scene.added, *scene.removed)))
    atoms = _load_atoms(root, tenant, requested)

    def resolve(ids: tuple[str, ...]) -> tuple[AtomView, ...]:
        return tuple(atoms.get(atom_id, AtomView(atom_id, None, None, None)) for atom_id in ids)

    return SceneMembership(
        scene=scene,
        quality=quality,
        message=message,
        before=resolve(before_ids),
        after=resolve(after_ids),
        added=resolve(scene.added),
        removed=resolve(scene.removed),
    )


def _load_atoms(root: Path, tenant: str, atom_ids: tuple[str, ...]) -> dict[str, AtomView]:
    if not atom_ids:
        return {}
    placeholders = ",".join("?" for _ in atom_ids)
    with open_store(root, tenant) as db:
        rows = db.execute(
            f"SELECT id,type,content,status FROM atoms WHERE id IN ({placeholders})", atom_ids
        ).fetchall()
    return {
        str(row["id"]): AtomView(
            atom_id=str(row["id"]),
            atom_type=str(row["type"]),
            content=str(row["content"]),
            current_status=str(row["status"]),
        )
        for row in rows
    }


def _load_pass(db: sqlite3.Connection, row: sqlite3.Row) -> Pass:
    pass_id = str(row["pass_id"])
    decisions = tuple(_load_decisions(db, pass_id))
    scenes = tuple(_load_scenes(db, pass_id))
    core = _load_core(db, pass_id)
    evidence = tuple(_load_window_evidence(db, row["watermark_start"], row["watermark_end"]))
    gaps = _gaps(row, decisions, scenes, core, evidence)
    counts = {action: 0 for action in ("store", "update", "merge", "skip")}
    for decision in decisions:
        counts[decision.action] += 1
    return Pass(
        pass_id=pass_id,
        store_key=str(row["store_key"]),
        watermark_start=row["watermark_start"],
        watermark_end=row["watermark_end"],
        started_at=str(row["started_at"]),
        completed_at=row["completed_at"],
        status=row["status"],
        input_turn_count=row["input_turn_count"],
        candidate_count=row["candidate_count"],
        error=row["error"],
        model=row["model"],
        prompt_version=row["prompt_version"],
        distiller_version=row["distiller_version"],
        decisions=decisions,
        scenes=scenes,
        core=core,
        evidence=evidence,
        gaps=gaps,
        decision_counts=counts,
    )


def _load_decisions(db: sqlite3.Connection, pass_id: str) -> list[Decision]:
    rows = db.execute(
        "SELECT * FROM consolidation_decisions WHERE pass_id=? ORDER BY id", (pass_id,)
    )
    return [
        Decision(
            id=str(row["id"]),
            action=row["action"],
            candidate_type=row["candidate_type"],
            candidate_content=row["candidate_content"],
            candidate_confidence=row["candidate_confidence"],
            atom_id=row["atom_id"],
            target_ids=tuple(json.loads(row["target_ids"] or "[]")),
            rationale=row["rationale"],
            decided_at=str(row["decided_at"]),
        )
        for row in rows
    ]


def _load_scenes(db: sqlite3.Connection, pass_id: str) -> list[SceneEffect]:
    rows = db.execute(
        "SELECT * FROM pass_scene_effects WHERE pass_id=? ORDER BY scene_kind, scene_id",
        (pass_id,),
    )
    return [
        SceneEffect(
            scene_id=str(row["scene_id"]),
            scene_kind=str(row["scene_kind"]),
            title=row["title"],
            effect=str(row["effect"]),
            members_before=int(row["members_before"]),
            members_after=int(row["members_after"]),
            added=tuple(json.loads(row["added_json"] or "[]")),
            removed=tuple(json.loads(row["removed_json"] or "[]")),
            summary_regenerated=bool(row["summary_regenerated"]),
            embedding_regenerated=bool(row["embedding_regenerated"]),
        )
        for row in rows
    ]


def _load_core(db: sqlite3.Connection, pass_id: str) -> CoreEffect | None:
    row = db.execute("SELECT * FROM pass_core_effects WHERE pass_id=?", (pass_id,)).fetchone()
    if row is None:
        return None
    return CoreEffect(
        effect=str(row["effect"]),
        old_input_hash=row["old_input_hash"],
        new_input_hash=row["new_input_hash"],
        old_chars=row["old_chars"],
        new_chars=row["new_chars"],
    )


def _load_window_evidence(
    db: sqlite3.Connection, start: int | None, end: int | None
) -> list[EvidenceTurn]:
    if end is None:
        return []
    rows = db.execute(
        "SELECT id,session_id,role,content,ts,seq FROM stream WHERE seq>? AND seq<=? ORDER BY seq",
        (start or 0, end),
    )
    return [
        EvidenceTurn(
            stream_id=str(row["id"]),
            session_id=str(row["session_id"]),
            role=str(row["role"]),
            content=str(row["content"]),
            timestamp=str(row["ts"]),
            seq=int(row["seq"]),
        )
        for row in rows
    ]


def _gaps(
    row: sqlite3.Row,
    decisions: tuple[Decision, ...],
    scenes: tuple[SceneEffect, ...],
    core: CoreEffect | None,
    evidence: tuple[EvidenceTurn, ...],
) -> tuple[DataGap, ...]:
    gaps = [
        DataGap("T1", "Historical atom status/count snapshots were not retained."),
        DataGap("T2", "Historical scene summaries and complete scene snapshots were not retained."),
        DataGap("T3", "Historical core text was not retained."),
    ]
    expected = row["input_turn_count"]
    if expected and len(evidence) < expected:
        gaps.append(DataGap("T0", f"Only {len(evidence)} of {expected} pass input turns remain."))
    candidate_count = row["candidate_count"]
    if candidate_count is not None and len(decisions) < candidate_count:
        gaps.append(
            DataGap(
                "T1",
                f"Only {len(decisions)} of {candidate_count} decision audit rows are available.",
            )
        )
    if not scenes:
        gaps.append(DataGap("T2", "No scene effect rows were recorded for this pass."))
    if core is None:
        gaps.append(DataGap("T3", "No core effect row was recorded for this pass."))
    return tuple(gaps)


# ─── live view support ────────────────────────────────────────────────────────

_CONTENT_SNIPPET_LEN = 300


def tenant_store_key(tenant: str) -> str:
    return f"{tenant}:self"


def recall_trace_db_path(root: Path) -> Path:
    return root.expanduser().resolve() / "recall_traces.db"


@contextmanager
def _open_recall_traces(root: Path) -> Iterator[sqlite3.Connection | None]:
    """Yields a read-only connection to recall_traces.db, or None if absent."""
    db_path = recall_trace_db_path(root)
    if not db_path.is_file():
        yield None
        return
    uri = f"file:{quote(str(db_path))}?mode=ro"
    db: sqlite3.Connection | None = None
    try:
        db = sqlite3.connect(uri, uri=True)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        yield db
    except sqlite3.Error as error:
        raise StoreError(f"cannot read recall_traces.db: {error}") from error
    finally:
        if db is not None:
            db.close()


def _load_scene_summaries(
    root: Path, tenant: str, scene_ids: tuple[str, ...]
) -> dict[str, tuple[str | None, str | None]]:
    """Return {scene_id: (title, summary)} for the given ids.

    Falls back gracefully when the scenes table lacks title/summary columns
    (e.g. the minimal test fixture) — returns (None, None) for every id.
    """
    if not scene_ids:
        return {}
    placeholders = ",".join("?" for _ in scene_ids)
    try:
        with open_store(root, tenant) as db:
            rows = db.execute(
                f"SELECT scene_id, title, summary FROM scenes WHERE scene_id IN ({placeholders})",
                scene_ids,
            ).fetchall()
        return {
            str(row["scene_id"]): (
                str(row["title"]) if row["title"] is not None else None,
                str(row["summary"]) if row["summary"] is not None else None,
            )
            for row in rows
        }
    except (sqlite3.OperationalError, StoreError):
        return {}


def _resolve_recall_items(
    root: Path,
    tenant: str,
    rows: list[sqlite3.Row],
    blob_dir: Path,
) -> tuple[RecallItem, ...]:
    """Resolve content for each recall_trace_items row."""
    t1_ids = tuple(str(r["item_id"]) for r in rows if str(r["tier"]) == "T1")
    t2_ids = tuple(str(r["item_id"]) for r in rows if str(r["tier"]) == "T2")

    atoms = _load_atoms(root, tenant, t1_ids) if t1_ids else {}
    scenes = _load_scene_summaries(root, tenant, t2_ids) if t2_ids else {}

    core_content: str | None = None
    core_path = blob_dir / "core.md"
    if core_path.is_file():
        text = core_path.read_text(encoding="utf-8")
        suffix = "…" if len(text) > _CONTENT_SNIPPET_LEN else ""
        core_content = text[:_CONTENT_SNIPPET_LEN] + suffix

    items: list[RecallItem] = []
    for row in rows:
        tier = str(row["tier"])
        item_id = str(row["item_id"])
        content: str | None = None
        if tier == "T1":
            av = atoms.get(item_id)
            if av and av.content:
                c = av.content
                content = c[:_CONTENT_SNIPPET_LEN] + ("…" if len(c) > _CONTENT_SNIPPET_LEN else "")
        elif tier == "T2":
            title, summary = scenes.get(item_id, (None, None))
            parts = [p for p in (title, summary) if p]
            if parts:
                raw = " — ".join(parts)
                content = (
                    raw[:_CONTENT_SNIPPET_LEN] + ("…" if len(raw) > _CONTENT_SNIPPET_LEN else "")
                )
        elif tier == "T3":
            content = core_content
        items.append(
            RecallItem(
                ordinal=int(row["ordinal"]),
                tier=tier,
                item_id=item_id,
                source=str(row["source"]),
                score=float(row["score"]) if row["score"] is not None else None,
                chars=int(row["chars"]) if row["chars"] is not None else None,
                usage=str(row["usage"]),
                content=content,
            )
        )
    return tuple(items)


def load_last_recall(root: Path, tenant: str) -> LiveRecall | None:
    """Return the most recent recall trace for this tenant, with resolved content."""
    store_key = tenant_store_key(tenant)
    _, blob_dir = store_paths(root, tenant)
    with _open_recall_traces(root) as db:
        if db is None:
            return None
        trace = db.execute(
            "SELECT * FROM recall_traces WHERE store_key=? ORDER BY created_at DESC LIMIT 1",
            (store_key,),
        ).fetchone()
        if trace is None:
            return None
        item_rows = db.execute(
            "SELECT * FROM recall_trace_items WHERE recall_id=? ORDER BY ordinal",
            (str(trace["recall_id"]),),
        ).fetchall()

    items = _resolve_recall_items(root, tenant, list(item_rows), blob_dir)
    return LiveRecall(
        recall_id=str(trace["recall_id"]),
        query=str(trace["query"]),
        mode=str(trace["mode"]) if trace["mode"] is not None else "explicit",
        created_at=str(trace["created_at"]),
        requested_budget=(
            int(trace["requested_budget"]) if trace["requested_budget"] is not None else None
        ),
        used_budget=int(trace["used_budget"]) if trace["used_budget"] is not None else None,
        items=items,
    )


def load_latest_pass(root: Path, tenant: str) -> Pass | None:
    """Return the most recent distillation pass (by started_at, rowid), fully loaded."""
    with open_store(root, tenant) as db:
        row = db.execute(
            "SELECT * FROM distillation_passes ORDER BY started_at DESC, rowid DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return _load_pass(db, row)


def load_live_state(root: Path, tenant: str) -> LiveState:
    """Bundle current summary, latest pass, and last recall for the live view."""
    summary = load_summary(root, tenant)
    latest_pass = load_latest_pass(root, tenant)
    last_recall = load_last_recall(root, tenant)
    return LiveState(summary=summary, latest_pass=latest_pass, last_recall=last_recall)


def load_scene_full_text(
    root: Path, tenant: str, scene_id: str
) -> tuple[str | None, str | None] | None:
    """Return (title, summary) for scene_id with no truncation, or None if unavailable.

    Returns None when the scene is not found, the scenes table lacks title/summary
    columns (old schema), or any read error occurs.
    """
    try:
        with open_store(root, tenant) as db:
            row = db.execute(
                "SELECT title, summary FROM scenes WHERE scene_id=?", (scene_id,)
            ).fetchone()
        if row is None:
            return None
        title = str(row["title"]) if row["title"] is not None else None
        summary = str(row["summary"]) if row["summary"] is not None else None
        return (title, summary)
    except (sqlite3.OperationalError, StoreError):
        return None


def load_core_full_text(root: Path, tenant: str) -> str | None:
    """Return the full untruncated text of core.md, or None if absent."""
    _, blob_dir = store_paths(root, tenant)
    core_path = blob_dir / "core.md"
    if not core_path.is_file():
        return None
    return core_path.read_text(encoding="utf-8")


def load_atom_full_text(root: Path, tenant: str, atom_id: str) -> str | None:
    """Return the full untruncated content of a T1 atom, or None if not found."""
    try:
        with open_store(root, tenant) as db:
            row = db.execute(
                "SELECT content FROM atoms WHERE id=?", (atom_id,)
            ).fetchone()
        if row is None or row["content"] is None:
            return None
        return str(row["content"])
    except (sqlite3.OperationalError, StoreError):
        return None
