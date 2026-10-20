"""roadmap.yaml read (Bundle status) and diagnostics.gui_debug.records write (GUI Debug Tool.md §12)."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import yaml

MAX_WRITE_RETRIES = 5


class RoadmapWriteError(Exception):
	pass


def read_text(path: str | Path) -> str:
	return Path(path).read_text(encoding="utf-8")


def bundle_statuses(text: str) -> dict[str, str]:
	"""section[].bundle[].id -> status (the only read region)."""
	doc = yaml.safe_load(text)
	result: dict[str, str] = {}
	for section in (doc or {}).get("section") or []:
		for bundle in section.get("bundle") or []:
			result[str(bundle["id"])] = str(bundle.get("status", ""))
	return result


def read_statuses(path: str | Path) -> dict[str, str]:
	return bundle_statuses(read_text(path))


# --- YAML emission (block style, JSON-quoted strings; no re-serialization of the document) ---

def _scalar(value: Any) -> str:
	if isinstance(value, bool):
		return "true" if value else "false"
	if value is None:
		return "null"
	if isinstance(value, (int, float)):
		return json.dumps(value)
	return json.dumps(str(value), ensure_ascii=False)


def emit_yaml(value: Any, indent: int) -> list[str]:
	pad = " " * indent
	lines: list[str] = []
	if isinstance(value, dict):
		for key, item in value.items():
			if isinstance(item, (dict, list)) and item:
				lines.append(f"{pad}{json.dumps(str(key), ensure_ascii=False)}:")
				lines.extend(emit_yaml(item, indent + 2))
			elif isinstance(item, dict):
				lines.append(f"{pad}{json.dumps(str(key), ensure_ascii=False)}: {{}}")
			elif isinstance(item, list):
				lines.append(f"{pad}{json.dumps(str(key), ensure_ascii=False)}: []")
			else:
				lines.append(f"{pad}{json.dumps(str(key), ensure_ascii=False)}: {_scalar(item)}")
	elif isinstance(value, list):
		for item in value:
			if isinstance(item, dict) and item:
				sub = emit_yaml(item, indent + 2)
				lines.append(f"{pad}- {sub[0].lstrip()}")
				lines.extend(sub[1:])
			elif isinstance(item, (dict, list)):
				lines.append(f"{pad}- {'{}' if isinstance(item, dict) else '[]'}")
			else:
				lines.append(f"{pad}- {_scalar(item)}")
	else:
		lines.append(f"{pad}{_scalar(value)}")
	return lines


_RECORDS_LINE = re.compile(r"^(?P<indent> +)records:(?P<rest>.*)$")


def _records_span(lines: list[str]) -> tuple[int, int, int]:
	"""Locate the `records:` line under diagnostics.gui_debug -> (start, end_exclusive, key_indent)."""
	in_diag = in_gui = False
	for i, line in enumerate(lines):
		if re.match(r"^diagnostics:\s*(#.*)?$", line):
			in_diag, in_gui = True, False
			continue
		if in_diag and re.match(r"^\S", line) and not line.startswith("#"):
			in_diag = in_gui = False
		if in_diag and re.match(r"^  gui_debug:\s*(#.*)?$", line):
			in_gui = True
			continue
		if in_gui:
			m = _RECORDS_LINE.match(line)
			if m and len(m.group("indent")) == 4:
				end = i + 1
				while end < len(lines):
					nxt = lines[end]
					if nxt.strip() == "" or nxt.lstrip().startswith("#"):
						# blank / comment belongs to the region only when followed by deeper list content
						probe = end
						while probe < len(lines) and (lines[probe].strip() == "" or lines[probe].lstrip().startswith("#")):
							probe += 1
						if probe < len(lines) and len(lines[probe]) - len(lines[probe].lstrip()) > 4:
							end = probe
							continue
						break
					if len(nxt) - len(nxt.lstrip()) > 4:
						end += 1
						continue
					break
				return i, end, 4
	raise RoadmapWriteError("diagnostics.gui_debug.records not found in roadmap.yaml")


def replace_records_text(text: str, records: list[dict[str, Any]]) -> str:
	"""Replace only the diagnostics.gui_debug.records text range."""
	lines = text.split("\n")
	start, end, _ = _records_span(lines)
	if records:
		new = ["    records:"] + emit_yaml(records, 6)
	else:
		new = ["    records: []"]
	return "\n".join(lines[:start] + new + lines[end:])


def read_records(text: str) -> list[dict[str, Any]]:
	doc = yaml.safe_load(text) or {}
	records = (((doc.get("diagnostics") or {}).get("gui_debug") or {}).get("records")) or []
	return list(records)


def _without_records(doc: Any) -> Any:
	clone = json.loads(json.dumps(doc, default=str))
	try:
		del clone["diagnostics"]["gui_debug"]["records"]
	except (KeyError, TypeError):
		pass
	return clone


def verify_edit(before: str, after: str, expected_records: list[dict[str, Any]]) -> None:
	"""Re-parse and prove only diagnostics.gui_debug.records changed and the section structure is intact."""
	doc_before, doc_after = yaml.safe_load(before), yaml.safe_load(after)
	if _without_records(doc_before) != _without_records(doc_after):
		raise RoadmapWriteError("edit changed content outside diagnostics.gui_debug.records")
	if json.loads(json.dumps(read_records(after), default=str)) != json.loads(json.dumps(expected_records, default=str)):
		raise RoadmapWriteError("written records do not round-trip")
	if not isinstance(doc_after.get("section"), list):
		raise RoadmapWriteError("section structure violated")
	for section in doc_after["section"]:
		if not isinstance(section, dict) or not isinstance(section.get("bundle"), list):
			raise RoadmapWriteError("section structure violated")
		for bundle in section["bundle"]:
			if not isinstance(bundle, dict) or not isinstance(bundle.get("id"), str) or not isinstance(bundle.get("status"), str):
				raise RoadmapWriteError("section structure violated")


def write_records(path: str | Path, update, retries: int = MAX_WRITE_RETRIES, before_rename=None) -> list[dict[str, Any]]:
	"""Write Protocol (§12). `update(existing_records) -> new_records`.

	Raises RoadmapWriteError after `retries` failed attempts (caller keeps pending-diagnostics).
	`before_rename` is a test hook called after the temp file is written and before the final compare.
	"""
	p = Path(path)
	last_error = "unknown"
	for _ in range(max(1, retries)):
		before = p.read_text(encoding="utf-8")  # 1
		new_records = update(read_records(before))
		after = replace_records_text(before, new_records)  # 2
		try:
			verify_edit(before, after, new_records)  # 3, 4
		except RoadmapWriteError:
			raise
		fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=p.name + ".", suffix=".tmp")  # 5
		try:
			with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
				f.write(after)
			if before_rename:
				before_rename()
			if p.read_text(encoding="utf-8") != before:  # 6
				last_error = "roadmap.yaml changed during write"
				os.unlink(tmp)
				continue
			os.replace(tmp, p)  # 7
			return new_records
		except BaseException:
			if os.path.exists(tmp):
				os.unlink(tmp)
			raise
	raise RoadmapWriteError(f"retry limit exceeded: {last_error}")  # 8
