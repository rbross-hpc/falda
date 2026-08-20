from datetime import UTC, datetime, timedelta
from pathlib import Path

from rich.console import Group
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.screen import ModalScreen, Screen
from textual.widgets import (
    Collapsible,
    DataTable,
    Footer,
    Header,
    Label,
    ListItem,
    ListView,
    Select,
    Static,
)
from textual.worker import Worker

from .models import (
    AtomView,
    LiveRecall,
    LiveState,
    Pass,
    RecallItem,
    SceneEffect,
    SceneMembership,
    StoreSummary,
)
from .store import (
    StoreError,
    load_atom_full_text,
    load_core_full_text,
    load_live_state,
    load_passes,
    load_scene_full_text,
    load_summary,
    reconstruct_scene_membership,
)


class ZoomModal(ModalScreen[None]):
    """Shared modal chrome for all pop-out detail views."""
    CSS = """
    ZoomModal { align: center middle; }
    #zoom-box {
        width: 90%; height: 90%; padding: 1 2;
        border: thick $accent; background: $surface;
    }
    #zoom-title { color: $accent; text-style: bold; padding: 0 0 1 0; }
    #zoom-hint { color: $text-muted; text-style: dim; padding: 1 0 0 0; }
    """
    BINDINGS = [("escape", "close", "Close"), ("q", "close", "Close")]

    def __init__(self, title: str) -> None:
        super().__init__()
        self._title = title

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="zoom-box"):
            yield Static(self._title, id="zoom-title")
            yield from self.zoom_body()
            yield Static("esc / q  to close", id="zoom-hint")
        yield Footer()

    def zoom_body(self) -> ComposeResult:
        return
        yield  # make it a generator

    def action_close(self) -> None:
        self.dismiss()


class SceneZoom(ZoomModal):
    def __init__(self, membership: SceneMembership) -> None:
        label = membership.scene.title or membership.scene.scene_id
        super().__init__(f"{membership.scene.scene_kind} scene — {label}")
        self.membership = membership

    def zoom_body(self) -> ComposeResult:
        yield Static(_scene_zoom(self.membership))


class RecallZoom(ZoomModal):
    def __init__(self, title: str, item: "RecallItem", full_text: str | None) -> None:
        super().__init__(title)
        self._item = item
        self._full_text = full_text

    def zoom_body(self) -> ComposeResult:
        yield Static(_recall_zoom_body(self._item, self._full_text))


def _scene_changed(scene: SceneEffect) -> bool:
    return scene.effect != "unchanged" or scene.summary_regenerated or scene.embedding_regenerated


# ─── change-signature helpers ────────────────────────────────────────────────

def _pass_sig(p: Pass | None) -> tuple[object, ...]:
    if p is None:
        return ()
    return (p.pass_id, p.status, p.candidate_count, p.core.new_input_hash if p.core else None)


def _summary_sig(s: StoreSummary) -> tuple[object, ...]:
    return (
        s.atoms.get("active"),
        s.atoms.get("superseded"),
        s.atoms.get("merged"),
        s.scenes.get("episode_active"),
        s.scenes.get("topic_active"),
        s.core_chars,
        s.dirty_reason,
        s.stream_head_seq,
    )


_FLASH_DURATION = 0.8  # seconds


