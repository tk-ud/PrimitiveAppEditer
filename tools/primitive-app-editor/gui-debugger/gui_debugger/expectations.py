"""Pure expectation comparison and templating (GUI Debug Tool.md §9 Expectation)."""

from __future__ import annotations

import re
from typing import Any

from .gui_map import REF_RE

_WS = re.compile(r"\s+")


def normalize_text(value: str) -> str:
	return _WS.sub(" ", value.strip())


def substitute(value: Any, inputs: dict[str, Any], captures: dict[str, str]) -> Any:
	"""Replace {{ inputs.x }} / {{ captures.x }} in strings (recursively in dict/list)."""
	if isinstance(value, str):
		def repl(m: re.Match) -> str:
			scope = inputs if m.group(1) == "inputs" else captures
			return str(scope[m.group(2)])
		return REF_RE.sub(repl, value)
	if isinstance(value, dict):
		return {k: substitute(v, inputs, captures) for k, v in value.items()}
	if isinstance(value, list):
		return [substitute(v, inputs, captures) for v in value]
	return value


_COUNT_OPS = {
	"eq": lambda a, b: a == b, "ne": lambda a, b: a != b, "ge": lambda a, b: a >= b,
	"gt": lambda a, b: a > b, "le": lambda a, b: a <= b, "lt": lambda a, b: a < b,
}


def evaluate(exp: dict[str, Any], count: int, observation: dict[str, Any] | None) -> tuple[bool, str, str]:
	"""-> (ok, expected, actual). `observation` is None when count != 1 for unique kinds (caller handles resolution)."""
	kind = exp["assert"]
	if kind == "absent":
		return count == 0, "count == 0", f"count == {count}"
	if kind == "count":
		op, value = exp["op"], exp["value"]
		return _COUNT_OPS[op](count, value), f"count {op} {value}", f"count == {count}"
	obs = observation or {}
	if kind in ("visible", "hidden", "enabled", "disabled", "focused"):
		flag = {"visible": "visible", "hidden": "visible", "enabled": "enabled", "disabled": "enabled", "focused": "focused"}[kind]
		want = kind in ("visible", "enabled", "focused")
		actual = bool(obs.get(flag))
		return actual == want, kind, f"{flag}={str(actual).lower()}"
	if kind in ("text_equals", "text_contains"):
		source = exp.get("source", "text")
		actual = normalize_text(str(obs.get(source) or ""))
		want = normalize_text(str(exp["value"]))
		ok = actual == want if kind == "text_equals" else want in actual
		return ok, f"{source} {'==' if kind == 'text_equals' else 'contains'} {want!r}", repr(actual)
	if kind == "attribute":
		attrs = obs.get("attributes") or {}
		name, op = exp["name"], exp["op"]
		present = name in attrs and attrs[name] is not None
		actual_text = repr(attrs[name]) if present else "<absent>"
		if op == "present":
			return present, f"{name} present", actual_text
		if op == "absent":
			return not present, f"{name} absent", actual_text
		if not present:
			return False, f"{name} {op} {exp['value']!r}", actual_text
		ok = attrs[name] == exp["value"] if op == "equals" else exp["value"] in attrs[name]
		return ok, f"{name} {op} {exp['value']!r}", actual_text
	raise ValueError(f"unknown expectation {kind}")
