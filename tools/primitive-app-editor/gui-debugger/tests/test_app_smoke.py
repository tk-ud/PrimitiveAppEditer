"""Tool window construction smoke test (offscreen). Skipped without PySide6."""

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
	from PySide6.QtWidgets import QApplication
	HAVE_QT = True
except ImportError:
	HAVE_QT = False

from tests.helpers import REAL_ROADMAP, HERE


@unittest.skipUnless(HAVE_QT, "PySide6 required")
class WindowSmoke(unittest.TestCase):
	def test_window_lists_checkpoints_and_not_applicable_state(self):
		import time
		from gui_debugger.app import MainWindow
		from gui_debugger.session import Config
		app = QApplication.instance() or QApplication([])
		win = MainWindow(Config(str(REAL_ROADMAP), str(HERE / "maps")))
		deadline = time.time() + 5
		while time.time() < deadline and win.checkpoints.count() == 0:
			app.processEvents()
			time.sleep(0.05)
		self.assertEqual(win.checkpoints.count(), 1)
		self.assertIn("cp.workbench.project-open", win.checkpoints.item(0).text())
		self.assertIn("runnable", win.checkpoints.item(0).text())


if __name__ == "__main__":
	unittest.main()