class LiveScreen(Screen[None]):
    CSS = """
    LiveScreen { overflow-y: auto; }
    #live-header {
        height: 3; padding: 0 1; border-bottom: solid $accent;
        background: $surface-darken-1;
    }
    #live-summary { padding: 0 1; margin: 1 0; border-bottom: dashed $accent; }
    #live-pass-heading { padding: 0 1; color: $text-muted; }
    #live-pass-detail { padding: 0 1; }
    #live-t2-heading { padding: 0 1; color: $text-muted; }
    #live-t2-changed { height: auto; max-height: 16; margin: 0 1 1 1; }
    #live-t2-unchanged { height: auto; max-height: 12; }
    #live-recall-heading { padding: 0 1; color: $text-muted; }
    #live-recall { height: auto; max-height: 20; margin: 0 1; }
    .flash { background: $warning 30%; }
    .running-label { color: $warning; }
    .failed-label { color: $error; }
    """
    BINDINGS = [
        ("p", "toggle_pause", "Pause/resume"),
        ("r", "force_poll", "Force refresh"),
        ("l", "back", "Back to history"),
        ("escape", "back", "Back to history"),
        ("q", "quit", "Quit"),
    ]

    POLL_INTERVAL = 2.0

    def __init__(self, root: Path, tenant: str) -> None:
        super().__init__()
        self.root = root
        self.tenant = tenant
        self.paused = False
        self._state: LiveState | None = None
        self._prev_pass_sig: tuple[object, ...] = ()
        self._prev_summary_sig: tuple[object, ...] = ()
        self._prev_recall_id: str | None = None
        self._first_poll = True

    def compose(self) -> ComposeResult:
        yield Static(id="live-header")
        with VerticalScroll():
            yield Static(id="live-summary")
            yield Static(id="live-pass-heading")
            yield Static(id="live-pass-detail")
            yield Static(id="live-t2-heading")
            yield DataTable(id="live-t2-changed", cursor_type="row")
            yield Collapsible(
                DataTable(id="live-t2-unchanged", cursor_type="row"),
                title="Unchanged scenes (0)",
                collapsed=True,
                id="live-t2-unchanged-section",
            )
            yield Static(id="live-recall-heading")
            yield DataTable(id="live-recall", cursor_type="row")
        yield Footer()

    def on_mount(self) -> None:
        self._trigger_poll()
        self.set_interval(self.POLL_INTERVAL, self._trigger_poll)
        self._refresh_header()

    def _refresh_header(self) -> None:
        now = datetime.now(UTC).strftime("%H:%M:%S")
        state = "PAUSED" if self.paused else "LIVE"
        self.query_one("#live-header", Static).update(
            Text.from_markup(
                f"[bold]{state}[/bold]  {self.tenant}:self  "
                f"last updated {now}  poll every {self.POLL_INTERVAL:.0f}s  "
                f"[dim]p=pause  r=refresh  l/esc=history[/dim]"
            )
        )

    def action_toggle_pause(self) -> None:
        self.paused = not self.paused
        self._refresh_header()

    def action_force_poll(self) -> None:
        self._do_poll()

    def action_back(self) -> None:
        self.dismiss()

    def _trigger_poll(self) -> None:
        if self.paused:
            return
        self._do_poll()

    def _do_poll(self) -> None:
        """Load live state in a thread worker; result applied via on_worker_state_changed."""
        root, tenant = self.root, self.tenant

        def load() -> LiveState:
            return load_live_state(root, tenant)

        self.run_worker(load, thread=True, exclusive=True, name="live-poll")

    def on_worker_state_changed(self, event: Worker.StateChanged) -> None:
        if event.worker.name != "live-poll":
            return
        from textual.worker import WorkerState

        if event.state == WorkerState.SUCCESS:
            result = event.worker.result
            if isinstance(result, LiveState):
                self._apply_state(result)
        elif event.state == WorkerState.ERROR:
            self.notify(f"Poll error: {event.worker.error}", severity="error")

    def _apply_state(self, state: LiveState) -> None:
        self._state = state
        self._refresh_header()

        new_summary_sig = _summary_sig(state.summary)
        new_pass_sig = _pass_sig(state.latest_pass)
        new_recall_id = state.last_recall.recall_id if state.last_recall else None

        summary_changed = not self._first_poll and new_summary_sig != self._prev_summary_sig
        pass_changed = not self._first_poll and new_pass_sig != self._prev_pass_sig
        recall_changed = not self._first_poll and new_recall_id != self._prev_recall_id

        self._prev_summary_sig = new_summary_sig
        self._prev_pass_sig = new_pass_sig
        self._prev_recall_id = new_recall_id
        self._first_poll = False

        summary_widget = self.query_one("#live-summary", Static)
        summary_widget.update(_live_summary(state.summary, summary_changed))
        if summary_changed:
            self._flash(summary_widget)

        pass_heading = self.query_one("#live-pass-heading", Static)
        pass_detail = self.query_one("#live-pass-detail", Static)
        pass_heading.update(_live_pass_heading(state.latest_pass, pass_changed))
        pass_detail.update(_live_pass_detail(state.latest_pass))
        self._update_live_t2(state.latest_pass)
        if pass_changed:
            self._flash(pass_heading)
            self._flash(pass_detail)
            self._flash(self.query_one("#live-t2-heading", Static))
            self._flash(self.query_one("#live-t2-changed", DataTable))

        recall_heading = self.query_one("#live-recall-heading", Static)
        recall_table = self.query_one("#live-recall", DataTable)
        recall_heading.update(_live_recall_heading(state.last_recall, recall_changed))
        _populate_recall_table(recall_table, state.last_recall)
        if recall_changed:
            self._flash(recall_heading)

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        table_id = event.data_table.id
        row_key = event.row_key.value
        if row_key is None or str(row_key) == "__empty__":
            return

        if table_id == "live-recall":
            self._on_recall_row_selected(str(row_key))
        elif table_id in {"live-t2-changed", "live-t2-unchanged"}:
            self._on_live_t2_row_selected(str(row_key))

    def _on_recall_row_selected(self, ordinal_str: str) -> None:
        if self._state is None:
            return
        recall = self._state.last_recall
        if recall is None:
            return
        item = next((i for i in recall.items if str(i.ordinal) == ordinal_str), None)
        if item is None:
            return
        if item.tier == "T1":
            full_text = load_atom_full_text(self.root, self.tenant, item.item_id)
            zoom_title = f"T1 atom  {item.item_id}"
        elif item.tier == "T2":
            result = load_scene_full_text(self.root, self.tenant, item.item_id)
            full_text = None
            if result is not None:
                title, summary = result
                full_text = "\n\n".join(p for p in (title, summary) if p) or None
            zoom_title = f"T2 scene  {item.item_id}"
        else:
            full_text = load_core_full_text(self.root, self.tenant)
            zoom_title = "T3 core  (current stored text)"
        self.app.push_screen(RecallZoom(zoom_title, item, full_text))

    def _on_live_t2_row_selected(self, scene_id: str) -> None:
        if self._state is None or self._state.latest_pass is None:
            return
        latest = self._state.latest_pass
        scene = next((s for s in latest.scenes if s.scene_id == scene_id), None)
        if scene is None:
            return
        try:
            all_passes = load_passes(self.root, self.tenant)
        except StoreError as exc:
            self.notify(str(exc), severity="error")
            return
        matched = next((p for p in all_passes if p.pass_id == latest.pass_id), None)
        if matched is None:
            self.notify("Could not locate pass for scene reconstruction.", severity="warning")
            return
        membership = reconstruct_scene_membership(
            self.root, self.tenant, all_passes, matched, scene
        )
        self.app.push_screen(SceneZoom(membership))

    def _update_live_t2(self, p: Pass | None) -> None:
        heading = self.query_one("#live-t2-heading", Static)
        changed_table = self.query_one("#live-t2-changed", DataTable)
        unchanged_table = self.query_one("#live-t2-unchanged", DataTable)
        section = self.query_one("#live-t2-unchanged-section", Collapsible)
        if p is None:
            heading.update("")
            _populate_scene_table(changed_table, [], "No pass loaded")
            _populate_scene_table(unchanged_table, [], "")
            section.title = "Unchanged scenes (0)"
            return
        changed = [s for s in p.scenes if _scene_changed(s)]
        unchanged = [s for s in p.scenes if not _scene_changed(s)]
        heading.update(
            Text(
                f"T2 scene effects — {len(changed)} changed, {len(unchanged)} unchanged. "
                "Select a row and press Enter to zoom."
            )
        )
        _populate_scene_table(changed_table, changed, "No changed scenes")
        _populate_scene_table(unchanged_table, unchanged, "No unchanged scenes")
        section.title = f"Unchanged scenes ({len(unchanged)})"
        section.collapsed = True

    def _flash(self, widget: Static | DataTable[object]) -> None:
        widget.add_class("flash")
        self.set_timer(_FLASH_DURATION, lambda: widget.remove_class("flash"))


