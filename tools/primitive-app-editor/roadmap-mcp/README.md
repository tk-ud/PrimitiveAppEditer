# Primitive App Editor roadmap MCP Tool

Standalone stdio MCP server implementing the roadmap Agent Tool (`roadmap.next` / `roadmap.complete`).

```yaml
specification: docs/primitive-app-editor/Agent tool.md   # SSOT for command / validation / lifecycle
progress: docs/primitive-app-editor/roadmap.yaml          # bundle: tooling.roadmap-agent
policy: README.md (Tool First)
boundary:
  - Development Tool only; not Primitive App Editor Runtime
  - Isolated from src/vs/** (Code OSS) and test/mcp (Code OSS automation MCP)
```

## Usage

The server is registered in the repository `.mcp.json` as `primitive-app-editor-roadmap`:

```sh
npm --prefix tools/primitive-app-editor/roadmap-mcp run --silent start-stdio
```

`start-stdio` runs `npm ci`, compiles, and starts `out/stdio.js` (install / compile output goes to stderr so stdout stays a clean JSON-RPC stream).
By default it serves `docs/primitive-app-editor/roadmap.yaml`; `node out/stdio.js --roadmap <path>` selects another roadmap.

| Tool | Input | Output |
| --- | --- | --- |
| `roadmap.next` | `{}` | `{ id, prompt, bundle, specifications }`, or `{ status: "completed" \| "blocked", message }` |
| `roadmap.complete` | `{ id, status, evidence, remaining }` | `{ id, status, next_action, message }` |

Failures are returned as MCP tool errors (`isError: true`); `roadmap.complete` validation failures carry `{ error: "validation_failed", violations: [{ rule, message }] }` using the rule names of the specification.

## Section references

`selected_bundle.reference[].sections` are resolved against ATX headings (fenced code blocks are ignored).
A section's content runs from its heading to the next heading of the same or a higher level, so nested subsections are included.

| Form | Example | Resolves to |
| --- | --- | --- |
| `§N Title` | `§1 Authority`, `§30 Function / Program Scan` | heading `N. Title` |
| `§N Sub` | `§3 Open`, `§39 Inspector` | the unique heading `Sub` nested in section `N.` |
| `§N Title / Sub` | `§22 Function Runtime / Load` | the unique heading `Sub` nested in `N. Title` |
| `Title` | `Tool First`, `roadmap Tool` | the unique heading whose text is `Title` |

A reference that does not resolve to exactly one heading (missing, number/title mismatch, ambiguous) is an error. Nothing is guessed.

## Implementation notes

Points where `Agent tool.md` needs a concrete mechanism, and the mechanism chosen:

- `render_prompt`: the template is embedded verbatim (a test asserts it equals the specification). Rendering is single-pass, so specification content containing `{{ ... }}` is never re-interpreted. String lists render as `- item` lines, or `[]` when empty.
- `detect_reference_conflict`: the same resolved heading of the same file referenced with both the `implementation` and the `boundary` role. Semantic conflicts inside specification text are not machine-detectable.
- `atomic_write_yaml`: only the value text of the target bundle's `status` / `evidence` / `remaining` is replaced (no YAML re-serialization), the result is re-parsed and must equal the original roadmap except for those three fields, then written via a temporary file + rename. The write is refused if `roadmap.yaml` changed while the tool ran.
- `depends_on_unchanged`: the input schema rejects any field other than `id` / `status` / `evidence` / `remaining`, and the re-parse check guarantees `depends_on` is unchanged.
- `next_action`: derived from the updated roadmap with the `roadmap.next` selection: `restart` (a bundle is executable), `completed` (no bundle left), `blocked` (bundles left, none executable).

## Test

```sh
cd tools/primitive-app-editor/roadmap-mcp
npm ci
npm test
```
