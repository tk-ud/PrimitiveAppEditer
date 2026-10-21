"""Tool session: configuration, Checkpoint listing, run orchestration, diagnostics recording."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import TOOL_VERSION, applicability, roadmap_io
from .artifacts import RunArtifacts
from .diagnostics import apply_records
from .gui_map import MapEntry, load_directory
from .runner import CheckpointResult, CheckpointRun, Driver


@dataclass
class Config:
	roadmap: str
	maps_dir: str
	host: str = "127.0.0.1"
	port: int = 9222
	artifacts_dir: str = ".build/primitive-app-editor/gui-debug/runs"
	window: str | None = None


@dataclass
class CheckpointRow:
	id: str
	title: str
	bundles: list[str]
	applicability: str  # runnable | not_applicable | invalid
	reason: str
	regression: bool
	path: str


def repository_commit(cwd: str | Path) -> str:
	try:
		return subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(cwd), capture_output=True, text=True, check=True).stdout.strip()
	except (OSError, subprocess.CalledProcessError):
		return "unknown"


class Session:
	def __init__(self, config: Config, driver: Driver | None = None):
		self.config = config
		self.driver = driver
		self.entries: list[MapEntry] = []
		self.statuses: dict[str, str] = {}
		self.artifacts: RunArtifacts | None = None
		self.final_results: dict[str, CheckpointResult] = {}  # final result per Checkpoint id within the current Run Artifact
		self.diagnostics_state = "idle"
		self.commit = repository_commit(Path(config.roadmap).resolve().parent)

	def reload(self) -> list[CheckpointRow]:
		"""Re-read roadmap (status only) and GUI Maps; applicability is evaluated at each Run Start too."""
		self.statuses = roadmap_io.read_statuses(self.config.roadmap)
		self.entries = load_directory(self.config.maps_dir, set(self.statuses))
		rows: list[CheckpointRow] = []
		for e in self.entries:
			if e.gui_map is None:
				rows.append(CheckpointRow(Path(e.path).stem, "", [], "invalid", "; ".join(e.problems), False, e.path))
				continue
			state, reason = applicability.evaluate(e.gui_map, self.statuses)
			rows.append(CheckpointRow(e.gui_map.checkpoint_id, e.gui_map.title, e.gui_map.bundles, state, reason, e.gui_map.regression, e.path))
		return rows

	def _map(self, checkpoint_id: str):
		for e in self.entries:
			if e.gui_map and e.gui_map.checkpoint_id == checkpoint_id:
				return e.gui_map
		raise KeyError(checkpoint_id)

	def new_run_artifacts(self) -> RunArtifacts:
		self.artifacts = RunArtifacts(self.config.artifacts_dir)
		self.final_results = {}
		return self.artifacts

	def prepare(self, checkpoint_id: str) -> CheckpointRun | CheckpointResult:
		"""Applicability is evaluated at Run Start against the freshly read roadmap.yaml."""
		self.statuses = roadmap_io.read_statuses(self.config.roadmap)
		gm = self._map(checkpoint_id)
		state, reason = applicability.evaluate(gm, self.statuses)
		if state != "runnable":
			return CheckpointResult(checkpoint_id, "not_applicable", [], [], reason)
		artifacts = self.artifacts or self.new_run_artifacts()
		return CheckpointRun(gm, self.driver, artifacts, self.statuses, repository_commit=self.commit, tool_version=TOOL_VERSION)

	def record(self, run: CheckpointRun) -> str:
		"""Write diagnostics for a finished/stopped run (observed failures only). Returns write state."""
		if not run.records:
			self.diagnostics_state = "nothing to write"
			return self.diagnostics_state
		try:
			roadmap_io.write_records(self.config.roadmap, lambda existing: apply_records(existing, run.records))
			self.diagnostics_state = f"written {len(run.records)} record(s)"
		except roadmap_io.RoadmapWriteError as e:
			p = run.artifacts.write_pending_diagnostics(run.records)
			self.diagnostics_state = f"pending ({e}); saved {p}"
		run.records = []
		return self.diagnostics_state

	def regression(self, on_result: Callable[[CheckpointResult], None] | None = None) -> list[CheckpointResult]:
		"""Run every `regression: true` runnable Checkpoint; a Failed Checkpoint does not stop the loop."""
		results: list[CheckpointResult] = []
		self.new_run_artifacts()
		for row in self.reload():
			if row.applicability != "runnable" or not row.regression:
				continue
			prepared = self.prepare(row.id)
			if isinstance(prepared, CheckpointResult):
				result = prepared
			else:
				result = prepared.run()
				self.record(prepared)
			results.append(result)
			if on_result:
				on_result(result)
		self.write_result_file(results)
		return results

	@staticmethod
	def _result_entry(r: CheckpointResult) -> dict:
		return {"checkpoint": r.checkpoint, "result": r.result, "message": r.message,
				"steps": [{"id": s.id, "state": s.state, "kind": s.kind, "expected": s.expected, "actual": s.actual, "error": s.error, "screenshot": s.screenshot, "failed_attempts": s.history} for s in r.steps]}

	def write_result_file(self, results: list[CheckpointResult]) -> None:
		"""Add or replace the given final results in the Run Artifact's accumulated set, then write result.yaml (§13).

		A replaced older result is first logged to run.jsonl so it stays restorable."""
		if self.artifacts is None:
			return
		for r in results:
			old = self.final_results.get(r.checkpoint)
			if old is not None:
				self.artifacts.log("checkpoint_result_replaced", checkpoint=old.checkpoint, result=old.result, message=old.message,
								   steps=self._result_entry(old)["steps"])
			self.final_results[r.checkpoint] = r
		self.artifacts.write_result([self._result_entry(r) for r in self.final_results.values()])
