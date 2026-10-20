import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

from gui_debugger import roadmap_io
from gui_debugger.diagnostics import apply_records, build_record, merge_report
from tests.helpers import REAL_ROADMAP, REPO, minimal_roadmap


def record(step="s01", kind="expectation_failed", marker="m", now="2026-01-01T00:00:00Z", **kw):
	return build_record(
		checkpoint="cp.test.sample", bundles=["b.one"], roadmap_status={"b.one": "implemented"}, step=step, kind=kind,
		report={"summary": 'He said "hi"\nnext: #1', "category": "c", "suspected_bundles": ["b.one"]}, marker=marker, locator="marker:m",
		expected="x: 'y'", actual="z", error="boom # not a comment", repository_commit="abc", gui_map_digest="d", tool_version="1",
		run="run-1", log="run.jsonl", screenshot="screenshots/a.png", now=now, **kw)


class Diagnostics(unittest.TestCase):
	def test_record_shape_and_merge(self):
		r = record()
		self.assertEqual(r["state"], "open")
		self.assertEqual(r["fingerprint"], "cp.test.sample|s01|expectation_failed|m")
		self.assertEqual(r["occurrences"], 1)
		self.assertEqual(r["measured"]["target"], {"repository_commit": "abc", "gui_map_digest": "d", "tool_version": "1"})
		self.assertEqual(merge_report({"summary": "step"}, {"summary": "cp", "category": "cat", "suspected_bundles": ["b"]}),
						 {"summary": "step", "category": "cat", "suspected_bundles": ["b"]})
		with self.assertRaises(ValueError):
			record(kind="connection_error")

	def test_apply_rules(self):
		first = record(now="2026-01-01T00:00:00Z")
		again = record(now="2026-01-02T00:00:00Z")
		out = apply_records([first], [again])
		self.assertEqual(len(out), 1)
		self.assertEqual((out[0]["occurrences"], out[0]["first_seen"], out[0]["last_seen"]), (2, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"))
		# non-open record with the same fingerprint -> append, never mutate
		planned = dict(first, state="planned", resolution={"bundle_ids": ["b.fix"]})
		out = apply_records([planned], [again])
		self.assertEqual([r["state"] for r in out], ["planned", "open"])
		self.assertEqual(out[0], planned)
		out = apply_records([first], [record(step="s02")])
		self.assertEqual(len(out), 2)


class WriteProtocol(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.addCleanup(self.tmp.cleanup)
		self.path = Path(self.tmp.name, "roadmap.yaml")

	def test_only_records_change_and_round_trip(self):
		text = minimal_roadmap({"b.one": "implemented"})
		self.path.write_text(text, encoding="utf-8")
		recs = [record(), record(step="s02", kind="marker_not_found")]
		roadmap_io.write_records(self.path, lambda existing: existing + recs)
		after = self.path.read_text(encoding="utf-8")
		self.assertEqual(json.loads(json.dumps(yaml.safe_load(after)["diagnostics"]["gui_debug"]["records"])), json.loads(json.dumps(recs)))
		# text outside records region is byte-identical
		self.assertTrue(after.startswith(text.split("    records: []")[0]))
		self.assertEqual(roadmap_io.bundle_statuses(after), {"b.one": "implemented"})
		# second write keeps existing records and only touches the region
		roadmap_io.write_records(self.path, lambda existing: existing + [record(step="s03")])
		self.assertEqual(len(roadmap_io.read_records(self.path.read_text(encoding="utf-8"))), 3)

	def test_records_in_the_middle_of_a_document(self):
		text = minimal_roadmap({"b.one": "implemented"}) + "\nlater_key:\n  x: 1\n"
		self.path.write_text(text, encoding="utf-8")
		roadmap_io.write_records(self.path, lambda e: e + [record()])
		roadmap_io.write_records(self.path, lambda e: e + [record(step="s02")])
		doc = yaml.safe_load(self.path.read_text(encoding="utf-8"))
		self.assertEqual(doc["later_key"], {"x": 1})
		self.assertEqual(len(doc["diagnostics"]["gui_debug"]["records"]), 2)

	def test_concurrent_change_retries_then_succeeds(self):
		self.path.write_text(minimal_roadmap({"b.one": "implemented"}), encoding="utf-8")
		calls = {"n": 0}

		def interfere():
			calls["n"] += 1
			if calls["n"] == 1:  # roadmap.complete-style change lands between write and compare
				self.path.write_text(self.path.read_text(encoding="utf-8").replace('"implemented"', '"partial"'), encoding="utf-8")
		roadmap_io.write_records(self.path, lambda e: e + [record()], before_rename=interfere)
		final = self.path.read_text(encoding="utf-8")
		self.assertEqual(roadmap_io.bundle_statuses(final), {"b.one": "partial"})  # other writer's change kept
		self.assertEqual(len(roadmap_io.read_records(final)), 1)
		self.assertEqual(calls["n"], 2)

	def test_retry_limit_exceeded_leaves_file_untouched(self):
		self.path.write_text(minimal_roadmap({"b.one": "implemented"}), encoding="utf-8")
		counter = {"n": 0}

		def always():
			counter["n"] += 1
			self.path.write_text(self.path.read_text(encoding="utf-8") + f"# {counter['n']}\n", encoding="utf-8")
		with self.assertRaises(roadmap_io.RoadmapWriteError):
			roadmap_io.write_records(self.path, lambda e: e + [record()], retries=3, before_rename=always)
		self.assertEqual(roadmap_io.read_records(self.path.read_text(encoding="utf-8")), [])
		self.assertEqual([p.name for p in Path(self.tmp.name).iterdir()], ["roadmap.yaml"])  # no temp leftovers

	def test_missing_records_key_is_an_error(self):
		self.path.write_text("section: []\n", encoding="utf-8")
		with self.assertRaises(roadmap_io.RoadmapWriteError):
			roadmap_io.write_records(self.path, lambda e: e)

	def test_real_roadmap_edit_changes_only_records(self):
		self.path.write_text(REAL_ROADMAP.read_text(encoding="utf-8"), encoding="utf-8")
		before = yaml.safe_load(self.path.read_text(encoding="utf-8"))
		roadmap_io.write_records(self.path, lambda e: e + [record()])
		after = yaml.safe_load(self.path.read_text(encoding="utf-8"))
		self.assertEqual(before["section"], after["section"])
		self.assertEqual(before["roadmap"], after["roadmap"])
		self.assertEqual(before["future"], after["future"])
		self.assertEqual(len(after["diagnostics"]["gui_debug"]["records"]), 1)


NODE_OUT = REPO / "tools/primitive-app-editor/roadmap-mcp/out"


@unittest.skipUnless(shutil.which("node") and (NODE_OUT / "next.js").exists() and (NODE_OUT / "complete.js").exists(), "compiled roadmap Agent Tool (node + out/) required")
class RoadmapToolInterop(unittest.TestCase):
	"""Black-box check via node subprocess (the Python tool never imports roadmap-mcp)."""

	def run_node(self, script, *args):
		out = subprocess.run(["node", "-e", script, *args], capture_output=True, text=True, cwd=str(REPO / "tools/primitive-app-editor/roadmap-mcp"))
		self.assertEqual(out.returncode, 0, out.stderr)
		return out.stdout

	def test_next_unchanged_and_complete_preserves_diagnostics(self):
		with tempfile.TemporaryDirectory() as tmp:
			text = minimal_roadmap({"b.one": "not started", "b.two": "not started"})
			path = Path(tmp, "roadmap.yaml")
			path.write_text(text, encoding="utf-8")
			next_script = "const n=require('./out/next.js');const r=n.roadmapNext(process.argv[1]);console.log(JSON.stringify({id:r.id,status:r.status}))"
			before = self.run_node(next_script, str(path))
			roadmap_io.write_records(path, lambda e: e + [record()])
			self.assertEqual(self.run_node(next_script, str(path)), before)
			self.assertIn("b.one", before)
			complete_src = (NODE_OUT / "complete.js").read_text(encoding="utf-8")
			self.assertIn("exports.roadmapComplete", complete_src)
			script = ("const c=require('./out/complete.js');"
					  "const r=c.roadmapComplete(process.argv[1],{id:'b.one',status:'implemented',evidence:['e'],remaining:[]});"
					  "console.log(JSON.stringify(r))")
			self.run_node(script, str(path))
			doc = yaml.safe_load(path.read_text(encoding="utf-8"))
			self.assertEqual(doc["section"][0]["bundle"][0]["status"], "implemented")
			self.assertEqual(len(doc["diagnostics"]["gui_debug"]["records"]), 1)


if __name__ == "__main__":
	unittest.main()
