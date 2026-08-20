import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest
from textual.widgets import Collapsible, DataTable, ListView, Select, Static

from falda_analysis.app import HistoryApp, SceneZoom
from falda_analysis.store import store_paths

pytestmark = pytest.mark.asyncio


def _set_pass_started_at(falda_root: Path, pass_id: str, started_at: str) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute(
            "UPDATE distillation_passes SET started_at=? WHERE pass_id=?",
            (started_at, pass_id),
        )
        db.commit()
    finally:
        db.close()


async def test_app_starts_at_oldest_pass_with_evidence_collapsed(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.pause()
        timeline = app.query_one("#timeline", ListView)
        assert timeline.index == 0
        assert app.selected_pass is not None
        assert app.selected_pass.pass_id == "pass-1"
        t0_section = app.query_one("#t0-evidence-section", Collapsible)
        assert t0_section.collapsed
        t2_unchanged = app.query_one("#t2-unchanged-section", Collapsible)
        assert t2_unchanged.collapsed
        assert app.summary is not None
        assert app.summary.label == "acme:self"


async def test_app_navigates_chronologically_and_surfaces_failed_pass(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        timeline = app.query_one("#timeline", ListView)
        timeline.focus()
        await pilot.press("down")
        await pilot.pause()
        assert app.selected_pass is not None
        assert app.selected_pass.pass_id == "pass-2"
        assert app.selected_pass.status == "failed"
        assert app.selected_pass.error == "core synthesis failed"


async def test_unchanged_scenes_are_collapsed_and_changed_scene_zooms(
    falda_root: Path,
) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        timeline = app.query_one("#timeline", ListView)
        timeline.index = 2
        await pilot.pause()
        unchanged = app.query_one("#t2-unchanged-section", Collapsible)
        assert unchanged.collapsed
        assert unchanged.title == "Unchanged scenes (1)"
        changed = app.query_one("#t2-changed", DataTable)
        changed.focus()
        changed.move_cursor(row=0)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, SceneZoom)
        assert app.screen.membership.quality == "complete"
        assert [atom.atom_id for atom in app.screen.membership.before] == ["a1"]
        assert [atom.atom_id for atom in app.screen.membership.after] == ["a2"]


async def test_last_day_filter_has_explicit_empty_state(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        selector = app.query_one("#history-range", Select)
        selector.value = "day"
        await pilot.pause()
        timeline = app.query_one("#timeline", ListView)
        assert "No passes in this range" in str(timeline.children[0].query_one(Static).render())


async def test_last_day_filter_shows_recent_pass(falda_root: Path) -> None:
    now_iso = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    _set_pass_started_at(falda_root, "pass-3", now_iso)
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        selector = app.query_one("#history-range", Select)
        selector.value = "day"
        await pilot.pause()
        timeline = app.query_one("#timeline", ListView)
        assert app.selected_pass is not None
        assert app.selected_pass.pass_id == "pass-3"
        assert len(timeline.children) == 1


async def test_regenerated_unchanged_scene_is_not_hidden(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute(
            "UPDATE pass_scene_effects SET summary_regenerated=1 "
            "WHERE pass_id='pass-3' AND scene_id='topic-1'"
        )
        db.commit()
    finally:
        db.close()

    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        timeline = app.query_one("#timeline", ListView)
        timeline.index = 2
        await pilot.pause()
        changed = app.query_one("#t2-changed", DataTable)
        unchanged = app.query_one("#t2-unchanged", DataTable)
        changed_keys = {str(row_key.value) for row_key in changed.rows}
        unchanged_keys = {str(row_key.value) for row_key in unchanged.rows}
        assert "topic-1" in changed_keys
        assert "topic-1" not in unchanged_keys
        unchanged_section = app.query_one("#t2-unchanged-section", Collapsible)
        assert unchanged_section.title == "Unchanged scenes (0)"


async def test_unchanged_scene_zoom(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        timeline = app.query_one("#timeline", ListView)
        timeline.index = 2
        await pilot.pause()
        unchanged_section = app.query_one("#t2-unchanged-section", Collapsible)
        unchanged_section.collapsed = False
        await pilot.pause()
        unchanged = app.query_one("#t2-unchanged", DataTable)
        unchanged.focus()
        unchanged.move_cursor(row=0)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, SceneZoom)
        assert app.screen.membership.scene.scene_id == "topic-1"
        assert app.screen.membership.quality == "complete"


async def test_scene_zoom_closes_with_escape(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        timeline = app.query_one("#timeline", ListView)
        timeline.index = 2
        await pilot.pause()
        changed = app.query_one("#t2-changed", DataTable)
        changed.focus()
        changed.move_cursor(row=0)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, SceneZoom)
        selected_before = app.selected_pass
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, SceneZoom)
        assert app.selected_pass is selected_before


async def test_empty_scene_table_rows_are_inert(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        timeline = app.query_one("#timeline", ListView)
        timeline.index = 1
        await pilot.pause()
        changed = app.query_one("#t2-changed", DataTable)
        changed.focus()
        changed.move_cursor(row=0)
        await pilot.press("enter")
        await pilot.pause()
        assert not isinstance(app.screen, SceneZoom)
