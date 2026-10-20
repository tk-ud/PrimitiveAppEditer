"""End-to-end check of the CDP attach driver against a stand-in Workbench page (NOT the real Code OSS Workbench)."""

import os
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import yaml

try:
	from playwright.sync_api import sync_playwright
	HAVE_PLAYWRIGHT = True
except ImportError:
	HAVE_PLAYWRIGHT = False

from gui_debugger import gui_map, roadmap_io
from gui_debugger.runner import ConnectionLost
from gui_debugger.session import Config, Session
from tests.helpers import minimal_roadmap

CHROMIUM = os.environ.get("GUI_DEBUG_TEST_CHROMIUM") or next(iter(sorted(Path("/opt/pw-browsers").glob("chromium-*/chrome-linux/chrome"))), None)

PAGE = """<!doctype html><html><head><title>stand-in</title></head><body>
<div id="workbench.parts.statusbar"><div id="status.primitiveAppEditor.project">$(database) Project: Opening</div></div>
<div data-pae-marker="registry.tree"><button data-pae-marker="registry.tree.add-table" onclick="add()">add</button>
<ul id="list"><li data-pae-marker="registry.tree.table" data-pae-item="0b6c1f0e-1a2b-4c3d-8e9f-000000000001" aria-selected="true">Enemy</li></ul>
<input data-pae-marker="inspector.field.name" value="Enemy"></div>
<script>
 function add(){ const li=document.createElement('li'); li.setAttribute('data-pae-marker','registry.tree.table');
   li.setAttribute('data-pae-item', crypto.randomUUID()); li.setAttribute('aria-selected','false'); li.textContent='Enemy';
   li.onclick=()=>{document.querySelectorAll('li').forEach(x=>x.setAttribute('aria-selected', x===li?'true':'false'))};
   document.getElementById('list').appendChild(li); }
 setTimeout(()=>{document.getElementById('status.primitiveAppEditor.project').textContent='$(database) Project: Ready'}, 700);
</script></body></html>"""


def free_port():
	with socket.socket() as s:
		s.bind(("127.0.0.1", 0))
		return s.getsockname()[1]


