"""Run control for one selected Checkpoint (GUI Debug Tool.md §10 Execution Control / §11 / §13).

GUI-library independent so the Tool window (app.py) stays a thin Qt shell. Commands run on the
worker thread; `interrupt` only sets CheckpointRun flags and is the one thread-safe entry point.
"""

from __future__ import annotations

from typing import Callable

from .runner import FAILED, FINISHED, RUNNING, STOPPED, CheckpointResult, CheckpointRun
from .session import Session


class RunController:
	def __init__(self, session: Session, *, on_steps: Callable[[list], None] = lambda _: None,
				 on_detail: Callable[[str, str], None] = lambda *_: None, on_log: Callable[[str], None] = lambda _: None,
				 on_status: Callable[[str], None] = lambda _: None):
		self.session = session
		self.on_steps, self.on_detail, self.on_log, self.on_status = on_steps, on_detail, on_log, on_status
		self.run_obj: CheckpointRun | None = None
		self._finalized = False

	def interrupt(self, name: str) -> bool:
		"""Pause / Stop while a Run is executing: set the flag only (any thread). False -> not running, queue it."""
		run = self.run_obj
		if run is None or run.state != RUNNING:
			return False
		(run.request_pause if name == "pause" else run.request_stop)()
		return True

	def select(self, checkpoint_id: str) -> None:
		prepared = self.session.prepare(checkpoint_id)
		self._finalized = False
		if isinstance(prepared, CheckpointResult):
			self.run_obj = None
			self.on_detail(f"not_applicable: {prepared.message}", "")
			return
		self.run_obj = prepared
		self.on_steps([(s.id, s.title, s.state) for s in prepared.steps])

	def run(self) -> None:
		run = self.run_obj
		if run:
			# Failed -> Run continues from the next step (only when continue_on_error allows); otherwise Run
			run.continue_after_failure() if run.state == FAILED else run.run()
			self.publish()

	def step(self) -> None:
		if self.run_obj:
			self.run_obj.step()
			self.publish()

	def pause(self) -> None:
		if self.run_obj:
			self.run_obj.pause()

	def stop(self) -> None:
		if self.run_obj:
			self.run_obj.stop()
			self.publish()

	def retry(self) -> None:
		if self.run_obj:
			self.run_obj.retry()
			self.publish()

	def publish(self) -> None:
		run = self.run_obj
		if run is None:
			return
		self.on_steps([(s.id, s.title, s.state) for s in run.steps])
		failed = next((s for s in run.steps if s.state == "failed"), None)
		if failed:
			rec = next((r for r in run.records if r["step"] == failed.id), None)
			text = f"[{failed.kind}] {failed.error}\nexpected: {failed.expected}\nactual: {failed.actual}\nmarker: {failed.marker} ({failed.locator})"
			if rec:
				text = f"report: {rec['report']}\n" + text
			shot = str(run.artifacts.root / failed.screenshot) if failed.screenshot else ""
			self.on_detail(text, shot)
		# Failed keeps the Retry opportunity: diagnostics and result.yaml are written only for a final result
		if run.state in (FINISHED, STOPPED) and not self._finalized:
			self._finalized = True
			result = run.finish()
			self.on_log(f"{run.map.checkpoint_id}: {run.state} -> {run.result}")
			self.on_status(f"diagnostics: {self.session.record(run)}")
			self.session.write_result_file([result])