# ─── live renderers ──────────────────────────────────────────────────────────

def _live_summary(summary: StoreSummary, changed: bool) -> Text:
    delta = " [bold yellow]Δ[/bold yellow]" if changed else ""
    dirty = (
        f"\n[bold red]DIRTY since {escape(summary.dirty_marked_at or '')}: "
        f"{escape(summary.dirty_reason or '')}[/bold red]"
        if summary.dirty_reason
        else ""
    )
    core = f"present ({summary.core_chars} chars)" if summary.core_present else "absent"
    return Text.from_markup(
        f"[bold]{escape(summary.label)}[/bold]{delta}  stream: {summary.stream_total} turns "
        f"(head seq={summary.stream_head_seq})\n"
        f"atoms: active={summary.atoms.get('active', 0)} "
        f"superseded={summary.atoms.get('superseded', 0)} "
        f"merged={summary.atoms.get('merged', 0)} "
        f"archived={summary.atoms.get('archived', 0)}\n"
        f"scenes: episodes={summary.scenes.get('episode_active', 0)}/"
        f"{summary.scenes.get('episode_retired', 0)} "
        f"topics={summary.scenes.get('topic_active', 0)}/"
        f"{summary.scenes.get('topic_retired', 0)}  "
        f"core: {escape(core)}{dirty}"
    )


