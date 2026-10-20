# GUI Debug Tool (tooling.gui-debugger)

Roadmap Driven GUI verification for the running Primitive App Editor. Specification: `docs/primitive-app-editor/GUI Debug Tool.md`.

Development tooling only: it never imports `src/vs` or `tools/primitive-app-editor/roadmap-mcp`, never calls AI / the roadmap Agent Tool,
never changes Bundle `status` / `evidence` / `remaining`, and writes only `diagnostics.gui_debug.records` of `roadmap.yaml`.

## Layout

| Path | Role |
| --- | --- |
| `gui_debugger/gui_map.py` | GUI Map YAML loader / validator (§9) |
| `gui_debugger/applicability.py` | Checkpoint `runnable` / `not_applicable` from Bundle status (§7) |
| `gui_debugger/expectations.py` | Expectation comparison and `{{ inputs.* }}` / `{{ captures.* }}` substitution (§9) |
| `gui_debugger/driver.py` | CDP attach (Python Playwright `connect_over_cdp`) and UI Marker resolver (§6 / §8) |
| `gui_debugger/runner.py` | Run / Step / Pause / Stop / Retry engine and result kinds (§10 / §11) |
| `gui_debugger/diagnostics.py`, `roadmap_io.py` | Report + measured merge, write protocol (§12) |
| `gui_debugger/artifacts.py` | Run Artifacts under `.build/primitive-app-editor/gui-debug/runs/<run id>/` (§13) |
| `gui_debugger/app.py`, `cli.py` | PySide6 window; CLI only carries launch settings (§5) |
| `maps/` | GUI Map YAML, one Checkpoint per file named `<checkpoint id>.yaml` |

## Setup and launch

```text
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Start the Primitive App Editor with a localhost CDP port and a fixed locale, then start the Tool from the integrated terminal:

```text
scripts/code.sh --remote-debugging-port=9222 --locale=en <disposable Working Directory fixture>
python -m gui_debugger --port 9222        # run from tools/primitive-app-editor/gui-debugger
```

`--host` accepts localhost addresses only. Checkpoint selection and Run / Step / Pause / Stop / Retry / Regression Run are operated in the Tool window.
Checkpoints that save Authoring Data must only be pointed at a disposable Working Directory (`preconditions.workspace`).

## Tests (GUI-independent parts need only PyYAML)

```text
python -m unittest discover -s tests -t .
```

`test_playwright_driver.py` (needs Playwright + a Chromium binary), `test_app_smoke.py` (needs PySide6) and the roadmap Agent Tool interop
test (needs `node` and a compiled `tools/primitive-app-editor/roadmap-mcp/out`) skip themselves when their prerequisite is absent.

## Locator conventions (implemented subset of §8)

- `part` / `view` / `status`: DOM `id`. `marker`: `data-pae-marker`. `role`: `"<role>:<accessible name>"`, requires `preconditions.locale`. `css`: requires `justification`.
- `item.identity` is an exact match of the **target element's own** `data-pae-item`; `item.text` is an exact match of whitespace-normalized text.
  A text-only match with two or more candidates is `marker_ambiguous`; no candidate is ever chosen by position.

## Decisions (GUI Debug Tool.md §16)

- Python 3, PyYAML (parsing), Python Playwright sync API (adopted: `connect_over_cdp` works against a Chromium CDP endpoint, see test), PySide6 (adopted for the Tool window).
- `tools/` is outside the repository hygiene filters (`build/filters.ts` `all`), so `.py` / `.yaml` here are not subject to the indentation / copyright filters.
- CI runs the GUI-independent tests (`.github/workflows/gui-debugger.yml`).
