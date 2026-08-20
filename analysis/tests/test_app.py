import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from textual.widgets import Collapsible, DataTable, Label, ListView, Select, Static

from falda_analysis.app import HistoryApp, LiveScreen, RecallZoom, SceneZoom
from falda_analysis.store import store_paths


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


def _get_timeline_label(app: HistoryApp, index: int) -> str:
    timeline = app.query_one("#timeline", ListView)
    item = timeline.children[index]
    label = item.query_one(Label)
    return str(label.render())


async def test_done_pass_label_has_no_status_word_or_pass_id(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.pause()
        label = _get_timeline_label(app, 0)
        assert "2025-01-01T00:00:00" in label
        assert "DONE" not in label
        assert "pass-1" not in label


async def test_failed_pass_label_shows_failed(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.pause()
        label = _get_timeline_label(app, 1)
        assert "2025-01-02T00:00:00" in label
        assert "FAILED" in label
        assert "pass-2" not in label


async def test_running_pass_label_shows_running(falda_root: Path) -> None:
    db_path, _ = store_paths(falda_root, "acme")
    db = sqlite3.connect(db_path)
    try:
        db.execute(
            "INSERT INTO distillation_passes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "pass-running",
                "acme:self",
                3,
                None,
                "2025-01-04T00:00:00Z",
                None,
                "running",
                None,
                None,
                None,
                "model",
                "v1",
                "0.1.0",
            ),
        )
        db.commit()
    finally:
        db.close()

    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.pause()
        timeline = app.query_one("#timeline", ListView)
        last_index = len(timeline.children) - 1
        label = _get_timeline_label(app, last_index)
        assert "RUNNING" in label
        assert "DONE" not in label
        assert "pass-running" not in label


async def test_refresh_reloads_and_resets_to_all_first_pass(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        selector = app.query_one("#history-range", Select)
        selector.value = "day"
        await pilot.pause()
        timeline = app.query_one("#timeline", ListView)
        assert "No passes in this range" in str(timeline.children[0].query_one(Static).render())

        db_path, _ = store_paths(falda_root, "acme")
        db = sqlite3.connect(db_path)
        try:
            db.execute(
                "UPDATE distillation_passes SET started_at=? WHERE pass_id=?",
                ("2025-01-01T00:00:00Z", "pass-1"),
            )
            db.commit()
        finally:
            db.close()

        await pilot.press("r")
        await pilot.pause()

        assert selector.value == "all"
        timeline2 = app.query_one("#timeline", ListView)
        assert timeline2.index == 0
        assert app.selected_pass is not None
        assert app.selected_pass.pass_id == "pass-1"
        assert len(app.all_passes) == 3


# ─── LiveScreen tests ─────────────────────────────────────────────────────────


async def test_l_key_pushes_live_screen(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.press("l")
        await pilot.pause()
        assert isinstance(app.screen, LiveScreen)


async def test_live_escape_pops_back_to_history(falda_root: Path) -> None:
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        await pilot.press("l")
        await pilot.pause()
        assert isinstance(app.screen, LiveScreen)
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, LiveScreen)


async def test_live_screen_shows_latest_pass(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause()
        await pilot.pause()
        heading = screen.query_one("#live-pass-heading", Static)
        rendered = str(heading.render())
        assert "pass-3" in rendered


async def test_live_screen_shows_recall(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause()
        await pilot.pause()
        heading = screen.query_one("#live-recall-heading", Static)
        rendered = str(heading.render())
        assert "recall" in rendered.lower() or "what do we know" in rendered


async def test_live_screen_no_recall_db_shows_no_telemetry(falda_root: Path) -> None:
    (falda_root / "recall_traces.db").unlink()
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause()
        await pilot.pause()
        heading = screen.query_one("#live-recall-heading", Static)
        rendered = str(heading.render())
        assert "no telemetry" in rendered.lower()


async def test_live_pause_toggles(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause()
        assert not screen.paused
        await pilot.press("p")
        await pilot.pause()
        assert screen.paused
        await pilot.press("p")
        await pilot.pause()
        assert not screen.paused


async def test_live_force_poll_while_paused_reflects_changes(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause()
        await pilot.pause()

        await pilot.press("p")
        await pilot.pause()
        assert screen.paused

        db_path, _ = store_paths(falda_root, "acme")
        db = sqlite3.connect(db_path)
        try:
            db.execute(
                "INSERT INTO distillation_passes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "pass-live",
                    "acme:self",
                    3,
                    None,
                    "2025-01-04T00:00:00Z",
                    None,
                    "running",
                    None,
                    None,
                    None,
                    "model",
                    "v1",
                    "0.1.0",
                ),
            )
            db.commit()
        finally:
            db.close()

        await pilot.press("r")
        await pilot.pause(delay=0.5)

        assert screen._state is not None
        assert screen._state.latest_pass is not None
        assert screen._state.latest_pass.pass_id == "pass-live"
        assert screen._state.latest_pass.status == "running"


async def test_live_delta_marker_set_on_change(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause()
        await pilot.pause()

        await pilot.press("p")
        await pilot.pause()

        db_path, _ = store_paths(falda_root, "acme")
        db = sqlite3.connect(db_path)
        try:
            db.execute(
                "INSERT INTO distillation_passes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "pass-new",
                    "acme:self",
                    3,
                    4,
                    "2025-01-05T00:00:00Z",
                    "2025-01-05T00:01:00Z",
                    "done",
                    1,
                    1,
                    None,
                    "model",
                    "v1",
                    "0.1.0",
                ),
            )
            db.commit()
        finally:
            db.close()

        await pilot.press("r")
        await pilot.pause(delay=0.5)

        heading = screen.query_one("#live-pass-heading", Static)
        rendered = str(heading.render())
        assert "pass-new" in rendered
        assert "Δ" in rendered


# ─── Recall zoom tests ────────────────────────────────────────────────────────


async def test_recall_t2_row_opens_zoom_modal(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause(delay=0.5)

        table = screen.query_one("#live-recall", DataTable)
        table.focus()
        t2_row = next(
            row_idx
            for row_idx, row_key in enumerate(table.rows)
            if str(row_key.value) != "__empty__"
            and table.get_row(row_key)[1] == "T2"
        )
        table.move_cursor(row=t2_row)
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, RecallZoom)
        assert "T2" in app.screen._header or "episode-1" in app.screen._header


async def test_recall_t2_zoom_shows_full_untruncated_text(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test(size=(220, 50)) as pilot:
        app.push_screen(screen)
        await pilot.pause(delay=0.5)

        table = screen.query_one("#live-recall", DataTable)
        table.focus()
        t2_row = next(
            row_idx
            for row_idx, row_key in enumerate(table.rows)
            if str(row_key.value) != "__empty__"
            and table.get_row(row_key)[1] == "T2"
        )
        table.move_cursor(row=t2_row)
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, RecallZoom)
        assert app.screen._body == "A" * 400


async def test_recall_t3_row_opens_zoom_with_core_text(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause(delay=0.5)

        table = screen.query_one("#live-recall", DataTable)
        table.focus()
        t3_row = next(
            row_idx
            for row_idx, row_key in enumerate(table.rows)
            if str(row_key.value) != "__empty__"
            and table.get_row(row_key)[1] == "T3"
        )
        table.move_cursor(row=t3_row)
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, RecallZoom)
        assert "Core" in app.screen._body


async def test_recall_t1_row_does_not_open_zoom(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause(delay=0.5)

        table = screen.query_one("#live-recall", DataTable)
        table.focus()
        t1_row = next(
            row_idx
            for row_idx, row_key in enumerate(table.rows)
            if str(row_key.value) != "__empty__"
            and table.get_row(row_key)[1] == "T1"
        )
        table.move_cursor(row=t1_row)
        await pilot.press("enter")
        await pilot.pause()

        assert not isinstance(app.screen, RecallZoom)


async def test_recall_zoom_closes_with_escape(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause(delay=0.5)

        table = screen.query_one("#live-recall", DataTable)
        table.focus()
        t3_row = next(
            row_idx
            for row_idx, row_key in enumerate(table.rows)
            if str(row_key.value) != "__empty__"
            and table.get_row(row_key)[1] == "T3"
        )
        table.move_cursor(row=t3_row)
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, RecallZoom)

        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, RecallZoom)
        assert isinstance(app.screen, LiveScreen)


# ─── T2 changed-first sort tests ─────────────────────────────────────────────


def test_scene_changed_predicate() -> None:
    from falda_analysis.app import _scene_changed
    from falda_analysis.models import SceneEffect

    changed = SceneEffect("s1", "episode", "T", "updated", 1, 1, (), (), False, False)
    unchanged = SceneEffect("s2", "episode", "T", "unchanged", 1, 1, (), (), False, False)
    regen = SceneEffect("s3", "episode", "T", "unchanged", 1, 1, (), (), True, False)

    assert _scene_changed(changed) is True
    assert _scene_changed(unchanged) is False
    assert _scene_changed(regen) is True


def test_scene_changed_sort_puts_changed_first() -> None:
    from falda_analysis.app import _scene_changed
    from falda_analysis.models import SceneEffect

    scenes = [
        SceneEffect("s1", "episode", "T", "unchanged", 1, 1, (), (), False, False),
        SceneEffect("s2", "episode", "T", "updated", 1, 1, (), (), False, False),
        SceneEffect("s3", "topic", "T", "unchanged", 1, 1, (), (), True, False),
        SceneEffect("s4", "topic", "T", "unchanged", 1, 1, (), (), False, False),
    ]
    sorted_scenes = sorted(scenes, key=lambda sc: not _scene_changed(sc))
    assert _scene_changed(sorted_scenes[0]) is True
    assert _scene_changed(sorted_scenes[1]) is True
    assert _scene_changed(sorted_scenes[2]) is False
    assert _scene_changed(sorted_scenes[3]) is False


async def test_live_t2_detail_renders_with_scenes(falda_root: Path) -> None:
    screen = LiveScreen(falda_root, "acme")
    app = HistoryApp(falda_root, "acme")
    async with app.run_test() as pilot:
        app.push_screen(screen)
        await pilot.pause(delay=0.5)
        assert screen._state is not None
        assert screen._state.latest_pass is not None
        scenes = screen._state.latest_pass.scenes
        changed = [s for s in scenes if s.effect != "unchanged"]
        unchanged = [s for s in scenes if s.effect == "unchanged"]
        assert len(changed) > 0
        assert len(unchanged) > 0
        sorted_scenes = sorted(scenes, key=lambda sc: not (
            sc.effect != "unchanged" or sc.summary_regenerated or sc.embedding_regenerated
        ))
        assert sorted_scenes[0].effect != "unchanged"