def _live_pass_heading(p: Pass | None, changed: bool) -> Text:
    delta = " [bold yellow]Δ[/bold yellow]" if changed else ""
    if p is None:
        return Text.from_markup(f"[bold]Last distillation[/bold]{delta}  —  no passes yet")
    if p.status == "running":
        status_markup = "[bold yellow]RUNNING[/bold yellow]"
    elif p.status == "failed":
        status_markup = "[bold red]FAILED[/bold red]"
    else:
        status_markup = "[green]done[/green]"
    completed = f" → {p.completed_at[:19]}" if p.completed_at else ""
    return Text.from_markup(
        f"[bold]Last distillation[/bold]{delta}  {escape(p.pass_id)}  "
        f"{status_markup}  {p.started_at[:19]}{escape(completed)}"
    )


def _live_pass_detail(p: Pass | None) -> Group:
    if p is None:
        return Group()
    counts_text = "  ".join(
        f"{action}={p.decision_counts.get(action, 0)}"
        for action in ("store", "update", "merge", "skip")
    )
    from rich.console import RenderableType

    lines: list[RenderableType] = [Text(f"candidates: {p.candidate_count or 0}  {counts_text}")]
    if p.error:
        lines.append(Text(f"error: {p.error}", style="bold red"))

    t1_table = Table(title="T1 decisions", expand=True)
    t1_table.add_column("Action", width=8)
    t1_table.add_column("Content")
    t1_table.add_column("Result atom")
    t1_table.add_column("Rationale")
    if p.decisions:
        for d in p.decisions:
            content = escape(d.candidate_content or "—")
            result = escape(d.atom_id or "—")
            t1_table.add_row(d.action, content, result, escape(d.rationale or "—"))
    else:
        t1_table.add_row("—", "No decision rows", "—", "—")
    lines.append(t1_table)

    if p.core:
        core_text = (
            f"T3 core: {p.core.effect}  "
            f"{p.core.old_chars or 0} → {p.core.new_chars or 0} chars"
        )
        lines.append(Text(core_text))

    return Group(*lines)


def _live_recall_heading(recall: LiveRecall | None, changed: bool) -> Text:
    delta = " [bold yellow]Δ[/bold yellow]" if changed else ""
    if recall is None:
        return Text.from_markup(f"[bold]Last recall[/bold]{delta}  —  no telemetry available")
    budget = (
        f"budget {recall.used_budget}/{recall.requested_budget}"
        if recall.requested_budget is not None
        else "budget unknown"
    )
    return Text.from_markup(
        f"[bold]Last recall[/bold]{delta}  {escape(recall.created_at[:19])}  "
        f"mode={escape(recall.mode)}  {budget}  {len(recall.items)} items  "
        f"[dim]select any row + Enter to view full text[/dim]\n"
        f"[italic]{escape(recall.query[:120])}{'…' if len(recall.query) > 120 else ''}[/italic]"
    )


