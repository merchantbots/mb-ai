# mb-ai

Thin launcher that wraps the real `claude` CLI: on each run it fetches a harness profile from
the backend (system prompt, MCP config, allowed-tools, flags), writes `servers.json`, and execs
`claude`. The backend controls behavior; users install the launcher from GitHub (`main`).

## Commands

```bash
npm ci                 # install (also builds via the prepare hook)
npm run typecheck      # tsc --noEmit
npm run test:it        # builds, then runs the stub-backend + fake-claude smoke test

mb-ai --backend-url http://localhost:8000   # auto-prompts login on first run
mb-ai doctor
# headless / no keychain: set MB_AI_TOKEN=<jwt> to skip the prompt
# hidden utilities: mb-ai login (pre-auth) · mb-ai logout (wipe token)
```

## Layout

`src/index.ts` (commander entry) · `src/commands/` (run, login, logout, doctor). Core is flat in
`src/`: `config` (backend + on-disk paths) · `session` (keychain + JWT + login/token) · `profile`
(zod schema + fetch) · `launch` (version gate + servers.json + exec claude) · `errors`
(types + parseError) · `log` · `version`. Built bin: `dist/index.js`.

## Gotchas (verified vs claude 2.1.280)

- Claude Code does **not** expand `${VARS}` in `--mcp-config`, so the launcher bakes the token
  into `servers.json` (mode 600) — keep it a file, never an argv string.
- Tool ids are `mcp__<server>__<tool>`; `--allowed-tools` / `--mcp-config` are variadic → emit last.
- the version gate in `launch.ts` hard-blocks a launcher older than the profile's `minLauncherVersion`.

## Releasing

Distributed via GitHub, not npm — users run `npm i -g github:merchantbots/mb-ai`, which builds
`main`'s HEAD via the `prepare` hook. No registry, no tags: updating is just re-running that
command, so **`main` is the release** (CI gates every PR and push to it). `VERSION` is injected
from `package.json` at build time (tsup `define`) — one place to bump.

The version gate is a *mandatory floor*, not an "update available" notice: it only fires when a
launcher is below the backend's `minLauncherVersion`, and ordinary changes reach users only when
they choose to reinstall. To force an update, move BOTH together — bump `package.json` on `main`
**and** raise the backend's `minLauncherVersion` to match. Raising the backend floor above the
version `main` reports bricks everyone, fresh installs included (reinstalling can't escape it).

## Commits

Author as the committer only — no `Co-Authored-By: Claude` or AI attribution. Commit/push only when asked.
