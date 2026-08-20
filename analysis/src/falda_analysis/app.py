from datetime import timedelta
from pathlib import Path

from rich.console import Group
from rich.markup import escape
from rich.table import Table
from rich.text import Text
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.screen import ModalScreen
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

from .models import AtomView, Pass, SceneEffect, SceneMembership, StoreSummary
from .store import StoreError, load_passes, load_summary, reconstruct_scene_membership


class SceneZoom(ModalScreen[None]):
    CSS = """
    SceneZoom { align: center middle; }
    #scene-zoom {
        width: 90%; height: 90%; padding: 1 2;
        border: thick $accent; background: $surface;
    }
    """
    BINDINGS = [("escape", "close", "Close"), ("q", "close", "Close")]

    def __init__(self, membership: SceneMembership) -> None:
        super().__init__()
        self.membership = membership

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="scene-zoom"):
            yield Static(_scene_zoom(self.membership))
        yield Footer()

    def action_close(self) -> None:
        self.dismiss()


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
        changed = [
            scene
            for scene in selected.scenes
            if scene.effect != "unchanged"
            or scene.summary_regenerated
            or scene.embedding_regenerated
        ]
        unchanged = [scene for scene in selected.scenes if scene not in changed]
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
