"""Launch settings only (GUI Debug Tool.md §5). Run / Step / Pause / Stop / Retry are GUI operations."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .session import Config

HERE = Path(__file__).resolve().parent.parent
REPO = HERE.parent.parent.parent


def parse_args(argv: list[str] | None = None) -> Config:
	p = argparse.ArgumentParser(prog="gui_debugger", description="Roadmap Driven GUI Debug Tool (launches the Tool window).")
	p.add_argument("--roadmap", default=str(REPO / "docs/primitive-app-editor/roadmap.yaml"))
	p.add_argument("--maps", default=str(HERE / "maps"))
	p.add_argument("--host", default="127.0.0.1", help="CDP host (localhost only)")
	p.add_argument("--port", type=int, default=9222, help="CDP port of the running Primitive App Editor")
	p.add_argument("--artifacts", default=str(REPO / ".build/primitive-app-editor/gui-debug/runs"))
	p.add_argument("--window", default=None, help="Workbench window title / url fragment when several windows exist")
	a = p.parse_args(argv)
	if a.host not in ("127.0.0.1", "localhost", "::1"):
		p.error("--host must be a localhost address")
	return Config(a.roadmap, a.maps, a.host, a.port, a.artifacts, a.window)


def main(argv: list[str] | None = None) -> int:
	config = parse_args(argv)
	try:
		from .app import run_app
	except ImportError as e:  # PySide6 missing
		print(f"PySide6 is required for the Tool window: {e}", file=sys.stderr)
		return 2
	return run_app(config)
