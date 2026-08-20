from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

PassStatus = Literal["running", "done", "failed"]
DecisionAction = Literal["store", "update", "merge", "skip"]
ReconstructionQuality = Literal["complete", "partial", "unavailable"]


@dataclass(frozen=True)
class StoreSummary:
    label: str
    db_path: Path
    stream_total: int
    stream_head_seq: int | None
    atoms: dict[str, int]
    atoms_pinned: int
    scenes: dict[str, int]
    core_present: bool
    core_chars: int
    dirty_reason: str | None
    dirty_marked_at: str | None


@dataclass(frozen=True)
class Decision:
    id: str
    action: DecisionAction
    candidate_type: str | None
    candidate_content: str | None
    candidate_confidence: str | None
    atom_id: str | None
    target_ids: tuple[str, ...]
    rationale: str | None
    decided_at: str


@dataclass(frozen=True)
class SceneEffect:
    scene_id: str
    scene_kind: str
    title: str | None
    effect: str
    members_before: int
    members_after: int
    added: tuple[str, ...]
    removed: tuple[str, ...]
    summary_regenerated: bool
    embedding_regenerated: bool


@dataclass(frozen=True)
class AtomView:
    atom_id: str
    atom_type: str | None
    content: str | None
    current_status: str | None


@dataclass(frozen=True)
class SceneMembership:
    scene: SceneEffect
    quality: ReconstructionQuality
    message: str
    before: tuple[AtomView, ...]
    after: tuple[AtomView, ...]
    added: tuple[AtomView, ...]
    removed: tuple[AtomView, ...]


@dataclass(frozen=True)
class CoreEffect:
    effect: str
    old_input_hash: str | None
    new_input_hash: str | None
    old_chars: int | None
    new_chars: int | None


@dataclass(frozen=True)
class EvidenceTurn:
    stream_id: str
    session_id: str
    role: str
    content: str
    timestamp: str
    seq: int


@dataclass(frozen=True)
class DataGap:
    tier: str
    message: str


@dataclass(frozen=True)
class Pass:
    pass_id: str
    store_key: str
    watermark_start: int | None
    watermark_end: int | None
    started_at: str
    completed_at: str | None
    status: PassStatus
    input_turn_count: int | None
    candidate_count: int | None
    error: str | None
    model: str | None
    prompt_version: str | None
    distiller_version: str | None
    decisions: tuple[Decision, ...] = ()
    scenes: tuple[SceneEffect, ...] = ()
    core: CoreEffect | None = None
    evidence: tuple[EvidenceTurn, ...] = ()
    gaps: tuple[DataGap, ...] = ()
    decision_counts: dict[str, int] = field(default_factory=dict)

    @property
    def likely_reconciliation(self) -> bool:
        return self.input_turn_count == 0


@dataclass(frozen=True)
class RecallItem:
    ordinal: int
    tier: str
    item_id: str
    source: str
    score: float | None
    chars: int | None
    usage: str
    content: str | None


@dataclass(frozen=True)
class LiveRecall:
    recall_id: str
    query: str
    mode: str
    created_at: str
    requested_budget: int | None
    used_budget: int | None
    items: tuple[RecallItem, ...]


@dataclass(frozen=True)
class LiveState:
    summary: StoreSummary
    latest_pass: Pass | None
    last_recall: LiveRecall | None
