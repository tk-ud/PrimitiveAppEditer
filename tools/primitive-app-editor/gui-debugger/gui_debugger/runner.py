"""Checkpoint execution engine (GUI Debug Tool.md §10 Execution Control / §11 Execution Result).

The engine is GUI-library independent; it drives a `Driver` (see driver.py) and is controlled
by the Tool UI (Run / Step / Pause / Stop / Retry).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from . import expectations
from .artifacts import RunArtifacts
from .diagnostics import build_record, merge_report
from .gui_map import GuiMap


class DriverError(Exception):
	"""Operation-time error (detached / not interactable ...)."""


class ConnectionLost(Exception):
	"""CDP connection unavailable / dropped."""


class Driver(Protocol):
	def count(self, chain: list[dict], item: dict | None) -> int: ...
	def observe(self, chain: list[dict], item: dict | None) -> dict: ...
	def item_ids(self, chain: list[dict]) -> set[str]: ...
	def perform(self, action: str, chain: list[dict] | None, item: dict | None, value: Any) -> None: ...
	def screenshot(self, path: str) -> None: ...
	def check_window(self, window: str | None) -> str | None: ...


IDLE, RUNNING, PAUSED, FAILED, STOPPED, FINISHED = "Idle", "Running", "Paused", "Failed", "Stopped", "Finished"


@dataclass
class StepResult:
	id: str
	title: str
	state: str = "pending"  # pending | passed | failed | skipped
	kind: str | None = None
	marker: str = ""
	locator: str = ""
	expected: str = ""
	actual: str = ""
	error: str = ""
	screenshot: str = ""
	history: list[dict] = field(default_factory=list)  # failed attempts later retried (Run Artifact only)


@dataclass
class CheckpointResult:
	checkpoint: str
	result: str  # passed | precondition_failed | connection_error | stopped | failed
	steps: list[StepResult]
	records: list[dict[str, Any]] = field(default_factory=list)
	message: str = ""


class StepFailure(Exception):
	def __init__(self, kind: str, marker: str, locator: str, expected: str, actual: str, error: str):
		super().__init__(error)
		self.kind, self.marker, self.locator, self.expected, self.actual, self.error = kind, marker, locator, expected, actual, error


class CheckpointRun:
	def __init__(self, gui_map: GuiMap, driver: Driver, artifacts: RunArtifacts, statuses: dict[str, str], *,
				 repository_commit: str = "", tool_version: str = "", default_timeout_ms: int = 5000,
				 poll_interval_s: float = 0.1, clock: Callable[[], float] = time.monotonic,
				 sleep: Callable[[float], None] = time.sleep):
		self.map, self.driver, self.artifacts, self.statuses = gui_map, driver, artifacts, statuses
		self.repository_commit, self.tool_version = repository_commit, tool_version
		self.default_timeout_ms, self.poll_interval_s, self.clock, self.sleep = default_timeout_ms, poll_interval_s, clock, sleep
		self.state = IDLE
		self.index = 0
		self.captures: dict[str, str] = {}
		self.steps = [StepResult(s["id"], s.get("title", "")) for s in gui_map.steps]
		self.records: list[dict[str, Any]] = []
		self.forced: str | None = None  # environment outcome (precondition_failed / connection_error)
		self.message = ""
		self._pause_requested = False
		self._stop_requested = False
		self._preconditions_checked = False

	# ---- chain / locator helpers ----
	def chain(self, alias: str) -> list[dict]:
		out: list[dict] = []
		cur: str | None = alias
		while cur is not None:
			m = self.map.markers[cur]
			out.append({"kind": m["kind"], "value": m["value"]})
			cur = m.get("within")
		return list(reversed(out))

	def _locator_label(self, alias: str) -> str:
		m = self.map.markers[alias]
		return f"{m['kind']}:{m['value']}"

	def _item(self, item: dict | None) -> dict | None:
		return expectations.substitute(item, self.map.inputs, self.captures) if item else None

	# ---- control ----
	def pause(self) -> None:
		self._pause_requested = True

	def stop(self) -> None:
		self._stop_requested = True
		if self.state in (PAUSED, FAILED, IDLE):
			self._finish_stopped()

	def _finish_stopped(self) -> None:
		self.state = STOPPED
		self.artifacts.log("stopped", checkpoint=self.map.checkpoint_id)

	def run(self) -> CheckpointResult:
		"""Run to completion / pause / failure (continue_on_error steps continue)."""
		if self.state in (STOPPED, FINISHED):
			return self.finish()
		self._pause_requested = False
		self.state = RUNNING
		if not self._check_preconditions():
			return self.finish()
		while self.index < len(self.steps) and self.state == RUNNING:
			if self._stop_requested:
				self._finish_stopped()
				break
			self._execute_current()
			if self._pause_requested and self.state == RUNNING and self.index < len(self.steps):
				self.state = PAUSED
		if self.state == RUNNING:
			self.state = FINISHED
		return self.finish()

	def step(self) -> CheckpointResult | None:
		"""Execute exactly one step, then Paused (or Failed / Finished)."""
		if self.state in (STOPPED, FINISHED):
			return self.finish()
		if not self._check_preconditions():
			return self.finish()
		self.state = RUNNING
		self._execute_current()
		if self.state == RUNNING:
			self.state = FINISHED if self.index >= len(self.steps) else PAUSED
		return self.finish() if self.state == FINISHED else None

	def retry(self) -> CheckpointResult:
		"""Re-run the failed step from Marker re-resolution; the failure goes to Run Artifact history only."""
		if self.state != FAILED:
			return self.finish()
		failed = self.steps[self.index]
		failed.history.append({"kind": failed.kind, "expected": failed.expected, "actual": failed.actual, "error": failed.error})
		self.records = [r for r in self.records if r["step"] != failed.id]
		failed.state, failed.kind = "pending", None
		self.state = RUNNING
		return self.run()

	def continue_after_failure(self) -> CheckpointResult:
		"""Run -> next step; only when the GUI Map allows continue_on_error for the failed step."""
		if self.state != FAILED or not self.map.steps[self.index].get("continue_on_error", False):
			return self.finish()
		self.index += 1
		self.state = RUNNING
		return self.run()

	# ---- internals ----
	def _check_preconditions(self) -> bool:
		if self._preconditions_checked:
			return True
		self._preconditions_checked = True
		pre = self.map.preconditions
		try:
			problem = self.driver.check_window(pre.get("window"))
			if problem is None:
				for alias in pre.get("markers") or []:
					if self.driver.count(self.chain(alias), None) < 1:
						problem = f"precondition marker '{alias}' ({self._locator_label(alias)}) not present"
						break
		except ConnectionLost as e:
			self.state, self.forced, self.message = STOPPED, "connection_error", str(e)
			return False
		if problem:
			self.state, self.forced, self.message = STOPPED, "precondition_failed", problem
			return False
		return True

	def _execute_current(self) -> None:
		spec = self.map.steps[self.index]
		step = self.steps[self.index]
		self.artifacts.log("step_start", checkpoint=self.map.checkpoint_id, step=spec["id"])
		try:
			self._run_step(spec)
			step.state = "passed"
			self.artifacts.log("step_passed", step=spec["id"])
			self.index += 1
		except ConnectionLost as e:
			self.state, self.forced, self.message = STOPPED, "connection_error", str(e)
			step.state = "pending"
		except StepFailure as f:
			self._record_failure(spec, step, f)
			self.state = FAILED  # paused at the failed step; Retry, or Run only when continue_on_error allows

	def _record_failure(self, spec: dict, step: StepResult, f: StepFailure) -> None:
		step.state, step.kind, step.marker, step.locator = "failed", f.kind, f.marker, f.locator
		step.expected, step.actual, step.error = f.expected, f.actual, f.error
		shot = self.artifacts.screenshot_path(self.map.checkpoint_id, spec["id"])
		try:
			self.driver.screenshot(str(shot))
			step.screenshot = self.artifacts.rel(shot)
		except Exception as e:  # screenshot is evidence only
			self.artifacts.log("screenshot_failed", error=str(e))
		self.artifacts.log("step_failed", step=spec["id"], kind=f.kind, marker=f.marker, expected=f.expected, actual=f.actual, error=f.error)
		report = merge_report(spec.get("report"), self.map.report)
		from .applicability import status_snapshot
		self.records.append(build_record(
			checkpoint=self.map.checkpoint_id, bundles=self.map.bundles,
			roadmap_status=status_snapshot(self.map, self.statuses), step=spec["id"], kind=f.kind, report=report,
			marker=f.marker, locator=f.locator, expected=f.expected, actual=f.actual, error=f.error,
			repository_commit=self.repository_commit, gui_map_digest=self.map.digest, tool_version=self.tool_version,
			run=self.artifacts.run_id, log=self.artifacts.rel(self.artifacts.log_path), screenshot=step.screenshot))

	def _wait_until(self, timeout_ms: int, probe: Callable[[], Any]) -> Any:
		"""Re-evaluate `probe` until it returns a truthy `(done, value)` or timeout; returns last value."""
		deadline = self.clock() + timeout_ms / 1000.0
		while True:
			done, value = probe()
			if done or self.clock() >= deadline:
				return done, value
			self.sleep(self.poll_interval_s)

	def _resolve_unique(self, alias: str, item: dict | None, timeout_ms: int) -> None:
		chain, item = self.chain(alias), self._item(item)

		def probe():
			n = self.driver.count(chain, item)
			return n == 1, n
		done, n = self._wait_until(timeout_ms, probe)
		if done:
			return
		if n == 0:
			raise StepFailure("marker_not_found", alias, self._locator_label(alias), "1 match", "0 matches", f"marker '{alias}' not found within {timeout_ms}ms")
		raise StepFailure("marker_ambiguous", alias, self._locator_label(alias), "1 match", f"{n} matches", f"marker '{alias}' matched {n} elements")

	def _run_step(self, spec: dict) -> None:
		timeout = int(spec.get("timeout_ms", self.default_timeout_ms))
		action, alias = spec["action"], spec.get("target")
		item = spec.get("item")
		value = expectations.substitute(spec.get("value"), self.map.inputs, self.captures)
		cap = spec.get("capture")
		before_ids: set[str] = set()
		if cap and cap["mode"] == "new_item":
			before_ids = self.driver.item_ids(self.chain(cap["target"]))
		if action == "screenshot":
			shot = self.artifacts.screenshot_path(self.map.checkpoint_id, spec["id"])
			self.driver.screenshot(str(shot))
		elif action != "wait":
			if alias:
				self._resolve_unique(alias, item, timeout)
			try:
				self.driver.perform(action, self.chain(alias) if alias else None, self._item(item), value)
			except DriverError as e:
				raise StepFailure("operation_error", alias or "", self._locator_label(alias) if alias else "", f"action {action}", "failed", str(e))
		if cap:
			self._capture(cap, before_ids, timeout)
		for exp in spec.get("expect") or []:
			self._check_expectation(exp, timeout)

	def _capture(self, cap: dict, before: set[str], timeout: int) -> None:
		alias = cap["target"]
		chain = self.chain(alias)
		if cap["mode"] == "item":
			self._resolve_unique(alias, cap["item"], timeout)
			obs = self.driver.observe(chain, self._item(cap["item"]))
			ident = (obs.get("attributes") or {}).get("data-pae-item")
			if not ident:
				raise StepFailure("expectation_failed", alias, self._locator_label(alias), "data-pae-item present", "<absent>", "captured item has no data-pae-item")
			self.captures[cap["name"]] = ident
			return

		def probe():
			new = self.driver.item_ids(chain) - before
			return len(new) >= 1, new
		_, new = self._wait_until(timeout, probe)
		if len(new) != 1:
			raise StepFailure("expectation_failed", alias, self._locator_label(alias), "exactly 1 new data-pae-item", f"{len(new)} new", f"capture '{cap['name']}': {len(new)} new items appeared")
		self.captures[cap["name"]] = next(iter(new))

	def _check_expectation(self, raw: dict, timeout: int) -> None:
		exp = expectations.substitute(raw, self.map.inputs, self.captures)
		alias, item = exp["target"], exp.get("item")
		chain = self.chain(alias)
		unique = exp["assert"] not in ("absent", "count")

		def probe():
			n = self.driver.count(chain, item)
			if unique and n != 1:
				return False, ("resolve", n, None)
			obs = self.driver.observe(chain, item) if unique else None
			ok, expected, actual = expectations.evaluate(exp, n, obs)
			return ok, ("eval", n, (expected, actual))
		done, (stage, n, detail) = self._wait_until(timeout, probe)
		if done:
			return
		label = self._locator_label(alias)
		if stage == "resolve":
			if n == 0:
				raise StepFailure("marker_not_found", alias, label, "1 match", "0 matches", f"marker '{alias}' not found within {timeout}ms")
			raise StepFailure("marker_ambiguous", alias, label, "1 match", f"{n} matches", f"marker '{alias}' matched {n} elements")
		expected, actual = detail
		raise StepFailure("expectation_failed", alias, label, expected, actual, f"expectation {exp['assert']} on '{alias}' failed")

	@property
	def result(self) -> str:
		if self.forced:
			return self.forced
		if any(s.state == "failed" for s in self.steps):
			return "failed"  # a failure observed before Stop is still a failure (recorded)
		if self.state == FINISHED:
			return "passed"
		return "stopped"

	def finish(self) -> CheckpointResult:
		return CheckpointResult(self.map.checkpoint_id, self.result, self.steps, list(self.records), self.message)
