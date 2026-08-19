import sqlite3
from pathlib import Path

import pytest


@pytest.fixture
def falda_root(tmp_path: Path) -> Path:
    store = tmp_path / "tenants" / "acme" / "self"
    blobs = store / "blobs"
    blobs.mkdir(parents=True)
    (blobs / "core.md").write_text("# Core\nCurrent state", encoding="utf-8")
    db = sqlite3.connect(store / "falda.db")
    db.executescript(
        """
        CREATE TABLE stream (
          id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, ts TEXT, seq INTEGER
        );
        CREATE TABLE atoms (
          id TEXT PRIMARY KEY, type TEXT, content TEXT, status TEXT,
          pinned INTEGER DEFAULT 0, created_at TEXT
        );
        CREATE TABLE scenes (
          scene_id TEXT PRIMARY KEY, scene_kind TEXT, status TEXT
        );
        CREATE TABLE distillation_passes (
          pass_id TEXT PRIMARY KEY, store_key TEXT, watermark_start INTEGER,
          watermark_end INTEGER, started_at TEXT, completed_at TEXT, status TEXT,
          input_turn_count INTEGER, candidate_count INTEGER, error TEXT,
          model TEXT, prompt_version TEXT, distiller_version TEXT
        );
        CREATE TABLE consolidation_decisions (
          id TEXT PRIMARY KEY, pass_id TEXT, action TEXT, atom_id TEXT, target_ids TEXT,
          rationale TEXT, decided_at TEXT, candidate_type TEXT, candidate_content TEXT,
          candidate_confidence TEXT
        );
        CREATE TABLE pass_scene_effects (
          pass_id TEXT, scene_id TEXT, scene_kind TEXT, title TEXT, effect TEXT,
          members_before INTEGER, members_after INTEGER, added_json TEXT, removed_json TEXT,
          summary_regenerated INTEGER, embedding_regenerated INTEGER
        );
        CREATE TABLE pass_core_effects (
          pass_id TEXT, effect TEXT, old_input_hash TEXT, new_input_hash TEXT,
          old_chars INTEGER, new_chars INTEGER
        );
        CREATE TABLE store_dirty (store_key TEXT PRIMARY KEY, reason TEXT, marked_at TEXT);
        """
    )
    db.executemany(
        "INSERT INTO stream VALUES(?,?,?,?,?,?)",
        [
            ("s1", "session", "user", "first fact", "2025-01-01T00:00:00Z", 1),
            ("s3", "session", "user", "third fact", "2025-01-03T00:00:00Z", 3),
        ],
    )
    db.executemany(
        "INSERT INTO atoms(id,type,content,status,pinned,created_at) VALUES(?,?,?,?,?,?)",
        [
            ("a1", "fact", "first fact", "superseded", 0, "2025-01-01T00:00:00Z"),
            ("a2", "fact", "third fact", "active", 1, "2025-01-03T00:00:00Z"),
        ],
    )
    db.executemany(
        "INSERT INTO scenes VALUES(?,?,?)",
        [("episode-1", "episode", "active"), ("topic-1", "topic", "retired")],
    )
    db.executemany(
        "INSERT INTO distillation_passes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                "pass-1",
                "acme:self",
                0,
                2,
                "2025-01-01T00:00:00Z",
                "2025-01-01T00:01:00Z",
                "done",
                2,
                1,
                None,
                "model",
                "v1",
                "0.1.0",
            ),
            (
                "pass-2",
                "acme:self",
                2,
                2,
                "2025-01-02T00:00:00Z",
                "2025-01-02T00:01:00Z",
                "failed",
                0,
                0,
                "core synthesis failed",
                "model",
                "v1",
                "0.1.0",
            ),
            (
                "pass-3",
                "acme:self",
                2,
                3,
                "2025-01-03T00:00:00Z",
                "2025-01-03T00:01:00Z",
                "done",
                1,
                1,
                None,
                "model",
                "v1",
                "0.1.0",
            ),
        ],
    )
    db.executemany(
        "INSERT INTO consolidation_decisions VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
            (
                "d1",
                "pass-1",
                "store",
                "a1",
                "[]",
                "new fact",
                "2025-01-01T00:00:30Z",
                "fact",
                "first fact",
                "high",
            ),
            (
                "d3",
                "pass-3",
                "update",
                "a2",
                '["a1"]',
                "new evidence",
                "2025-01-03T00:00:30Z",
                "fact",
                "third fact",
                "high",
            ),
        ],
    )
    db.executemany(
        "INSERT INTO pass_scene_effects VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("pass-1", "episode-1", "episode", "First", "created", 0, 1, '["a1"]', "[]", 1, 1),
            ("pass-1", "topic-1", "topic", "Stable", "created", 0, 1, '["a1"]', "[]", 1, 1),
            ("pass-2", "episode-1", "episode", "First", "unchanged", 1, 1, "[]", "[]", 0, 0),
            ("pass-2", "topic-1", "topic", "Stable", "unchanged", 1, 1, "[]", "[]", 0, 0),
            ("pass-3", "episode-1", "episode", "First", "updated", 1, 1, '["a2"]', '["a1"]', 1, 1),
            ("pass-3", "topic-1", "topic", "Stable", "unchanged", 1, 1, "[]", "[]", 0, 0),
        ],
    )
    db.executemany(
        "INSERT INTO pass_core_effects VALUES(?,?,?,?,?,?)",
        [
            ("pass-1", "regenerated", None, "hash1", 0, 10),
            ("pass-2", "failed", "hash1", "hash1", 10, 10),
            ("pass-3", "regenerated", "hash1", "hash3", 10, 20),
        ],
    )
    db.execute(
        "INSERT INTO store_dirty VALUES(?,?,?)",
        ("acme:self", "L2/L3 incomplete", "2025-01-02T00:01:00Z"),
    )
    db.commit()
    db.close()
    return tmp_path