def _populate_recall_table(table: DataTable[object], recall: LiveRecall | None) -> None:
    table.clear(columns=True)
    table.add_columns("Ord", "Tier", "Source", "Score", "Chars", "Usage", "Content")
    if recall is None:
        table.add_row("—", "—", "—", "—", "—", "—", "No recall telemetry", key="__empty__")
        return
    for item in recall.items:
        score_str = f"{item.score:.3f}" if item.score is not None else "—"
        chars_str = str(item.chars) if item.chars is not None else "—"
        content_str = item.content or f"({item.item_id})"
        table.add_row(
            str(item.ordinal),
            item.tier,
            item.source,
            score_str,
            chars_str,
            item.usage,
            content_str,
            key=str(item.ordinal),
        )


def _recall_zoom_body(item: RecallItem, full_text: str | None) -> Group:
    """Rich-rendered body for the RecallZoom modal."""
    meta = Table.grid(padding=(0, 2))
    meta.add_column(style="bold")
    meta.add_column()
    meta.add_row("Tier", item.tier)
    meta.add_row("Item ID", item.item_id)
    meta.add_row("Source", item.source)
    meta.add_row("Score", f"{item.score:.4f}" if item.score is not None else "—")
    meta.add_row("Chars", str(item.chars) if item.chars is not None else "—")
    meta.add_row("Usage", item.usage)

    content_body = full_text or "(content unavailable)"
    label = {
        "T1": "Atom content",
        "T2": "Scene title & summary",
        "T3": "Core (current stored text)",
    }.get(item.tier, "Content")
    content_panel = Panel(escape(content_body), title=label, border_style="dim")

    return Group(meta, Text(""), content_panel)


