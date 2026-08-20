import sqlite3
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest

from falda_analysis.store import (
    StoreError,
    load_core_full_text,
    load_last_recall,
    load_latest_pass,
    load_live_state,
    load_passes,
    load_scene_full_text,
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


def test_partial_decision_rows_are_reported(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute("UPDATE distillation_passes SET candidate_count=2 WHERE pass_id='pass-3'")
        db.commit()
    finally:
        db.close()

    passes = load_passes(falda_root, "acme")
    pass_three = passes[2]
    assert pass_three.candidate_count == 2
    assert len(pass_three.decisions) == 1
    gap_messages = {(gap.tier, gap.message) for gap in pass_three.gaps}
    assert (
        "T1",
        "Only 1 of 2 decision audit rows are available.",
    ) in gap_messages


def test_null_watermark_end_has_no_evidence(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute("UPDATE distillation_passes SET watermark_end=NULL WHERE pass_id='pass-3'")
        db.commit()
    finally:
        db.close()

    passes = load_passes(falda_root, "acme")
    pass_three = passes[2]
    assert pass_three.watermark_end is None
    assert pass_three.evidence == ()


def test_deleted_atom_remains_identified_but_content_is_unavailable(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute("DELETE FROM atoms WHERE id='a2'")
        db.commit()
    finally:
        db.close()

    passes = load_passes(falda_root, "acme")
    scene = next(item for item in passes[2].scenes if item.scene_id == "episode-1")
    membership = reconstruct_scene_membership(falda_root, "acme", passes, passes[2], scene)
    after_ids = [atom.atom_id for atom in membership.after]
    assert "a2" in after_ids
    deleted = next(atom for atom in membership.after if atom.atom_id == "a2")
    assert deleted.atom_type is None
    assert deleted.content is None
    assert deleted.current_status is None


def test_scene_membership_invalid_removed_atom_is_partial(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    pass_three = passes[2]
    original_scene = next(item for item in pass_three.scenes if item.scene_id == "episode-1")
    bad_scene = replace(original_scene, removed=("nonexistent-atom",), members_after=2)
    modified_pass_three = replace(
        pass_three,
        scenes=tuple(bad_scene if s.scene_id == "episode-1" else s for s in pass_three.scenes),
    )
    history = [passes[0], passes[1], modified_pass_three]
    membership = reconstruct_scene_membership(
        falda_root, "acme", history, modified_pass_three, bad_scene
    )
    assert membership.quality == "partial"
    assert "delta does not match" in membership.message


def test_scene_membership_duplicate_added_atom_is_partial(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    pass_two = passes[1]
    original_scene = next(item for item in pass_two.scenes if item.scene_id == "episode-1")
    bad_scene = replace(
        original_scene,
        effect="updated",
        added=("a1",),
        removed=(),
        members_before=1,
        members_after=1,
    )
    modified_pass_two = replace(
        pass_two,
        scenes=tuple(bad_scene if s.scene_id == "episode-1" else s for s in pass_two.scenes),
    )
    history = [passes[0], modified_pass_two, passes[2]]
    scene_in_three = next(item for item in passes[2].scenes if item.scene_id == "episode-1")
    membership = reconstruct_scene_membership(
        falda_root, "acme", history, history[2], scene_in_three
    )
    assert membership.quality == "partial"
    assert "delta does not match" in membership.message


def test_scene_membership_after_count_mismatch_is_partial(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    pass_three = passes[2]
    original_scene = next(item for item in pass_three.scenes if item.scene_id == "episode-1")
    bad_scene = replace(original_scene, members_after=99)
    modified_pass_three = replace(
        pass_three,
        scenes=tuple(bad_scene if s.scene_id == "episode-1" else s for s in pass_three.scenes),
    )
    history = [passes[0], passes[1], modified_pass_three]
    membership = reconstruct_scene_membership(
        falda_root, "acme", history, modified_pass_three, bad_scene
    )
    assert membership.quality == "partial"
    assert "member count" in membership.message


def test_topic_scene_membership_reconstructs(falda_root: Path) -> None:
    passes = load_passes(falda_root, "acme")
    scene = next(item for item in passes[2].scenes if item.scene_id == "topic-1")
    membership = reconstruct_scene_membership(falda_root, "acme", passes, passes[2], scene)
    assert membership.quality == "complete"
    before_ids = [atom.atom_id for atom in membership.before]
    after_ids = [atom.atom_id for atom in membership.after]
    assert before_ids == after_ids
    assert "a1" in before_ids


def test_load_latest_pass_returns_newest(falda_root: Path) -> None:
    p = load_latest_pass(falda_root, "acme")
    assert p is not None
    assert p.pass_id == "pass-3"
    assert p.status == "done"
    assert len(p.decisions) == 1


def test_load_latest_pass_empty_store(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute("DELETE FROM distillation_passes")
        db.commit()
    finally:
        db.close()
    assert load_latest_pass(falda_root, "acme") is None


def test_load_last_recall_returns_most_recent(falda_root: Path) -> None:
    recall = load_last_recall(falda_root, "acme")
    assert recall is not None
    assert recall.recall_id == "recall-1"
    assert recall.query == "what do we know about the project?"
    assert recall.mode == "explicit"
    assert len(recall.items) == 3


def test_load_last_recall_resolves_t1_content(falda_root: Path) -> None:
    recall = load_last_recall(falda_root, "acme")
    assert recall is not None
    t1 = next(item for item in recall.items if item.tier == "T1")
    assert t1.item_id == "a2"
    assert t1.content is not None
    assert "third fact" in t1.content


def test_load_last_recall_resolves_t2_content(falda_root: Path) -> None:
    recall = load_last_recall(falda_root, "acme")
    assert recall is not None
    t2 = next(item for item in recall.items if item.tier == "T2")
    assert t2.item_id == "episode-1"
    assert t2.content is not None
    assert "First Episode" in t2.content


def test_load_last_recall_resolves_t3_content(falda_root: Path) -> None:
    recall = load_last_recall(falda_root, "acme")
    assert recall is not None
    t3 = next(item for item in recall.items if item.tier == "T3")
    assert t3.item_id == "core"
    assert t3.content is not None
    assert "Core" in t3.content


def test_load_last_recall_absent_db(falda_root: Path) -> None:
    (falda_root / "recall_traces.db").unlink()
    assert load_last_recall(falda_root, "acme") is None


def test_load_last_recall_no_traces_for_tenant(falda_root: Path) -> None:
    db = sqlite3.connect(falda_root / "recall_traces.db")
    try:
        db.execute("DELETE FROM recall_traces")
        db.commit()
    finally:
        db.close()
    assert load_last_recall(falda_root, "acme") is None


def test_load_live_state_bundles_all_three(falda_root: Path) -> None:
    state = load_live_state(falda_root, "acme")
    assert state.summary.label == "acme:self"
    assert state.latest_pass is not None
    assert state.latest_pass.pass_id == "pass-3"
    assert state.last_recall is not None
    assert state.last_recall.recall_id == "recall-1"


def test_load_scene_full_text_returns_untruncated(falda_root: Path) -> None:
    result = load_scene_full_text(falda_root, "acme", "episode-1")
    assert result is not None
    title, summary = result
    assert title == "First Episode"
    assert summary is not None
    assert len(summary) == 400
    assert summary == "A" * 400


def test_load_scene_full_text_unknown_scene(falda_root: Path) -> None:
    assert load_scene_full_text(falda_root, "acme", "no-such-scene") is None


def test_load_core_full_text_returns_full_content(falda_root: Path) -> None:
    text = load_core_full_text(falda_root, "acme")
    assert text is not None
    assert "Core" in text
    assert "Current state" in text


def test_load_core_full_text_absent(falda_root: Path) -> None:
    _, blob_dir = store_paths(falda_root, "acme")
    (blob_dir / "core.md").unlink()
    assert load_core_full_text(falda_root, "acme") is None


def test_load_last_recall_t2_snippet_is_truncated(falda_root: Path) -> None:
    recall = load_last_recall(falda_root, "acme")
    assert recall is not None
    t2 = next(item for item in recall.items if item.tier == "T2")
    assert t2.content is not None
    assert len(t2.content) <= 301  # 300 chars + possible "…"
    assert t2.content.endswith("…")
