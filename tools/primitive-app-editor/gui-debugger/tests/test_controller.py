import tempfile
import unittest
from pathlib import Path

import yaml

from gui_debugger import runner
from gui_debugger.controller import RunController
from gui_debugger.session import Config, Session
from tests.helpers import fresh_map, minimal_roadmap
from tests.test_runner import FakeDriver, el


class ControllerBase(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.addCleanup(self.tmp.cleanup)
		self.root = Path(self.tmp.name)

	def make(self, driver, steps, regression=True):
		data = fresh_map()
		data["gui_map"]["steps"] = steps
		data["gui_map"]["preconditions"]["markers"] = []
		data["gui_map"]["checkpoint"]["regression"] = regression
		maps = self.root / "maps"
		maps.mkdir(exist_ok=True)
		(maps / "cp.test.sample.yaml").write_text(yaml.safe_dump(data))
		self.roadmap = self.root / "roadmap.yaml"
		self.roadmap.write_text(minimal_roadmap({"b.one": "implemented"}))
		self.session = Session(Config(str(self.roadmap), str(maps), artifacts_dir=str(self.root / "runs")), driver)
		self.session.reload()
		self.ctl = RunController(self.session)
		self.ctl.select("cp.test.sample")
		return self.ctl

	def records(self):
		return yaml.safe_load(self.roadmap.read_text())["diagnostics"]["gui_debug"]["records"]

	def result_file(self):
		return yaml.safe_load((self.session.artifacts.root / "result.yaml").read_text())["checkpoints"]


def click(step_id, **kw):
	return {"id": step_id, "action": "click", "target": "entry", "timeout_ms": 50, **kw}


class ControlDuringRun(ControllerBase):
	def test_interrupt_is_refused_when_not_running(self):
		ctl = self.make(FakeDriver(self.world()), [click("s01")])
		self.assertFalse(ctl.interrupt("stop"))

	def world(self, **over):
		return {"status.x": [el()], **over}

	def test_pause_during_run_takes_effect(self):
		d = FakeDriver(self.world())
		ctl = self.make(d, [click("s01"), click("s02")])
		seen = []
		d.on_perform = lambda _: seen.append(ctl.interrupt("pause"))
		ctl.run()
		self.assertEqual(seen[0], True)
		self.assertEqual(ctl.run_obj.state, runner.PAUSED)
		self.assertEqual([s.state for s in ctl.run_obj.steps], ["passed", "pending"])

	def test_stop_during_run_takes_effect_without_diagnostics(self):
		d = FakeDriver(self.world())
		ctl = self.make(d, [click("s01"), click("s02")])
		d.on_perform = lambda _: ctl.interrupt("stop")
		ctl.run()
		self.assertEqual(ctl.run_obj.state, runner.STOPPED)
		self.assertEqual(ctl.run_obj.result, "stopped")
		self.assertEqual(self.records(), [])
		self.assertEqual(self.result_file()[0]["result"], "stopped")

	def test_stop_requested_during_failing_step_records_observed_failure(self):
		d = FakeDriver(self.world(**{"status.x": []}))
		ctl = self.make(d, [click("s01"), click("s02")])
		ctl.run_obj.driver.count = lambda chain, item, _c=d.count: (ctl.interrupt("stop"), _c(chain, item))[1]
		ctl.run()
		self.assertEqual(ctl.run_obj.state, runner.STOPPED)
		self.assertEqual([r["step"] for r in self.records()], ["s01"])


class FailedTransitions(ControllerBase):
	def test_failed_run_continues_only_with_continue_on_error(self):
		d = FakeDriver({"status.x": []})
		ctl = self.make(d, [click("s01", continue_on_error=True), {"id": "s02", "action": "screenshot"}])
		ctl.run()
		self.assertEqual(ctl.run_obj.state, runner.FAILED)
		self.assertEqual(self.records(), [])  # Retry opportunity: nothing written while Failed
		ctl.run()
		self.assertEqual(ctl.run_obj.state, runner.FINISHED)
		self.assertEqual([r["step"] for r in self.records()], ["s01"])  # skipped failure recorded at Finished
		self.assertEqual(self.result_file()[0]["result"], "failed")

	def test_failed_run_without_continue_on_error_stays_failed(self):
		ctl = self.make(FakeDriver({"status.x": []}), [click("s01"), {"id": "s02", "action": "screenshot"}])
		ctl.run()
		ctl.run()
		self.assertEqual((ctl.run_obj.state, ctl.run_obj.index), (runner.FAILED, 0))
		self.assertEqual(self.records(), [])

	def test_retry_re_resolves_marker_and_success_writes_no_diagnostics(self):
		d = FakeDriver({"status.x": []})
		ctl = self.make(d, [click("s01")])
		ctl.run()
		d.world["status.x"] = [el()]
		ctl.retry()
		self.assertEqual(ctl.run_obj.state, runner.FINISHED)
		self.assertEqual(self.records(), [])
		step = self.result_file()[0]["steps"][0]
		self.assertEqual(step["state"], "passed")
		self.assertEqual(step["failed_attempts"][0]["kind"], "marker_not_found")

	def test_failed_then_stop_writes_observed_failure(self):
		ctl = self.make(FakeDriver({"status.x": []}), [click("s01")])
		ctl.run()
		self.assertEqual(self.records(), [])
		ctl.stop()
		self.assertEqual([r["step"] for r in self.records()], ["s01"])

	def test_retry_failure_returns_to_failed_and_writes_nothing_until_final(self):
		ctl = self.make(FakeDriver({"status.x": []}), [click("s01")])
		ctl.run()
		ctl.retry()
		self.assertEqual(ctl.run_obj.state, runner.FAILED)
		self.assertEqual(self.records(), [])
		self.assertFalse((self.session.artifacts.root / "result.yaml").exists())
		ctl.stop()
		recs = self.records()
		self.assertEqual(len(recs), 1)
		self.assertEqual(recs[0]["step"], "s01")
		self.assertEqual(self.result_file()[0]["steps"][0]["failed_attempts"][0]["kind"], "marker_not_found")

	def test_final_result_is_written_once(self):
		ctl = self.make(FakeDriver({"status.x": []}), [click("s01")])
		ctl.run()
		ctl.stop()
		ctl.stop()
		self.assertEqual(len(self.records()), 1)
		self.assertEqual(self.records()[0]["occurrences"], 1)


class ResultFiles(ControllerBase):
	def test_single_checkpoint_run_writes_result_yaml(self):
		ctl = self.make(FakeDriver({"status.x": [el()]}), [click("s01")])
		ctl.run()
		res = self.result_file()
		self.assertEqual((res[0]["checkpoint"], res[0]["result"]), ("cp.test.sample", "passed"))

	def add_second_map(self, cid="cp.test.other"):
		data = fresh_map()
		data["gui_map"]["checkpoint"]["id"] = cid
		data["gui_map"]["steps"] = [click("s01")]
		data["gui_map"]["preconditions"]["markers"] = []
		(self.root / "maps" / "cp.test.other.yaml").write_text(yaml.safe_dump(data))
		self.session.reload()

	def run_single(self, cid):
		ctl = RunController(self.session)
		ctl.select(cid)
		ctl.run()
		return ctl

	def test_different_single_checkpoints_accumulate_in_one_result_yaml(self):
		self.make(FakeDriver({"status.x": [el()]}), [click("s01")])
		self.add_second_map()
		self.session.new_run_artifacts()
		self.run_single("cp.test.sample")
		self.run_single("cp.test.other")
		self.assertEqual([r["checkpoint"] for r in self.result_file()], ["cp.test.sample", "cp.test.other"])

	def test_rerun_replaces_result_and_run_jsonl_keeps_both(self):
		self.make(FakeDriver({"status.x": [el()]}), [click("s01")])
		self.add_second_map()
		self.session.new_run_artifacts()
		self.run_single("cp.test.sample")
		self.run_single("cp.test.other")
		self.session.driver.world["status.x"] = []
		self.run_single("cp.test.sample").stop()
		res = {r["checkpoint"]: r["result"] for r in self.result_file()}
		self.assertEqual(res, {"cp.test.sample": "failed", "cp.test.other": "passed"})
		log = (self.session.artifacts.root / "run.jsonl").read_text()
		self.assertGreaterEqual(log.count("cp.test.sample"), 2)
		import json
		replaced = [json.loads(l) for l in log.splitlines() if '"checkpoint_result_replaced"' in l]
		self.assertEqual(len(replaced), 1)
		self.assertEqual((replaced[0]["checkpoint"], replaced[0]["result"]), ("cp.test.sample", "passed"))
		self.assertEqual(replaced[0]["steps"][0]["id"], "s01")
		self.assertIn("message", replaced[0])

	def test_regression_run_output_unchanged(self):
		d = FakeDriver({"status.x": []})
		self.make(d, [click("s01")])
		results = self.session.regression()
		self.assertEqual([r.result for r in results], ["failed"])
		self.assertEqual(len(self.records()), 1)
		self.assertEqual(self.result_file()[0]["result"], "failed")


if __name__ == "__main__":
	unittest.main()
