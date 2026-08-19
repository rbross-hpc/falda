from pathlib import Path

import pytest
from textual.widgets import Collapsible, DataTable, ListView, Select, Static

from falda_analysis.app import HistoryApp, SceneZoom

pytestmark = pytest.mark.asyncio


async def test_app_starts_at_oldest_pass_with_evidence_collapsed(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.pause()
        timeline = app.query_one("#timeline", ListView)
        assert timeline.index == 0
        assert app.selected_pass is not None
        assert app.selected_pass.pass_id == "pass-1"
        assert app.query_one(Collapsible).collapsed
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
