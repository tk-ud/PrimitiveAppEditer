"""Run Artifacts (GUI Debug Tool.md §13): derived / transient output under .build/."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import yaml


class RunArtifacts:
	def __init__(self, base: str | Path, run_id: str | None = None):
		self.run_id = run_id or "run-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
		self.root = Path(base) / self.run_id
		self.root.mkdir(parents=True, exist_ok=True)
		self.log_path = self.root / "run.jsonl"

	def rel(self, path: Path) -> str:
		return path.relative_to(self.root).as_posix()

	def log(self, event: str, **fields: Any) -> None:
		entry = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "event": event, **fields}
		with self.log_path.open("a", encoding="utf-8") as f:
			f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")

	def screenshot_path(self, checkpoint: str, step: str) -> Path:
		p = self.root / "screenshots" / checkpoint / f"{step}.png"
		p.parent.mkdir(parents=True, exist_ok=True)
		return p

	def write_result(self, results: list[dict[str, Any]]) -> Path:
		p = self.root / "result.yaml"
		p.write_text(yaml.safe_dump({"run": self.run_id, "checkpoints": results}, allow_unicode=True, sort_keys=False), encoding="utf-8")
		return p

	def write_pending_diagnostics(self, records: list[dict[str, Any]]) -> Path:
		p = self.root / "pending-diagnostics.yaml"
		p.write_text(yaml.safe_dump({"records": records}, allow_unicode=True, sort_keys=False), encoding="utf-8")
		return p