class HistoryApp(App[None]):
    CSS = """
    #store-summary { height: 6; padding: 0 1; border-bottom: solid $accent; }
    #controls { height: 3; padding: 0 1; }
    #history-range { width: 24; }
    #main { height: 1fr; }
    #timeline { width: 42; border-right: solid $accent; }
    #detail-scroll { width: 1fr; padding: 0 1; }
    #t2-changed { height: auto; max-height: 18; margin: 1 0; }
    #t2-unchanged { height: auto; max-height: 14; }
    .failed { color: $error; }
    .gap { color: $warning; }
    Collapsible { margin: 1 0; }
    """
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "refresh", "Refresh"),
        ("l", "live", "Live view"),
        ("home", "first_pass", "First pass"),
        ("end", "last_pass", "Last pass"),
    ]

    def __init__(self, root: Path, tenant: str) -> None:
        super().__init__()
        self.root = root
        self.tenant = tenant
        self.summary: StoreSummary | None = None
        self.all_passes: list[Pass] = []
        self.visible_passes: list[Pass] = []
        self.selected_pass: Pass | None = None

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="store-summary")
        with Horizontal(id="controls"):
            yield Label("History: ")
            yield Select(
                [("All available", "all"), ("Last 24 hours", "day")],
                value="all",
                allow_blank=False,
                id="history-range",
            )
        with Horizontal(id="main"):
            yield ListView(id="timeline")
            with VerticalScroll(id="detail-scroll"):
                yield Static(id="comparison")
                yield Collapsible(
                    Static(id="t0-detail"),
                    title="T0 evidence (hidden by default)",
                    collapsed=True,
                    id="t0-evidence-section",
                )
                yield Static(id="t1-detail")
                yield Static(id="t2-heading")
                yield DataTable(id="t2-changed", cursor_type="row")
                yield Collapsible(
                    DataTable(id="t2-unchanged", cursor_type="row"),
                    title="Unchanged scenes (0)",
                    collapsed=True,
                    id="t2-unchanged-section",
                )
                yield Static(id="t3-detail")
                yield Static(id="gaps")
        yield Footer()

    def on_mount(self) -> None:
        self.summary = load_summary(self.root, self.tenant)
        self.all_passes = load_passes(self.root, self.tenant)
        self.query_one("#store-summary", Static).update(
            _summary(self.summary, len(self.all_passes))
        )
        self._set_visible(self.all_passes)

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id != "history-range" or not self.all_passes:
            return
        passes = (
            load_passes(self.root, self.tenant, timedelta(days=1))
            if event.value == "day"
            else self.all_passes
        )
        self._set_visible(passes)

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        index = event.list_view.index
        if index is not None and index < len(self.visible_passes):
            self._show_pass(self.visible_passes[index])

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if self.selected_pass is None or event.data_table.id not in {"t2-changed", "t2-unchanged"}:
            return
        scene_id = str(event.row_key.value)
        scene = next(
            (item for item in self.selected_pass.scenes if item.scene_id == scene_id), None
        )
        if scene is None:
            return
        membership = reconstruct_scene_membership(
            self.root, self.tenant, self.all_passes, self.selected_pass, scene
        )
        self.push_screen(SceneZoom(membership))

    def action_first_pass(self) -> None:
        timeline = self.query_one("#timeline", ListView)
        if self.visible_passes:
            timeline.index = 0

    def action_last_pass(self) -> None:
        timeline = self.query_one("#timeline", ListView)
        if self.visible_passes:
            timeline.index = len(self.visible_passes) - 1

    def action_refresh(self) -> None:
        try:
            self.summary = load_summary(self.root, self.tenant)
            self.all_passes = load_passes(self.root, self.tenant)
        except StoreError as exc:
            self.notify(str(exc), severity="error")
            return
        self.query_one("#store-summary", Static).update(
            _summary(self.summary, len(self.all_passes))
        )
        self.query_one("#history-range", Select).value = "all"
        self._set_visible(self.all_passes)

    def action_live(self) -> None:
        self.push_screen(LiveScreen(self.root, self.tenant))

    def _set_visible(self, passes: list[Pass]) -> None:
        self.visible_passes = passes
        timeline = self.query_one("#timeline", ListView)
        timeline.clear()
        if not passes:
            timeline.append(ListItem(Label("No passes in this range")))
            self._clear_detail()
            return
        for item in passes:
            if item.status == "failed":
                status = "FAILED"
            elif item.status == "running":
                status = "RUNNING"
            else:
                status = ""
            reconciliation = "  RECONCILE?" if item.likely_reconciliation else ""
            gaps = f"  {len(item.gaps)} GAPS" if item.gaps else ""
            status_part = f"  {status}" if status else ""
            label = f"{item.started_at[:19]}{status_part}{reconciliation}{gaps}"
            timeline.append(
                ListItem(
                    Label(
                        label,
                        markup=False,
                        classes="failed" if item.status == "failed" else "",
                    )
                )
            )
        timeline.index = 0
        self._show_pass(passes[0])

    def _show_pass(self, selected: Pass) -> None:
        self.selected_pass = selected
        index = self.all_passes.index(selected)
        previous = self.all_passes[index - 1] if index > 0 else None
        self.query_one("#comparison", Static).update(_comparison(selected, previous))
        self.query_one("#t0-detail", Static).update(_t0(selected))
        self.query_one("#t1-detail", Static).update(_t1(selected, previous))
        self._update_t2(selected, previous)
        self.query_one("#t3-detail", Static).update(_t3(selected, previous))
        self.query_one("#gaps", Static).update(_gaps(selected))

    def _update_t2(self, selected: Pass, previous: Pass | None) -> None:
        changed = [scene for scene in selected.scenes if _scene_changed(scene)]
        unchanged = [scene for scene in selected.scenes if not _scene_changed(scene)]
        prior = (
            f"{len(previous.scenes)} effect rows" if previous else "Unavailable: first audited pass"
        )
        self.query_one("#t2-heading", Static).update(
            Text(
                f"T2 scene effect audit — previous: {prior}; selected: "
                f"{len(changed)} changed, {len(unchanged)} unchanged. "
                "Select a row and press Enter to zoom."
            )
        )
        _populate_scene_table(
            self.query_one("#t2-changed", DataTable), changed, "No changed scenes"
        )
        _populate_scene_table(
            self.query_one("#t2-unchanged", DataTable), unchanged, "No unchanged scenes"
        )
        section = self.query_one("#t2-unchanged-section", Collapsible)
        section.title = f"Unchanged scenes ({len(unchanged)})"
        section.collapsed = True

    def _clear_detail(self) -> None:
        self.selected_pass = None
        for selector in (
            "#comparison",
            "#t0-detail",
            "#t1-detail",
            "#t2-heading",
            "#t3-detail",
            "#gaps",
        ):
            self.query_one(selector, Static).update("")
        _populate_scene_table(self.query_one("#t2-changed", DataTable), [], "No passes")
        _populate_scene_table(self.query_one("#t2-unchanged", DataTable), [], "No passes")


