"""GUI Map YAML loader / validator (GUI Debug Tool.md §9)."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
REF_RE = re.compile(r"\{\{\s*(inputs|captures)\.([A-Za-z0-9_]+)\s*\}\}")
CHECKPOINT_ID_RE = re.compile(r"^cp\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$")

LOCATOR_KINDS = ("part", "view", "status", "marker", "role", "css")
ACTIONS = ("click", "double_click", "context_click", "hover", "focus", "type", "press", "select", "command", "wait", "screenshot")
ACTIONS_NEED_TARGET = ("click", "double_click", "context_click", "hover", "focus", "type", "select")
ACTIONS_NEED_VALUE = ("type", "press", "select", "command")
COUNT_OPS = ("eq", "ne", "ge", "gt", "le", "lt")
ATTRIBUTE_OPS = ("equals", "contains", "present", "absent")
# Expectation kinds -> (resolve mode, allowed extra fields)
EXPECTATIONS: dict[str, tuple[str, tuple[str, ...]]] = {
	"visible": ("unique", ()),
	"hidden": ("unique", ()),
	"enabled": ("unique", ()),
	"disabled": ("unique", ()),
	"focused": ("unique", ()),
	"absent": ("count", ()),
	"text_equals": ("unique", ("value", "source")),
	"text_contains": ("unique", ("value", "source")),
	"attribute": ("unique", ("name", "op", "value")),
	"count": ("count", ("op", "value")),
}
FORBIDDEN_FIELDS = ("x", "y", "position", "coordinates", "image", "image_path", "template", "nth", "index")


class GuiMapError(Exception):
	"""Raised when a GUI Map is not loadable. `problems` lists every violation found."""

	def __init__(self, path: str, problems: list[str]):
		self.path = path
		self.problems = problems
		super().__init__(f"{path}: " + "; ".join(problems))


@dataclass
class GuiMap:
	path: str
	digest: str
	raw: dict[str, Any]
	checkpoint_id: str = ""
	title: str = ""
	bundles: list[str] = field(default_factory=list)
	require: list[dict[str, Any]] = field(default_factory=list)
	regression: bool = False
	preconditions: dict[str, Any] = field(default_factory=dict)
	markers: dict[str, dict[str, Any]] = field(default_factory=dict)
	inputs: dict[str, Any] = field(default_factory=dict)
	steps: list[dict[str, Any]] = field(default_factory=list)
	report: dict[str, Any] = field(default_factory=dict)


def _refs(value: Any) -> list[tuple[str, str]]:
	return REF_RE.findall(value) if isinstance(value, str) else []


def _validate_item(item: Any, where: str, inputs: dict, captures: set[str], problems: list[str]) -> None:
	if not isinstance(item, dict):
		problems.append(f"{where}: item must be a mapping")
		return
	if "identity" not in item and "text" not in item:
		problems.append(f"{where}: item requires identity or text")
	identity = item.get("identity")
	if identity is not None:
		if not isinstance(identity, str):
			problems.append(f"{where}: item.identity must be a string")
		elif not (UUID_RE.match(identity) or REF_RE.fullmatch(identity.strip())):
			problems.append(f"{where}: item.identity must be a UUID, inputs reference or captures reference")
	_validate_refs(item, where, inputs, captures, problems)


def _validate_refs(node: Any, where: str, inputs: dict, captures: set[str], problems: list[str]) -> None:
	for value in (node.values() if isinstance(node, dict) else [node]):
		if isinstance(value, dict):
			_validate_refs(value, where, inputs, captures, problems)
			continue
		for scope, name in _refs(value):
			if scope == "inputs" and name not in inputs:
				problems.append(f"{where}: {{{{ inputs.{name} }}}} is not defined in inputs")
			if scope == "captures" and name not in captures:
				problems.append(f"{where}: {{{{ captures.{name} }}}} is not defined by an earlier step capture")


def validate_map(data: Any, file_stem: str, known_bundles: set[str] | None) -> list[str]:
	"""Return all validation problems (empty list = valid)."""
	problems: list[str] = []
	if not isinstance(data, dict) or not isinstance(data.get("gui_map"), dict):
		return ["top-level `gui_map` mapping is required"]
	gm = data["gui_map"]
	if gm.get("version") != 1:
		problems.append("gui_map.version must be 1")
	cp = gm.get("checkpoint")
	if not isinstance(cp, dict):
		return problems + ["gui_map.checkpoint mapping is required"]
	cp_id = cp.get("id")
	if not isinstance(cp_id, str) or not CHECKPOINT_ID_RE.match(cp_id):
		problems.append("checkpoint.id must match cp.<area>.<name>")
	elif cp_id != file_stem:
		problems.append(f"checkpoint.id '{cp_id}' must equal the file name '{file_stem}'")
	bundles = cp.get("bundles")
	if not isinstance(bundles, list) or not bundles or not all(isinstance(b, str) for b in bundles):
		problems.append("checkpoint.bundles must be a non-empty list of bundle ids")
		bundles = []
	require = (cp.get("condition") or {}).get("require")
	if not isinstance(require, list) or not require:
		problems.append("checkpoint.condition.require must be a non-empty list")
		require = []
	for i, req in enumerate(require):
		if not isinstance(req, dict) or not isinstance(req.get("bundle"), str):
			problems.append(f"condition.require[{i}].bundle is required")
			continue
		status = req.get("status", ["implemented"])
		if not isinstance(status, list) or not status or not all(isinstance(s, str) for s in status):
			problems.append(f"condition.require[{i}].status must be a list of status strings")
		if known_bundles is not None and req["bundle"] not in known_bundles:
			problems.append(f"condition.require[{i}].bundle '{req['bundle']}' does not exist in roadmap.yaml")
	if known_bundles is not None:
		for b in bundles:
			if b not in known_bundles:
				problems.append(f"checkpoint.bundles '{b}' does not exist in roadmap.yaml")
	if not isinstance(cp.get("regression", False), bool):
		problems.append("checkpoint.regression must be a boolean")

	inputs = gm.get("inputs") or {}
	if not isinstance(inputs, dict):
		problems.append("inputs must be a mapping")
		inputs = {}
	for name, value in inputs.items():
		if isinstance(value, bool) or not isinstance(value, (str, int)):
			problems.append(f"inputs.{name} must be a string or integer")

	markers = gm.get("markers") or {}
	if not isinstance(markers, dict):
		problems.append("markers must be a mapping")
		markers = {}
	pre = gm.get("preconditions") or {}
	if not isinstance(pre, dict):
		problems.append("preconditions must be a mapping")
		pre = {}
	for alias, m in markers.items():
		if not isinstance(m, dict):
			problems.append(f"markers.{alias} must be a mapping")
			continue
		for key in FORBIDDEN_FIELDS:
			if key in m:
				problems.append(f"markers.{alias}: field '{key}' is prohibited (fixed coordinates / image / position)")
		if m.get("kind") not in LOCATOR_KINDS:
			problems.append(f"markers.{alias}.kind must be one of {', '.join(LOCATOR_KINDS)}")
		if not isinstance(m.get("value"), str) or not m.get("value"):
			problems.append(f"markers.{alias}.value is required")
		if m.get("kind") == "css" and not m.get("justification"):
			problems.append(f"markers.{alias}: css locator requires justification")
		if m.get("kind") == "role":
			if not pre.get("locale"):
				problems.append(f"markers.{alias}: role locator requires preconditions.locale")
			if ":" not in str(m.get("value", "")):
				problems.append(f"markers.{alias}: role locator value must be '<role>:<accessible name>'")
		within = m.get("within")
		if within is not None and within not in markers:
			problems.append(f"markers.{alias}.within '{within}' is not a defined alias")
	for alias in markers:  # within cycles
		seen, cur = set(), alias
		while isinstance(markers.get(cur), dict) and markers[cur].get("within") in markers:
			if cur in seen:
				problems.append(f"markers.{alias}: within chain is cyclic")
				break
			seen.add(cur)
			cur = markers[cur]["within"]
	for alias in pre.get("markers") or []:
		if alias not in markers:
			problems.append(f"preconditions.markers '{alias}' is not a defined alias")

	steps = gm.get("steps")
	if not isinstance(steps, list) or not steps:
		problems.append("steps must be a non-empty list")
		steps = []
	captures: set[str] = set()
	step_ids: set[str] = set()
	for idx, step in enumerate(steps):
		if not isinstance(step, dict):
			problems.append(f"steps[{idx}] must be a mapping")
			continue
		sid = step.get("id")
		where = f"step {sid or idx}"
		if not isinstance(sid, str) or not sid:
			problems.append(f"steps[{idx}].id is required")
		elif sid in step_ids:
			problems.append(f"{where}: duplicate step id")
		step_ids.add(str(sid))
		for key in FORBIDDEN_FIELDS:
			if key in step:
				problems.append(f"{where}: field '{key}' is prohibited (fixed coordinates / image / position)")
		action = step.get("action")
		if action not in ACTIONS:
			problems.append(f"{where}: action must be one of {', '.join(ACTIONS)}")
		target = step.get("target")
		if target is not None and target not in markers:
			problems.append(f"{where}: target '{target}' is not a defined alias")
		if action in ACTIONS_NEED_TARGET and target is None:
			problems.append(f"{where}: action '{action}' requires target")
		if action in ACTIONS_NEED_VALUE and not isinstance(step.get("value"), (str, int)):
			problems.append(f"{where}: action '{action}' requires value")
		if "item" in step:
			_validate_item(step["item"], where, inputs, captures, problems)
		_validate_refs({"value": step.get("value")}, where, inputs, captures, problems)
		if "timeout_ms" in step and (isinstance(step["timeout_ms"], bool) or not isinstance(step["timeout_ms"], int) or step["timeout_ms"] < 0):
			problems.append(f"{where}: timeout_ms must be a non-negative integer")
		for i, exp in enumerate(step.get("expect") or []):
			_validate_expectation(exp, f"{where}.expect[{i}]", markers, inputs, captures, problems)
		if action == "wait" and not step.get("expect"):
			problems.append(f"{where}: action 'wait' requires expect")
		cap = step.get("capture")
		if cap is not None:
			if not isinstance(cap, dict):
				problems.append(f"{where}: capture must be a mapping")
			else:
				name = cap.get("name")
				if not isinstance(name, str) or not name:
					problems.append(f"{where}: capture.name is required")
				elif name in captures:
					problems.append(f"{where}: capture.name '{name}' is not unique")
				if cap.get("target") not in markers:
					problems.append(f"{where}: capture.target '{cap.get('target')}' is not a defined alias")
				mode = cap.get("mode")
				if mode not in ("item", "new_item"):
					problems.append(f"{where}: capture.mode must be item or new_item")
				elif mode == "item":
					if "item" not in cap:
						problems.append(f"{where}: capture.mode item requires item")
					else:
						_validate_item(cap["item"], f"{where}.capture", inputs, captures, problems)
				elif "item" in cap:
					problems.append(f"{where}: capture.mode new_item must not have item")
				if isinstance(name, str) and name:
					captures.add(name)  # visible from later steps (and expectations of this step)
		_validate_report(step.get("report"), f"{where}.report", problems, markers=None, optional=True)
	_validate_report(gm.get("report"), "report", problems, markers=None, optional=False)
	return problems


def _validate_expectation(exp: Any, where: str, markers: dict, inputs: dict, captures: set[str], problems: list[str]) -> None:
	if not isinstance(exp, dict):
		problems.append(f"{where}: must be a mapping")
		return
	kind = exp.get("assert")
	for key in FORBIDDEN_FIELDS:
		if key in exp:
			problems.append(f"{where}: field '{key}' is prohibited (fixed coordinates / image / position)")
	if kind not in EXPECTATIONS:
		problems.append(f"{where}: assert must be one of {', '.join(EXPECTATIONS)}")
		return
	if exp.get("target") not in markers:
		problems.append(f"{where}: target '{exp.get('target')}' is not a defined alias")
	allowed = {"assert", "target", "item"} | set(EXPECTATIONS[kind][1])
	for key in exp:
		if key not in allowed:
			problems.append(f"{where}: field '{key}' is not allowed for assert '{kind}'")
	if "item" in exp:
		_validate_item(exp["item"], where, inputs, captures, problems)
	_validate_refs({"value": exp.get("value")}, where, inputs, captures, problems)
	if kind in ("text_equals", "text_contains"):
		if not isinstance(exp.get("value"), str):
			problems.append(f"{where}: value (string) is required")
		if exp.get("source", "text") not in ("text", "input_value"):
			problems.append(f"{where}: source must be text or input_value")
	elif kind == "attribute":
		if not isinstance(exp.get("name"), str) or not exp.get("name"):
			problems.append(f"{where}: name is required")
		op = exp.get("op")
		if op not in ATTRIBUTE_OPS:
			problems.append(f"{where}: op must be one of {', '.join(ATTRIBUTE_OPS)}")
		elif op in ("equals", "contains"):
			if not isinstance(exp.get("value"), str):
				problems.append(f"{where}: value (string) is required for op {op}")
		elif "value" in exp:
			problems.append(f"{where}: value is forbidden for op {op}")
	elif kind == "count":
		if exp.get("op") not in COUNT_OPS:
			problems.append(f"{where}: op must be one of {', '.join(COUNT_OPS)}")
		value = exp.get("value")
		if isinstance(value, bool) or not isinstance(value, int) or value < 0:
			problems.append(f"{where}: value must be an integer >= 0")


def _validate_report(report: Any, where: str, problems: list[str], markers: Any, optional: bool) -> None:
	if report is None:
		if not optional:
			problems.append(f"{where}: Checkpoint report definition is required")
		return
	if not isinstance(report, dict):
		problems.append(f"{where}: must be a mapping")
		return
	if not optional and report.get("destination") != "roadmap.diagnostics":
		problems.append(f"{where}.destination must be roadmap.diagnostics")
	if optional and "destination" in report and report["destination"] != "roadmap.diagnostics":
		problems.append(f"{where}.destination must be roadmap.diagnostics")
	for key in ("summary", "category"):
		if key in report and not isinstance(report[key], str):
			problems.append(f"{where}.{key} must be a string")
	if "suspected_bundles" in report and not (isinstance(report["suspected_bundles"], list) and all(isinstance(b, str) for b in report["suspected_bundles"])):
		problems.append(f"{where}.suspected_bundles must be a list of bundle ids")


def load_map(path: str | Path, known_bundles: set[str] | None) -> GuiMap:
	p = Path(path)
	text = p.read_bytes()
	try:
		data = yaml.safe_load(text)
	except yaml.YAMLError as e:
		raise GuiMapError(str(p), [f"YAML parse error: {e}"]) from e
	problems = validate_map(data, p.stem, known_bundles)
	if problems:
		raise GuiMapError(str(p), problems)
	gm = data["gui_map"]
	cp = gm["checkpoint"]
	return GuiMap(
		path=str(p),
		digest=hashlib.sha1(text).hexdigest(),
		raw=data,
		checkpoint_id=cp["id"],
		title=cp.get("title", ""),
		bundles=list(cp["bundles"]),
		require=[{"bundle": r["bundle"], "status": list(r.get("status", ["implemented"]))} for r in cp["condition"]["require"]],
		regression=bool(cp.get("regression", False)),
		preconditions=gm.get("preconditions") or {},
		markers=gm.get("markers") or {},
		inputs=gm.get("inputs") or {},
		steps=gm["steps"],
		report=gm["report"],
	)


@dataclass
class MapEntry:
	"""Result of scanning the GUI Map directory: either a loaded map or its load error."""

	path: str
	gui_map: GuiMap | None = None
	problems: list[str] = field(default_factory=list)


def load_directory(directory: str | Path, known_bundles: set[str] | None) -> list[MapEntry]:
	"""Load every GUI Map; checkpoint.id must be unique across maps."""
	entries: list[MapEntry] = []
	seen: dict[str, str] = {}
	for p in sorted(Path(directory).glob("*.yaml")):
		try:
			gm = load_map(p, known_bundles)
		except GuiMapError as e:
			entries.append(MapEntry(str(p), None, e.problems))
			continue
		if gm.checkpoint_id in seen:
			entries.append(MapEntry(str(p), None, [f"checkpoint.id duplicates {seen[gm.checkpoint_id]}"]))
			continue
		seen[gm.checkpoint_id] = str(p)
		entries.append(MapEntry(str(p), gm))
	return entries
