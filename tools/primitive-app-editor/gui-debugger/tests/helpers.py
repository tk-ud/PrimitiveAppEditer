from __future__ import annotations

from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent.parent
REPO = HERE.parent.parent.parent
REAL_ROADMAP = REPO / "docs/primitive-app-editor/roadmap.yaml"

BASE_MAP = {
	"gui_map": {
		"version": 1,
		"checkpoint": {
			"id": "cp.test.sample", "title": "t", "bundles": ["b.one"],
			"condition": {"require": [{"bundle": "b.one", "status": ["implemented"]}]}, "regression": True,
		},
		"preconditions": {"window": "workbench.html", "markers": ["bar"]},
		"markers": {
			"bar": {"kind": "part", "value": "workbench.parts.statusbar"},
			"entry": {"kind": "status", "value": "status.x", "within": "bar"},
			"list": {"kind": "marker", "value": "registry.tree.table"},
		},
		"inputs": {"name": "Enemy", "uuid": "0b6c1f0e-1a2b-4c3d-8e9f-000000000001"},
		"steps": [
			{"id": "s01", "title": "click", "action": "click", "target": "entry",
			 "capture": {"name": "new_one", "mode": "new_item", "target": "list"},
			 "expect": [{"assert": "count", "target": "list", "item": {"text": "{{ inputs.name }}"}, "op": "eq", "value": 2}]},
			{"id": "s02", "title": "sel", "action": "click", "target": "list", "item": {"identity": "{{ inputs.uuid }}", "text": "Enemy"},
			 "expect": [{"assert": "attribute", "target": "list", "item": {"identity": "{{ captures.new_one }}"}, "name": "aria-selected", "op": "equals", "value": "false"}],
			 "report": {"summary": "step summary", "category": "selection"}},
		],
		"report": {"destination": "roadmap.diagnostics", "summary": "cp summary", "category": "cat", "suspected_bundles": ["b.one"]},
	}
}


def fresh_map() -> dict:
	return yaml.safe_load(yaml.safe_dump(BASE_MAP))


def minimal_roadmap(statuses: dict[str, str]) -> str:
	bundles = "\n".join(f'      - id: "{b}"\n        title: "{b}"\n        reference: []\n        depends_on: []\n        status: "{s}"\n        evidence: []\n        remaining: []' for b, s in statuses.items())
	return f'''roadmap:
  name: "t"

section:
  - name: "S"
    bundle:
{bundles}

future:
  excluded_from_current_loop: []

diagnostics:
  gui_debug:
    writer: "Python GUI Debug Tool (tooling.gui-debugger)"
    contract: "./GUI Debug Tool.md §12 Roadmap Diagnostics"
    records: []
'''
