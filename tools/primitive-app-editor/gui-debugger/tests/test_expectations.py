import unittest

from gui_debugger import expectations as ex


class Expectations(unittest.TestCase):
	def test_normalize_and_substitute(self):
		self.assertEqual(ex.normalize_text("  a \n  b\t c "), "a b c")
		self.assertEqual(ex.substitute({"v": "{{ inputs.a }}-{{captures.b}}"}, {"a": 1}, {"b": "x"}), {"v": "1-x"})

	def test_text(self):
		obs = {"text": "  Project:   Ready ", "input_value": "Enemy"}
		self.assertTrue(ex.evaluate({"assert": "text_equals", "value": "Project: Ready"}, 1, obs)[0])
		self.assertFalse(ex.evaluate({"assert": "text_equals", "value": "project: ready"}, 1, obs)[0])  # case sensitive
		self.assertTrue(ex.evaluate({"assert": "text_contains", "value": "Ready"}, 1, obs)[0])
		self.assertTrue(ex.evaluate({"assert": "text_equals", "source": "input_value", "value": "Enemy"}, 1, obs)[0])

	def test_flags(self):
		self.assertTrue(ex.evaluate({"assert": "visible"}, 1, {"visible": True})[0])
		self.assertTrue(ex.evaluate({"assert": "hidden"}, 1, {"visible": False})[0])
		self.assertTrue(ex.evaluate({"assert": "disabled"}, 1, {"enabled": False})[0])
		self.assertFalse(ex.evaluate({"assert": "focused"}, 1, {"focused": False})[0])

	def test_attribute(self):
		obs = {"attributes": {"aria-selected": "true", "x": ""}}
		f = lambda **kw: ex.evaluate({"assert": "attribute", "name": "aria-selected", **kw}, 1, obs)[0]
		self.assertTrue(f(op="equals", value="true"))
		self.assertTrue(f(op="contains", value="ru"))
		self.assertTrue(f(op="present"))
		self.assertFalse(f(op="absent"))
		self.assertTrue(ex.evaluate({"assert": "attribute", "name": "nope", "op": "absent"}, 1, obs)[0])
		self.assertTrue(ex.evaluate({"assert": "attribute", "name": "x", "op": "present"}, 1, obs)[0])

	def test_count_and_absent(self):
		for op, value, count, ok in (("eq", 2, 2, True), ("ne", 2, 2, False), ("ge", 2, 3, True), ("gt", 2, 2, False), ("le", 2, 2, True), ("lt", 2, 2, False)):
			self.assertEqual(ex.evaluate({"assert": "count", "op": op, "value": value}, count, None)[0], ok, (op, value, count))
		self.assertTrue(ex.evaluate({"assert": "absent"}, 0, None)[0])
		self.assertFalse(ex.evaluate({"assert": "absent"}, 1, None)[0])


if __name__ == "__main__":
	unittest.main()
