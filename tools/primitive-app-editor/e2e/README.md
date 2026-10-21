# Deploy E2E harness (completion.end-to-end)

Runs `Deploy Configuration.md` 7.2 against a real Docker Engine + Compose plugin (Linux host).

```
npm ci --ignore-scripts
node tools/primitive-app-editor/e2e/run.mjs
```

The harness projects a fixture (Authoring Data -> Build Validation -> Application Output -> Deploy Scaffold),
writes the files to a temp directory, then explicitly runs `docker compose -f <YAML> config / build / up -d`
(the Editor never does), probes API health, CRUD, validation (400 problem+json), the Next.js UI, and stop / start persistence.
Container builds need direct access to the NuGet and npm registries; Docker Hub library images fall back to public mirrors.
