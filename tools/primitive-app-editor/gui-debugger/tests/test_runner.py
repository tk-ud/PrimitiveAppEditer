import tempfile
import unittest
from pathlib import Path

import yaml

from gui_debugger import gui_map, runner
from gui_debugger.artifacts import RunArtifacts
from gui_debugger.runner import ConnectionLost, DriverError
from tests.helpers import fresh_map


class FakeDriver:
	"""Scriptable stand-in: `world` maps alias-value -> list of element dicts."""

	def __init__(self, world=None, window_problem=None):
		self.world = world or {}
		self.window_problem = window_problem
		self.actions = []
		self.shots = []
		self.perform_error = None
		self.on_perform = None
		self.lost = False

	def _els(self, chain, item):
		if self.lost:
			raise ConnectionLost("gone")
		els = list(self.world.get(chain[-1]["value"], []))
		if item and item.get("identity"):
			els = [e for e in els if e.get("attributes", {}).get("data-pae-item") == item["identity"]]
		if item and item.get("text") is not None:
			els = [e for e in els if e.get("text", "").strip() == item["text"]]
		return els

	def count(self, chain, item):
		return len(self._els(chain, item))

	def observe(self, chain, item):
		els = self._els(chain, item)
		assert len(els) == 1
		return {"visible": True, "enabled": True, "focused": False, "text": "", "input_value": None, "attributes": {}, **els[0]}

	def item_ids(self, chain):
		return {e["attributes"]["data-pae-item"] for e in self._els(chain, None) if "data-pae-item" in e.get("attributes", {})}

	def perform(self, action, chain, item, value):
		if self.perform_error:
			raise DriverError(self.perform_error)
		self.actions.append((action, chain[-1]["value"] if chain else None, value))
		if self.on_perform:
			self.on_perform(self)

	def screenshot(self, path):
		Path(path).write_bytes(b"png")
		self.shots.append(path)

	def check_window(self, window):
		if self.lost:
			raise ConnectionLost("gone")
		return self.window_problem


class Clock:
	def __init__(self):
		self.t = 0.0

	def now(self):
		return self.t

	def sleep(self, s):
		self.t += s


UUID = "0b6c1f0e-1a2b-4c3d-8e9f-000000000001"
NEW = "11111111-2222-3333-4444-555555555555"


def el(text="Enemy", item=None, **kw):
	attrs = dict(kw.pop("attributes", {}))
	if item:
		attrs["data-pae-item"] = item
	return {"text": text, "attributes": attrs, **kw}