def _summary(summary: StoreSummary, passes: int) -> Text:
    dirty = (
        f"\nDIRTY since {summary.dirty_marked_at}: {summary.dirty_reason}"
        if summary.dirty_reason
        else ""
    )
    core = f"present ({summary.core_chars} chars)" if summary.core_present else "absent"
    return Text.from_markup(
        f"[bold]{escape(summary.label)}[/bold]  audit passes={passes}\n"
        f"stream: {summary.stream_total} turns (head seq={summary.stream_head_seq})  "
        f"atoms: active={summary.atoms['active']} superseded={summary.atoms['superseded']} "
        f"merged={summary.atoms['merged']} archived={summary.atoms['archived']} "
        f"(pinned={summary.atoms_pinned})\n"
        f"scenes: episodes={summary.scenes['episode_active']}/{summary.scenes['episode_retired']} "
        f"topics={summary.scenes['topic_active']}/{summary.scenes['topic_retired']}  core: {core}"
        f"[bold red]{escape(dirty)}[/bold red]"
    )


def _comparison(current: Pass, previous: Pass | None) -> Group:
    table = Table(title="Chronological pass comparison", expand=True)
    table.add_column("Field")
    table.add_column("Previous")
    table.add_column("Selected")
    previous_label = previous.pass_id if previous else "Unavailable: first audited pass"
    table.add_row("Pass", previous_label, current.pass_id)
    table.add_row("Started", previous.started_at if previous else "—", current.started_at)
    table.add_row("Status", previous.status if previous else "—", current.status)
    table.add_row(
        "Input turns",
        _value(previous.input_turn_count) if previous else "—",
        _value(current.input_turn_count),
    )
    table.add_row(
        "Candidates",
        _value(previous.candidate_count) if previous else "—",
        _value(current.candidate_count),
    )
    table.add_row("Watermark", _window(previous) if previous else "—", _window(current))
    if current.error:
        return Group(table, Text(f"Failure: {current.error}", style="bold red"))
    if current.likely_reconciliation:
        return Group(
            table,
            Text(
                "Likely reconciliation: zero input turns; historical dirty cause was not retained.",
                style="yellow",
            ),
        )
    return Group(table)


def _t0(item: Pass) -> Group:
    table = Table(title=f"T0 pass input ({len(item.evidence)} rows available)", expand=True)
    table.add_column("Seq", width=8)
    table.add_column("Session")
    table.add_column("Role", width=10)
    table.add_column("Content")
    for turn in item.evidence:
        content = turn.content if len(turn.content) <= 300 else f"{turn.content[:300]}…"
        table.add_row(str(turn.seq), escape(turn.session_id), escape(turn.role), escape(content))
    if not item.evidence:
        table.add_row("—", "—", "—", "No pass-window evidence available")
    return Group(table)


def _t1(item: Pass, previous: Pass | None) -> Group:
    table = Table(title="T1 decision audit", expand=True)
    table.add_column("Action", width=8)
    table.add_column("Candidate")
    table.add_column("Targets/result")
    table.add_column("Rationale")
    for decision in item.decisions:
        candidate = escape(decision.candidate_content or "Unavailable")
        targets = escape(", ".join(decision.target_ids))
        result = f" → {escape(decision.atom_id)}" if decision.atom_id else ""
        table.add_row(
            decision.action,
            candidate,
            f"{targets}{result}",
            escape(decision.rationale or "—"),
        )
    if not item.decisions:
        table.add_row("—", "No decision audit rows", "—", "—")
    before = _counts(previous) if previous else "Unavailable: first audited pass"
    return Group(
        Text(f"Previous pass decisions: {before}\nSelected pass decisions: {_counts(item)}"), table
    )


