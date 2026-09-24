# mb-ai

Thin launcher that wraps the real `claude` CLI: on each run it fetches a harness profile from
the backend (system prompt, MCP config, allowed-tools, flags), writes `servers.json`, and execs
`claude`. The backend controls behavior; the launcher ships via npm.

## Commands

```bash
npm ci                 # install (also builds via the prepare hook)
npm run typecheck      # tsc --noEmit
npm run test:it        # builds, then runs the stub-backend + fake-claude smoke test

mb-ai --backend-url http://localhost:8000 login
mb-ai --backend-url http://localhost:8000
mb-ai doctor
# headless / no keychain: set MB_AI_TOKEN=<jwt> to skip login
```

## Layout

`src/index.ts` (commander entry) · `src/commands/` (run, login, logout, doctor) · `src/core/`
(auth, backend, http, profile, materialize, exec, gate, secrets, paths, jwt, log, errors) ·
`src/schema/profile.ts` (zod). Built bin: `dist/index.js`.

## Gotchas (verified vs claude 2.1.280)

- Claude Code does **not** expand `${VARS}` in `--mcp-config`, so the launcher bakes the token
  into `servers.json` (mode 600) — keep it a file, never an argv string.
- Tool ids are `mcp__<server>__<tool>`; `--allowed-tools` / `--mcp-config` are variadic → emit last.
- `core/gate.ts` hard-blocks a launcher older than the profile's `minLauncherVersion`.

## Commits

Author as the committer only — no `Co-Authored-By: Claude` or AI attribution. Commit/push only when asked.