@unittest.skipUnless(HAVE_PLAYWRIGHT and CHROMIUM, "Python Playwright and a Chromium binary are required")
class StandInWorkbench(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
		self.addCleanup(self.tmp.cleanup)
		tmp = Path(self.tmp.name)
		(tmp / "workbench.html").write_text(PAGE, encoding="utf-8")
		self.port = free_port()
		self.proc = subprocess.Popen([str(CHROMIUM), "--headless=new", "--no-sandbox", f"--remote-debugging-port={self.port}",
									  f"--user-data-dir={tmp / 'profile'}", (tmp / "workbench.html").as_uri()],
									 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
		self.addCleanup(self.stop_browser)
		deadline = time.time() + 20
		while time.time() < deadline:
			try:
				socket.create_connection(("127.0.0.1", self.port), timeout=0.5).close()
				break
			except OSError:
				time.sleep(0.2)
		(tmp / "roadmap.yaml").write_text(minimal_roadmap({"workbench.integration": "implemented", "workbench.project-bridge": "implemented", "b.fail": "implemented"}), encoding="utf-8")
		maps = tmp / "maps"
		maps.mkdir()
		self.maps = maps

	def stop_browser(self):
		# Chromium helper processes keep writing the profile; stop the whole group before the temp dir is removed.
		try:
			os.killpg(self.proc.pid, signal.SIGKILL)
		except ProcessLookupError:
			pass
		self.proc.wait()
		time.sleep(0.3)

	def session(self):
		from gui_debugger.driver import PlaywrightDriver
		cfg = Config(str(Path(self.tmp.name, "roadmap.yaml")), str(self.maps), "127.0.0.1", self.port, str(Path(self.tmp.name, "runs")))
		driver = PlaywrightDriver("127.0.0.1", self.port)
		driver.connect("workbench.html")
		self.addCleanup(driver.disconnect)
		return Session(cfg, driver)

	def test_shipped_project_open_checkpoint_passes_on_stand_in(self):
		shipped = Path(__file__).resolve().parent.parent / "maps" / "cp.workbench.project-open.yaml"
		data = yaml.safe_load(shipped.read_text(encoding="utf-8"))
		(self.maps / shipped.name).write_text(shipped.read_text(encoding="utf-8"))
		s = self.session()
		rows = s.reload()
		self.assertEqual([(r.id, r.applicability) for r in rows], [("cp.workbench.project-open", "runnable")])
		run = s.prepare("cp.workbench.project-open")
		result = run.run()
		self.assertEqual(result.result, "passed", [(x.id, x.error, x.actual) for x in result.steps])
		self.assertEqual(s.record(run), "nothing to write")
		self.assertTrue((run.artifacts.root / "run.jsonl").exists())

	def test_duplicate_name_flow_failure_is_recorded_in_roadmap_and_artifacts(self):
		m = {
			"gui_map": {
				"version": 1,
				"checkpoint": {"id": "cp.stand.dup", "title": "dup", "bundles": ["b.fail"], "condition": {"require": [{"bundle": "b.fail"}]}, "regression": True},
				"preconditions": {"window": "workbench.html", "markers": ["tree"]},
				"markers": {
					"tree": {"kind": "marker", "value": "registry.tree"},
					"add": {"kind": "marker", "value": "registry.tree.add-table"},
					"table": {"kind": "marker", "value": "registry.tree.table", "within": "tree"},
					"name": {"kind": "marker", "value": "inspector.field.name"},
					"missing": {"kind": "marker", "value": "does.not.exist"},
				},
				"inputs": {"uuid": "0b6c1f0e-1a2b-4c3d-8e9f-000000000001"},
				"steps": [
					{"id": "s01", "action": "click", "target": "add", "capture": {"name": "new", "mode": "new_item", "target": "table"},
					 "expect": [{"assert": "count", "target": "table", "item": {"text": "Enemy"}, "op": "eq", "value": 2}]},
					{"id": "s02", "action": "click", "target": "table", "item": {"identity": "{{ captures.new }}"},
					 "expect": [{"assert": "attribute", "target": "table", "item": {"identity": "{{ inputs.uuid }}"}, "name": "aria-selected", "op": "equals", "value": "false"},
								{"assert": "text_equals", "target": "name", "source": "input_value", "value": "Enemy"}]},
					{"id": "s03", "action": "type", "target": "name", "value": "X", "expect": [{"assert": "text_equals", "target": "name", "source": "input_value", "value": "EnemyX"}]},
					{"id": "s04", "action": "click", "target": "table", "item": {"text": "Enemy"}, "timeout_ms": 300,
					 "report": {"summary": "same-name item cannot be selected by name alone", "category": "selection"}},
					{"id": "s05", "action": "click", "target": "missing", "timeout_ms": 300},
				],
				"report": {"destination": "roadmap.diagnostics", "summary": "dup failed", "category": "registry", "suspected_bundles": ["b.fail"]},
			}
		}
		(self.maps / "cp.stand.dup.yaml").write_text(yaml.safe_dump(m))
		s = self.session()
		s.reload()
		run = s.prepare("cp.stand.dup")
		run.run()
		self.assertEqual([x.state for x in run.steps][:4], ["passed", "passed", "passed", "failed"], [(x.id, x.error, x.actual) for x in run.steps])
		self.assertEqual(run.records[0]["kind"], "marker_ambiguous")
		self.assertTrue((run.artifacts.root / run.records[0]["artifacts"]["screenshot"]).stat().st_size > 0)
		run.retry()  # still ambiguous -> same failure, still s04; history kept in Run Artifact only
		self.assertEqual(run.steps[3].history[0]["kind"], "marker_ambiguous")
		self.assertIn("written 1", s.record(run))
		doc = yaml.safe_load(Path(self.tmp.name, "roadmap.yaml").read_text(encoding="utf-8"))
		recs = doc["diagnostics"]["gui_debug"]["records"]
		self.assertEqual([r["fingerprint"] for r in recs], ["cp.stand.dup|s04|marker_ambiguous|table"])
		self.assertEqual(recs[0]["report"]["summary"], "same-name item cannot be selected by name alone")
		self.assertEqual(recs[0]["report"]["suspected_bundles"], ["b.fail"])
		self.assertEqual(roadmap_io.bundle_statuses(Path(self.tmp.name, "roadmap.yaml").read_text(encoding="utf-8"))["b.fail"], "implemented")

	def test_connection_loss_is_reported_not_recorded(self):
		shipped = Path(__file__).resolve().parent.parent / "maps" / "cp.workbench.project-open.yaml"
		(self.maps / shipped.name).write_text(shipped.read_text(encoding="utf-8"))
		s = self.session()
		s.reload()
		self.stop_browser()
		run = s.prepare("cp.workbench.project-open")
		result = run.run()
		self.assertIn(result.result, ("connection_error", "precondition_failed"))
		self.assertEqual(result.records, [])

	def test_reload_keeps_attach_and_rerun_passes(self):
		shipped = Path(__file__).resolve().parent.parent / "maps" / "cp.workbench.project-open.yaml"
		(self.maps / shipped.name).write_text(shipped.read_text(encoding="utf-8"))
		s = self.session()
		s.reload()
		self.assertEqual(s.prepare("cp.workbench.project-open").run().result, "passed")
		s.driver.page.reload()  # Window reload: the attached page object stays valid, markers re-resolve
		s.driver.page.wait_for_load_state()
		self.assertEqual(s.prepare("cp.workbench.project-open").run().result, "passed")

	def test_multiple_windows_require_explicit_selection(self):
		s = self.session()
		s.driver.page.context.new_page().goto(Path(self.tmp.name, "workbench.html").as_uri() + "?second")
		self.assertIn("2 Workbench windows", s.driver.check_window("workbench.html"))
		self.assertIsNone(s.driver.check_window("?second"))
		self.assertTrue(s.driver.page.url.endswith("?second"))
		self.assertIn("no Workbench window", s.driver.check_window("no-such-window"))

	def test_reconnect_after_disconnect(self):
		s = self.session()
		s.driver.disconnect()
		with self.assertRaises(ConnectionLost):
			s.driver.check_window(None)
		s.driver.connect("workbench.html")
		self.assertIsNone(s.driver.check_window("workbench.html"))

	def test_non_local_cdp_host_rejected(self):
		from gui_debugger.driver import PlaywrightDriver
		with self.assertRaises(ValueError):
			PlaywrightDriver("0.0.0.0", 9222)


if __name__ == "__main__":
	unittest.main()