def _populate_scene_table(
    table: DataTable[object], scenes: list[SceneEffect], empty_message: str
) -> None:
    table.clear(columns=True)
    table.add_columns("Kind", "Effect", "Title", "Members", "Delta", "Regen")
    if not scenes:
        table.add_row("—", "—", empty_message, "—", "—", "—", key="__empty__")
        return
    for scene in scenes:
        regeneration = "/".join(
            label
            for label, enabled in (
                ("summary", scene.summary_regenerated),
                ("embedding", scene.embedding_regenerated),
            )
            if enabled
        )
        table.add_row(
            scene.scene_kind,
            scene.effect,
            scene.title or "Unavailable",
            f"{scene.members_before} → {scene.members_after}",
            f"+{len(scene.added)} / -{len(scene.removed)}",
            regeneration or "—",
            key=scene.scene_id,
        )


def _scene_zoom(membership: SceneMembership) -> Group:
    scene = membership.scene
    heading = Text(
        f"{scene.scene_kind} scene: {scene.title or 'Unavailable'}\n"
        f"{scene.scene_id}\n"
        f"Reconstruction: {membership.quality.upper()} — {membership.message}\n"
        "Atom status is current, not status at this pass.",
        style=("green" if membership.quality == "complete" else "yellow"),
    )
    return Group(
        heading,
        _atom_table("Before", membership.before),
        _atom_table("After", membership.after),
        _atom_table("Added (exact audit delta)", membership.added),
        _atom_table("Removed (exact audit delta)", membership.removed),
    )


def _atom_table(title: str, atoms: tuple[AtomView, ...]) -> Table:
    table = Table(title=f"{title} ({len(atoms)})", expand=True)
    table.add_column("Atom ID")
    table.add_column("Type", width=12)
    table.add_column("Current status", width=14)
    table.add_column("Content")
    if not atoms:
        table.add_row("—", "—", "—", "None")
        return table
    for atom in atoms:
        table.add_row(
            escape(atom.atom_id),
            escape(atom.atom_type or "Unavailable"),
            escape(atom.current_status or "Deleted/unavailable"),
            escape(atom.content or "Atom content unavailable"),
        )
    return table


def _t3(item: Pass, previous: Pass | None) -> Group:
    table = Table(title="T3 core effect audit", expand=True)
    table.add_column("Pass")
    table.add_column("Effect")
    table.add_column("Characters")
    table.add_column("Input hash")
    if previous and previous.core:
        table.add_row(
            "Previous", previous.core.effect, _char_delta(previous), _hash_delta(previous)
        )
    else:
        table.add_row("Previous", "Unavailable", "—", "—")
    if item.core:
        table.add_row("Selected", item.core.effect, _char_delta(item), _hash_delta(item))
    else:
        table.add_row("Selected", "Unavailable", "—", "—")
    return Group(table)


def _gaps(item: Pass) -> Group:
    title = Text("Data availability", style="bold yellow")
    lines = [Text(f"{gap.tier}: {gap.message}", style="yellow") for gap in item.gaps]
    return Group(title, *lines)


def _window(item: Pass) -> str:
    end = item.watermark_end if item.watermark_end is not None else "unknown"
    return f"({item.watermark_start or 0}, {end}]"


def _value(value: int | None) -> str:
    return str(value) if value is not None else "Unavailable"


def _counts(item: Pass | None) -> str:
    if item is None:
        return "Unavailable"
    return " ".join(
        f"{action}={item.decision_counts.get(action, 0)}"
        for action in ("store", "update", "merge", "skip")
    )


def _char_delta(item: Pass) -> str:
    if item.core is None:
        return "Unavailable"
    return f"{_value(item.core.old_chars)} → {_value(item.core.new_chars)}"


def _hash_delta(item: Pass) -> str:
    if item.core is None:
        return "Unavailable"
    old = item.core.old_input_hash[:10] if item.core.old_input_hash else "none"
    new = item.core.new_input_hash[:10] if item.core.new_input_hash else "none"
    return f"{old} → {new}"
