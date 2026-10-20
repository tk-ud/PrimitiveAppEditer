"""GUI Debug Tool window (PySide6): Toolbar / Checkpoint List / Step List / Detail / Log / Status.

All Playwright calls run on one worker thread (sync API is thread-affine); the UI thread only sends commands.
The window never changes Bundle status (display only).
"""

from __future__ import annotations

import queue
import threading
from typing import Any, Callable

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QApplication, QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QMainWindow, QPlainTextEdit,
							   QPushButton, QSplitter, QVBoxLayout, QWidget)

from .driver import PlaywrightDriver
from .controller import RunController
from .runner import ConnectionLost
from .session import Config, Session


class Worker(QObject):
	log = Signal(str)
	rows = Signal(list)
	steps = Signal(list)
	detail = Signal(str, str)  # text, screenshot path
	status = Signal(str)

	def __init__(self, config: Config):
		super().__init__()
		self.driver = PlaywrightDriver(config.host, config.port)
		self.session = Session(config, self.driver)
		self.commands: "queue.Queue[tuple[str, Any]]" = queue.Queue()
		self.controller = RunController(self.session, on_steps=self.steps.emit, on_detail=self.detail.emit,
										on_log=self.log.emit, on_status=self.status.emit)
		self.thread = threading.Thread(target=self._loop, daemon=True)
		self.thread.start()

	def send(self, name: str, arg: Any = None) -> None:
		# Pause / Stop must not wait behind a synchronous Run: flag the running Checkpoint from the caller's thread
		if name in ("pause", "stop") and self.controller.interrupt(name):
			return
		self.commands.put((name, arg))

	def _loop(self) -> None:
		while True:
			name, arg = self.commands.get()
			try:
				getattr(self, "do_" + name)(arg)
			except ConnectionLost as e:
				self.log.emit(f"connection_error: {e}")
				self.status.emit(f"connection: lost ({e})")
			except Exception as e:  # keep the worker alive
				self.log.emit(f"error: {e!r}")

	# ---- commands ----
	def do_refresh(self, _):
		self.rows.emit(self.session.reload())
		self.status.emit(f"roadmap: {self.session.config.roadmap} | maps: {self.session.config.maps_dir} | diagnostics: {self.session.diagnostics_state}")

	def do_connect(self, _):
		self.driver.connect(self.session.config.window)
		self.log.emit(f"connected {self.session.config.host}:{self.session.config.port}")
		self.status.emit("connection: connected")

	def do_disconnect(self, _):
		self.driver.disconnect()
		self.status.emit("connection: disconnected")

	def do_select(self, checkpoint_id: str):
		self.controller.select(checkpoint_id)

	def do_run(self, _):
		self.controller.run()

	def do_step(self, _):
		self.controller.step()

	def do_pause(self, _):
		self.controller.pause()

	def do_stop(self, _):
		self.controller.stop()

	def do_retry(self, _):
		self.controller.retry()

	def do_regression(self, _):
		self.session.regression(lambda r: self.log.emit(f"regression {r.checkpoint}: {r.result}"))
		self.status.emit(f"diagnostics: {self.session.diagnostics_state}")


class MainWindow(QMainWindow):
	def __init__(self, config: Config):
		super().__init__()
		self.setWindowTitle("Primitive App Editor - GUI Debug Tool")
		self.worker = Worker(config)
		bar = QHBoxLayout()
		for label, cmd in (("Connect", "connect"), ("Disconnect", "disconnect"), ("Run", "run"), ("Step", "step"), ("Pause", "pause"),
						   ("Stop", "stop"), ("Retry", "retry"), ("Regression Run", "regression"), ("Reload", "refresh")):
			b = QPushButton(label)
			b.clicked.connect(lambda _=False, c=cmd: self.worker.send(c))
			bar.addWidget(b)
		self.checkpoints, self.steps = QListWidget(), QListWidget()
		self.detail, self.log = QPlainTextEdit(readOnly=True), QPlainTextEdit(readOnly=True)
		self.shot = QLabel("(no screenshot)")
		self.status_label = QLabel("")
		self.checkpoints.itemClicked.connect(lambda it: self.worker.send("select", it.data(Qt.UserRole)))
		split = QSplitter(Qt.Horizontal)
		split.addWidget(self.checkpoints)
		split.addWidget(self.steps)
		right = QWidget()
		rl = QVBoxLayout(right)
		rl.addWidget(self.detail)
		rl.addWidget(self.shot)
		split.addWidget(right)
		root = QWidget()
		lay = QVBoxLayout(root)
		lay.addLayout(bar)
		lay.addWidget(split, 3)
		lay.addWidget(self.log, 1)
		lay.addWidget(self.status_label)
		self.setCentralWidget(root)
		self.resize(1200, 800)
		w = self.worker
		w.rows.connect(self.on_rows)
		w.steps.connect(self.on_steps)
		w.detail.connect(self.on_detail)
		w.log.connect(self.log.appendPlainText)
		w.status.connect(self.status_label.setText)
		w.send("refresh")

	def on_rows(self, rows: list) -> None:
		self.checkpoints.clear()
		for r in rows:
			item = QListWidgetItem(f"{r.id} | {r.title} | {', '.join(r.bundles)} | {r.applicability}{' (' + r.reason + ')' if r.reason else ''}")
			item.setData(Qt.UserRole, r.id)
			self.checkpoints.addItem(item)

	def on_steps(self, steps: list) -> None:
		self.steps.clear()
		for sid, title, state in steps:
			self.steps.addItem(f"{sid} | {title} | {state}")

	def on_detail(self, text: str, shot: str) -> None:
		self.detail.setPlainText(text)
		pm = QPixmap(shot) if shot else QPixmap()
		self.shot.setPixmap(pm.scaledToWidth(480)) if not pm.isNull() else self.shot.setText("(no screenshot)")


def run_app(config: Config) -> int:
	app = QApplication.instance() or QApplication([])
	win = MainWindow(config)
	win.show()
	return app.exec()
