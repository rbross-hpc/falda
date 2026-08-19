import sqlite3
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest

from falda_analysis.store import (
    StoreError,
    load_passes,
    load_summary,
    open_store,
    reconstruct_scene_membership,
    store_paths,
)


def test_load_summary(falda_root: Path) -> None:
    summary = load_summary(falda_root, "acme")
    assert summary.label == "acme:self"
    assert summary.stream_total == 2
    assert summary.stream_head_seq == 3
    assert summary.atoms == {"active": 1, "superseded": 1, "merged": 0, "archived": 0}
    assert summary.atoms_pinned == 1
    assert summary.scenes["episode_active"] == 1
    assert summary.scenes["topic_retired"] == 1
    assert summary.core_present
    assert summary.core_chars == len("# Core\nCurrent state")
    assert summary.dirty_reason == "L2/L3 incomplete"


def test_load_passes_oldest_first_and_surfaces_failures(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    assert [item.pass_id for item in passes] == ["pass-1", "pass-2", "pass-3"]
    assert passes[1].status == "failed"
    assert passes[1].likely_reconciliation
    assert passes[1].error == "core synthesis failed"
    assert passes[2].decisions[0].target_ids == ("a1",)


def test_scene_membership_reconstructs_before_and_after(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    scene = next(item for item in passes[2].scenes if item.scene_id == "episode-1")
    membership = reconstruct_scene_membership(falda_root, "acme", passes, passes[2], scene)
    assert membership.quality == "complete"
    assert [atom.atom_id for atom in membership.before] == ["a1"]
    assert [atom.atom_id for atom in membership.after] == ["a2"]
    assert membership.before[0].current_status == "superseded"
    assert membership.after[0].content == "third fact"


def test_scene_membership_missing_intervening_effect_is_partial(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    pass_two = passes[1]
    filtered_pass_two = replace(
        pass_two,
        scenes=tuple(scene for scene in pass_two.scenes if scene.scene_id != "episode-1"),
    )
    history = [passes[0], filtered_pass_two, passes[2]]
    scene = next(item for item in passes[2].scenes if item.scene_id == "episode-1")
    membership = reconstruct_scene_membership(falda_root, "acme", history, history[2], scene)
    assert membership.quality == "partial"
    assert "no effect row" in membership.message


def test_scene_membership_without_baseline_falls_back_to_delta(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    scene = next(item for item in passes[2].scenes if item.scene_id == "episode-1")
    membership = reconstruct_scene_membership(falda_root, "acme", passes[1:], passes[2], scene)
    assert membership.quality == "unavailable"
    assert membership.before == ()
    assert [atom.atom_id for atom in membership.added] == ["a2"]
    assert [atom.atom_id for atom in membership.removed] == ["a1"]


def test_missing_evidence_and_snapshots_are_explicit(falda_root: Path) -> None:
    first = load_passes(falda_root, "acme")[0]
    assert len(first.evidence) == 1
    messages = {(gap.tier, gap.message) for gap in first.gaps}
    assert ("T0", "Only 1 of 2 pass input turns remain.") in messages
    assert any(tier == "T1" and "snapshots" in message for tier, message in messages)
    assert any(tier == "T2" and "summaries" in message for tier, message in messages)
    assert any(tier == "T3" and "core text" in message for tier, message in messages)


def test_missing_effect_audit_rows_are_explicit(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    db.execute("DELETE FROM pass_scene_effects WHERE pass_id='pass-2'")
    db.commit()
    db.close()
    failed = load_passes(falda_root, "acme")[1]
    assert any(gap.tier == "T2" and "No scene effect" in gap.message for gap in failed.gaps)


def test_read_only_connection_rejects_mutation(falda_root: Path) -> None:
    with open_store(falda_root, "acme") as db, pytest.raises(sqlite3.OperationalError):
        db.execute("DELETE FROM stream")


def test_read_only_connection_sees_committed_wal_frames(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    writer = sqlite3.connect(db_path)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute(
        "INSERT INTO stream VALUES(?,?,?,?,?,?)",
        ("s4", "session", "user", "WAL turn", "2025-01-04T00:00:00Z", 4),
    )
    writer.commit()
    try:
        summary = load_summary(falda_root, "acme")
        assert summary.stream_total == 3
        assert summary.stream_head_seq == 4
    finally:
        writer.close()


def test_tenant_path_cannot_escape_root(falda_root: Path) -> None:
    with pytest.raises(StoreError):
        store_paths(falda_root, "../acme")


def test_missing_tenant_is_rejected(falda_root: Path) -> None:
    with pytest.raises(StoreError, match="does not exist"):
        load_summary(falda_root, "missing")


def test_older_schema_reports_missing_tables(tmp_path: Path) -> None:
    store = tmp_path / "tenants" / "old" / "self"
    store.mkdir(parents=True)
    sqlite3.connect(store / "falda.db").close()
    with pytest.raises(StoreError, match="required inspection tables"):
        load_passes(tmp_path, "old")


def test_recent_filter_can_return_no_passes(falda_root: Path) -> None:
    assert load_passes(falda_root, "acme", timedelta(days=1)) == []
