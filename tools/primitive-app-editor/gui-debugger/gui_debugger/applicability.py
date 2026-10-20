"""Checkpoint applicability (GUI Debug Tool.md §7)."""

from __future__ import annotations

from .gui_map import GuiMap


def evaluate(gui_map: GuiMap, statuses: dict[str, str]) -> tuple[str, str]:
	"""-> ("runnable" | "not_applicable", reason). Never touches Bundle status."""
	for req in gui_map.require:
		current = statuses.get(req["bundle"])
		if current is None:
			return "not_applicable", f"bundle {req['bundle']} not in roadmap"
		if current not in req["status"]:
			return "not_applicable", f"{req['bundle']} is '{current}' (requires {', '.join(req['status'])})"
	return "runnable", ""


def status_snapshot(gui_map: GuiMap, statuses: dict[str, str]) -> dict[str, str]:
	ids = list(dict.fromkeys([r["bundle"] for r in gui_map.require] + gui_map.bundles))
	return {b: statuses[b] for b in ids if b in statuses}
