"""Diagnostics record building and merge (GUI Debug Tool.md §11 / §12)."""

from __future__ import annotations

import datetime as dt
from typing import Any

DIAGNOSTIC_KINDS = ("marker_not_found", "marker_ambiguous", "expectation_failed", "operation_error")
# Environment results are shown / saved as Run Artifact only, never as Bundle diagnostics.
NON_DIAGNOSTIC_RESULTS = ("passed", "not_applicable", "precondition_failed", "connection_error", "stopped")


def utc_now() -> str:
	return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def merge_report(step_report: dict[str, Any] | None, checkpoint_report: dict[str, Any]) -> dict[str, Any]:
	"""step.report complements the Checkpoint report field by field (no overwrite of unrelated fields)."""
	merged: dict[str, Any] = {}
	for key in ("summary", "category", "suspected_bundles"):
		if step_report and key in step_report:
			merged[key] = step_report[key]
		elif key in checkpoint_report:
			merged[key] = checkpoint_report[key]
	merged.setdefault("suspected_bundles", [])
	return merged


def fingerprint(checkpoint: str, step: str, kind: str, marker: str) -> str:
	return f"{checkpoint}|{step}|{kind}|{marker}"


def build_record(*, checkpoint: str, bundles: list[str], roadmap_status: dict[str, str], step: str, kind: str,
				 report: dict[str, Any], marker: str, locator: str, expected: str, actual: str, error: str,
				 repository_commit: str, gui_map_digest: str, tool_version: str, run: str, log: str,
				 screenshot: str, now: str | None = None) -> dict[str, Any]:
	if kind not in DIAGNOSTIC_KINDS:
		raise ValueError(f"result kind '{kind}' is not recorded as diagnostics")
	now = now or utc_now()
	stamp = now.replace("-", "").replace(":", "")
	return {
		"id": f"gd-{stamp}-{checkpoint}-{step}",
		"fingerprint": fingerprint(checkpoint, step, kind, marker),
		"state": "open",
		"checkpoint": checkpoint,
		"bundles": list(bundles),
		"roadmap_status": dict(roadmap_status),
		"step": step,
		"kind": kind,
		"report": report,
		"measured": {
			"marker": marker,
			"locator": locator,
			"expected": expected,
			"actual": actual,
			"error": error,
			"target": {"repository_commit": repository_commit, "gui_map_digest": gui_map_digest, "tool_version": tool_version},
		},
		"artifacts": {"run": run, "log": log, "screenshot": screenshot},
		"first_seen": now,
		"last_seen": now,
		"occurrences": 1,
	}


def apply_records(existing: list[dict[str, Any]], new_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
	"""§12 Write Rule: same-fingerprint open record -> update last_seen / occurrences / artifacts only;
	otherwise append at the end. Existing records are never deleted or have state changed."""
	result = [dict(r) for r in existing]
	for new in new_records:
		match = next((r for r in result if r.get("fingerprint") == new["fingerprint"] and r.get("state") == "open"), None)
		if match is None:
			result.append(new)
			continue
		match["last_seen"] = new["last_seen"]
		match["occurrences"] = int(match.get("occurrences", 1)) + 1
		match["artifacts"] = new["artifacts"]
	return result