class RunnerBase(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.addCleanup(self.tmp.cleanup)

	def make(self, driver, mutate=None, statuses=None):
		data = fresh_map()
		if mutate:
			mutate(data["gui_map"])
		p = Path(self.tmp.name, "cp.test.sample.yaml")
		p.write_text(yaml.safe_dump(data))
		gm = gui_map.load_map(p, {"b.one"})
		clock = Clock()
		art = RunArtifacts(Path(self.tmp.name, "runs"), "run-1")
		return runner.CheckpointRun(gm, driver, art, statuses or {"b.one": "implemented"}, repository_commit="abc", tool_version="t",
									default_timeout_ms=1000, clock=clock.now, sleep=clock.sleep)

	def world(self, **over):
		w = {
			"workbench.parts.statusbar": [el()],
			"status.x": [el()],
			"registry.tree.table": [el(item=UUID), el(item=NEW)],
		}
		w.update(over)
		return w


class HappyPath(RunnerBase):
	def test_passes_with_new_item_capture_and_substitution(self):
		d = FakeDriver(self.world(**{"registry.tree.table": [el(item=UUID, attributes={"aria-selected": "true"})]}))

		def add_second(drv):
			if len(drv.world["registry.tree.table"]) == 1:
				drv.world["registry.tree.table"].append(el(item=NEW, attributes={"aria-selected": "false"}))
		d.on_perform = add_second
		run = self.make(d)
		result = run.run()
		self.assertEqual(result.result, "passed", [(s.id, s.error, s.actual) for s in result.steps])
		self.assertEqual(run.captures["new_one"], NEW)
		self.assertEqual(result.records, [])

	def test_step_mode_pauses_after_each_step(self):
		d = FakeDriver(self.world())
		run = self.make(d)
		self.assertIsNone(run.step())
		self.assertEqual((run.state, run.index), (runner.FAILED, 0))  # s01 captures new_item but nothing appeared

	def test_unsupported_precondition(self):
		for d, expected in ((FakeDriver(self.world(), window_problem="no window"), "precondition_failed"),
							(FakeDriver(self.world(**{"workbench.parts.statusbar": []})), "precondition_failed")):
			res = self.make(d).run()
			self.assertEqual(res.result, expected)
			self.assertEqual(res.records, [])  # environment results are never diagnostics

	def test_connection_error_is_not_a_diagnostic(self):
		d = FakeDriver(self.world())
		d.lost = True
		res = self.make(d).run()
		self.assertEqual(res.result, "connection_error")
		self.assertEqual(res.records, [])


class Failures(RunnerBase):
	def simple(self, step):
		def m(g):
			g["steps"] = [step]
			g["preconditions"]["markers"] = []
		return m

	def test_marker_not_found_after_timeout_with_screenshot_and_merged_report(self):
		d = FakeDriver(self.world(**{"status.x": []}))
		run = self.make(d, self.simple({"id": "s01", "action": "click", "target": "entry", "timeout_ms": 500,
										"report": {"summary": "step summary"}}))
		res = run.run()
		self.assertEqual(res.result, "failed")
		rec = res.records[0]
		self.assertEqual((rec["kind"], rec["state"], rec["step"]), ("marker_not_found", "open", "s01"))
		self.assertEqual(rec["report"], {"summary": "step summary", "category": "cat", "suspected_bundles": ["b.one"]})  # field-wise merge
		self.assertEqual(rec["measured"]["locator"], "status:status.x")
		self.assertEqual(rec["roadmap_status"], {"b.one": "implemented"})
		self.assertTrue(Path(run.artifacts.root, rec["artifacts"]["screenshot"]).exists())
		self.assertEqual(rec["measured"]["target"]["repository_commit"], "abc")

	def test_ambiguous_same_name_items_are_not_picked(self):
		d = FakeDriver(self.world(**{"registry.tree.table": [el(), el()]}))
		run = self.make(d, self.simple({"id": "s01", "action": "click", "target": "list", "item": {"text": "Enemy"}}))
		res = run.run()
		self.assertEqual(res.records[0]["kind"], "marker_ambiguous")
		self.assertEqual(d.actions, [])

	def test_expectation_failed_records_last_observation(self):
		d = FakeDriver(self.world(**{"status.x": [el(text="Project: Failed")]}))
		run = self.make(d, self.simple({"id": "s01", "action": "wait", "timeout_ms": 300,
										"expect": [{"assert": "text_contains", "target": "entry", "value": "Ready"}]}))
		res = run.run()
		rec = res.records[0]
		self.assertEqual(rec["kind"], "expectation_failed")
		self.assertIn("Ready", rec["measured"]["expected"])
		self.assertIn("Project: Failed", rec["measured"]["actual"])

	def test_expectation_waits_until_it_holds(self):
		d = FakeDriver(self.world(**{"status.x": [el(text="Project: Opening")]}))
		clock_ticks = {"n": 0}
		original = d.count

		def counting(chain, item):
			clock_ticks["n"] += 1
			if clock_ticks["n"] == 4:
				d.world["status.x"] = [el(text="Project: Ready")]
			return original(chain, item)
		d.count = counting
		run = self.make(d, self.simple({"id": "s01", "action": "wait", "timeout_ms": 5000,
										"expect": [{"assert": "text_contains", "target": "entry", "value": "Ready"}]}))
		self.assertEqual(run.run().result, "passed")

	def test_operation_error(self):
		d = FakeDriver(self.world())
		d.perform_error = "element detached"
		run = self.make(d, self.simple({"id": "s01", "action": "click", "target": "entry"}))
		res = run.run()
		self.assertEqual(res.records[0]["kind"], "operation_error")
		self.assertIn("detached", res.records[0]["measured"]["error"])

	def test_absent_and_count_do_not_raise_marker_not_found(self):
		d = FakeDriver(self.world(**{"status.x": []}))
		run = self.make(d, self.simple({"id": "s01", "action": "wait", "timeout_ms": 100,
										"expect": [{"assert": "absent", "target": "entry"}, {"assert": "count", "target": "entry", "op": "eq", "value": 0}]}))
		self.assertEqual(run.run().result, "passed")

	def test_retry_success_leaves_no_diagnostic_but_keeps_history(self):
		d = FakeDriver(self.world(**{"status.x": []}))
		run = self.make(d, self.simple({"id": "s01", "action": "click", "target": "entry", "timeout_ms": 100}))
		first = run.run()
		self.assertEqual(len(first.records), 1)
		self.assertEqual(run.state, runner.FAILED)
		d.world["status.x"] = [el()]
		res = run.retry()
		self.assertEqual(res.result, "passed")
		self.assertEqual(res.records, [])
		self.assertEqual(res.steps[0].history[0]["kind"], "marker_not_found")

	def test_stop_after_failure_keeps_observed_failure(self):
		d = FakeDriver(self.world(**{"status.x": []}))
		run = self.make(d, self.simple({"id": "s01", "action": "click", "target": "entry", "timeout_ms": 100}))
		run.run()
		run.stop()
		res = run.finish()
		self.assertEqual(res.result, "failed")
		self.assertEqual(len(res.records), 1)

	def test_stop_without_failure_is_stopped_no_diagnostics(self):
		run = self.make(FakeDriver(self.world()))
		run.stop()
		res = run.finish()
		self.assertEqual((res.result, res.records), ("stopped", []))

	def test_continue_on_error_only_when_allowed(self):
		steps = [
			{"id": "s01", "action": "click", "target": "entry", "timeout_ms": 50, "continue_on_error": True},
			{"id": "s02", "action": "screenshot"},
		]

		def m(g):
			g["steps"] = steps
			g["preconditions"]["markers"] = []
		d = FakeDriver(self.world(**{"status.x": []}))
		run = self.make(d, m)
		run.run()
		self.assertEqual(run.state, runner.FAILED)
		res = run.continue_after_failure()
		self.assertEqual(run.index, 2)
		self.assertEqual(res.result, "failed")  # failed step stays failed; later step ran
		self.assertEqual(res.steps[1].state, "passed")
		# not allowed -> no continuation
		steps[0]["continue_on_error"] = False
		d2 = FakeDriver(self.world(**{"status.x": []}))
		run2 = self.make(d2, m)
		run2.run()
		run2.continue_after_failure()
		self.assertEqual(run2.index, 0)

	def test_new_item_capture_requires_exactly_one(self):
		d = FakeDriver(self.world())
		d.on_perform = lambda drv: drv.world["registry.tree.table"].extend([el(item="a" * 8 + "-0000-0000-0000-" + "0" * 12), el(item="b" * 8 + "-0000-0000-0000-" + "0" * 12)])
		run = self.make(d, self.simple({"id": "s01", "action": "click", "target": "entry", "timeout_ms": 50,
										"capture": {"name": "n", "mode": "new_item", "target": "list"}}))
		res = run.run()
		self.assertEqual(res.records[0]["kind"], "expectation_failed")
		self.assertIn("2 new", res.records[0]["measured"]["actual"])


if __name__ == "__main__":
	unittest.main()
