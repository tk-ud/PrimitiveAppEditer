# Deploy E2E harness (completion.end-to-end)

Runs `Deploy Configuration.md` 7.2 against a real Docker Engine + Compose plugin (Linux host).

```
npm ci --ignore-scripts
node --experimental-strip-types tools/primitive-app-editor/e2e/run.ts
```

The harness projects a fixture (Authoring Data -> Build Validation -> Application Output -> Deploy Scaffold),
writes the files to a temp directory, then explicitly runs `docker compose -f <YAML> config / build / up -d`
(the Editor never does), probes API health, CRUD, validation (400 problem+json), the Next.js UI, and stop / start persistence.
Container builds need direct access to the NuGet and npm registries; Docker Hub library images fall back to public mirrors.

## CI / diagnostics

`.github/workflows/deploy-e2e.yml` runs this harness on a GitHub-hosted Ubuntu runner (preinstalled Docker Engine + Compose). Set `PAE_E2E_LOG_DIR` to have the harness write `steps.log`, `error.log`, `compose-build.log`, `compose-ps.log` and `compose-logs.log` before compose teardown; the workflow uploads that directory as an artifact on failure.
