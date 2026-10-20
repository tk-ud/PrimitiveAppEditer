import copy
import tempfile
import unittest
from pathlib import Path

import yaml

from gui_debugger import gui_map, applicability
from gui_debugger.roadmap_io import bundle_statuses
from tests.helpers import REAL_ROADMAP, fresh_map


def problems(data, stem="cp.test.sample", known=("b.one",)):
	return gui_map.validate_map(data, stem, set(known) if known is not None else None)


class GuiMapValidation(unittest.TestCase):
	def test_valid_map(self):
		self.assertEqual(problems(fresh_map()), [])

	def expect_problem(self, mutate, fragment, **kw):
		d = fresh_map()
		mutate(d["gui_map"])
		found = problems(d, **kw)
		self.assertTrue(any(fragment in p for p in found), f"{fragment!r} not in {found}")

	def test_rejections(self):
		cases = [
			(lambda g: g["checkpoint"].update(id="cp.test.other"), "must equal the file name"),
			(lambda g: g["checkpoint"].update(bundles=["missing"]), "does not exist in roadmap.yaml"),
			(lambda g: g["checkpoint"]["condition"]["require"][0].update(bundle="missing"), "does not exist in roadmap.yaml"),
			(lambda g: g["steps"][0].update(target="nope"), "not a defined alias"),
			(lambda g: g["markers"]["entry"].update(within="nope"), "not a defined alias"),
			(lambda g: g["preconditions"].update(markers=["nope"]), "not a defined alias"),
			(lambda g: g["steps"][0]["expect"][0].update(target="nope"), "not a defined alias"),
			(lambda g: g["steps"][0]["capture"].update(target="nope"), "capture.target"),
			(lambda g: g["steps"][0]["expect"][0].update({"assert": "bogus"}), "assert must be one of"),
			(lambda g: g["steps"][0]["expect"][0].update(op="zz"), "op must be one of"),
			(lambda g: g["steps"][0]["expect"][0].update(value=-1), "integer >= 0"),
			(lambda g: g["steps"][0]["expect"][0].update(value="2"), "integer >= 0"),
			(lambda g: g["steps"][1]["expect"][0].update(op="present"), "value is forbidden"),
			(lambda g: g["steps"][1]["expect"][0].update(op="equals", value=None) or g["steps"][1]["expect"][0].pop("value"), "value (string) is required"),
			(lambda g: g["steps"][0]["expect"][0].update(item={}), "requires identity or text"),
			(lambda g: g["steps"][1].update(item={"identity": "not-a-uuid"}), "UUID"),
			(lambda g: g["steps"][0]["expect"][0].update(item={"text": "{{ inputs.missing }}"}), "not defined in inputs"),
			(lambda g: g["steps"][0]["expect"][0].update(item={"identity": "{{ captures.new_one }}"}), "earlier step capture"),
			(lambda g: g["steps"][1]["capture"] if False else g["steps"][1].update(capture={"name": "new_one", "mode": "new_item", "target": "list"}), "not unique"),
			(lambda g: g["steps"][0]["capture"].update(mode="item"), "requires item"),
			(lambda g: g["steps"][0]["capture"].update(item={"text": "x"}), "must not have item"),
			(lambda g: g["markers"].update(c={"kind": "css", "value": ".x"}), "requires justification"),
			(lambda g: g["markers"].update(r={"kind": "role", "value": "button:OK"}), "requires preconditions.locale"),
			(lambda g: g["steps"][0].update(x=10, y=20), "prohibited"),
			(lambda g: g["markers"]["list"].update(image="a.png"), "prohibited"),
			(lambda g: g["report"].update(destination="elsewhere"), "roadmap.diagnostics"),
			(lambda g: g["steps"][0].update(action="drag"), "action must be one of"),
			(lambda g: g["steps"].append(copy.deepcopy(g["steps"][0])), "duplicate step id"),
		]
		for mutate, fragment in cases:
			with self.subTest(fragment=fragment):
				self.expect_problem(mutate, fragment)

	def test_role_locator_valid_with_locale(self):
		d = fresh_map()
		d["gui_map"]["preconditions"]["locale"] = "en"
		d["gui_map"]["markers"]["r"] = {"kind": "role", "value": "button:OK"}
		self.assertEqual(problems(d), [])

	def test_directory_duplicate_ids_and_invalid_reported(self):
		with tempfile.TemporaryDirectory() as tmp:
			good = fresh_map()
			Path(tmp, "cp.test.sample.yaml").write_text(yaml.safe_dump(good))
			dup = fresh_map()
			Path(tmp, "cp.test.sample2.yaml").write_text(yaml.safe_dump(dup))  # id mismatch with file name
			Path(tmp, "cp.test.broken.yaml").write_text(": : :")
			entries = gui_map.load_directory(tmp, {"b.one"})
			by_name = {Path(e.path).name: e for e in entries}
			self.assertIsNotNone(by_name["cp.test.sample.yaml"].gui_map)
			self.assertIsNone(by_name["cp.test.sample2.yaml"].gui_map)
			self.assertIsNone(by_name["cp.test.broken.yaml"].gui_map)

	def test_shipped_maps_are_valid_against_real_roadmap(self):
		known = set(bundle_statuses(REAL_ROADMAP.read_text(encoding="utf-8")))
		entries = gui_map.load_directory(Path(__file__).resolve().parent.parent / "maps", known)
		self.assertTrue(entries)
		for e in entries:
			self.assertIsNotNone(e.gui_map, e.problems)


class Applicability(unittest.TestCase):
	def load(self):
		with tempfile.TemporaryDirectory() as tmp:
			p = Path(tmp, "cp.test.sample.yaml")
			p.write_text(yaml.safe_dump(fresh_map()))
			return gui_map.load_map(p, {"b.one"})

	def test_states(self):
		gm = self.load()
		self.assertEqual(applicability.evaluate(gm, {"b.one": "implemented"}), ("runnable", ""))
		state, reason = applicability.evaluate(gm, {"b.one": "partial"})
		self.assertEqual(state, "not_applicable")
		self.assertIn("b.one", reason)
		self.assertEqual(applicability.evaluate(gm, {})[0], "not_applicable")

	def test_partial_allowed_explicitly(self):
		gm = self.load()
		gm.require[0]["status"] = ["implemented", "partial"]
		self.assertEqual(applicability.evaluate(gm, {"b.one": "partial"})[0], "runnable")


if __name__ == "__main__":
	unittest.main()
