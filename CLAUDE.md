# mb-ai — Working Context (for Claude and for humans)

One file, two readers. This is the shared "job description" for both the coding agent (Claude)
working in this repo and the people using and maintaining it. Read it first; follow the
`docs/` links for depth. Keep it current — if a change here makes this doc wrong, fix it in
the same change.

## What this is

`mb-ai` is a thin **launcher** that wraps the real `claude` CLI. On every run it:

1. ensures a valid bearer token (keychain, per backend host),
2. `GET`s the current **harness profile** from the backend (system prompt, MCP config,
   allowed-tools, flags, pinned skills),
3. materializes that profile into `claude` flags + a `servers.json` file, then
4. `exec`s the real `claude`.

The backend is the single control point for fleet behavior; the launcher itself updates via npm.

**Mental model:** the *tool* updates like any CLI (npm); the *behavior* (the profile) updates
over HTTP every run. Two mechanisms, kept separate.

## Repo layout

```
src/
  index.ts            bin entry, commander wiring
  commands/           run (default 5-step flow), login, logout, doctor
  core/               auth, backend, http, profile, materialize, exec,
                      gate (minLauncherVersion), secrets, paths, jwt, log, errors
  schema/profile.ts   zod contract for the profile
  version.ts
scripts/
  it-smoke.mjs        end-to-end smoke test (stub backend + fake claude, no live services)
  verify-flags.sh     probes real `claude` flags; kept in sync with the 2.1.280 findings
docs/
  ARCHITECTURE.md     full design + decisions log   ← source of truth
  BUILD-PLAN.md       module-by-module build checklist + milestones
  PROFILE-ENDPOINT.md the GET /harness/profile data contract
README.md             human quickstart (install / use / how it works)
CLAUDE.md             this file
```

`dist/` and `node_modules/` are gitignored; `dist/index.js` is the built bin.

## Build / test / run

```bash
npm install
npm run build         # tsup → dist/index.js
npm run typecheck     # tsc --noEmit
npm run build && npm run test:it   # stub-backend + fake-claude smoke test (build first)
```

Run locally against a dev backend:

```bash
mb-ai --backend-url http://localhost:8000 login
mb-ai --backend-url http://localhost:8000
mb-ai doctor          # backend URL, auth status, claude version, cache state
```

## Invariants — do not silently break these

Verified against **claude 2.1.280** (`scripts/verify-flags.sh`). Changing any of these breaks
real launches:

- **`--mcp-config` does NOT expand `${VARS}`.** The launcher bakes the resolved bearer into
  `servers.json` and keeps it a **file, mode `600`**, rewritten each run. Never pass the MCP
  JSON as an argv string — that leaks the token into `ps` / EDR command-line logs.
- **System prompt is passed inline** (`--system-prompt "<str>"`) — not secret, no file.
- **Tool ids are `mcp__<server>__<tool>`.** The profile's `allowedTools` are bare names; the
  launcher expands them.
- **`--allowed-tools` / `--mcp-config` are variadic + greedy** → emit them **last**, never put a
  positional after them. Pass `--strict-mcp-config`.
- **Client tool ceiling:** `allowedTools = profile ∩ compiled-in ceiling`. The server can
  narrow, never exceed (`run_sql` stays out). Don't remove the ceiling.
- **Backend isolation by host:** keychain + `cache/` + `plugins/` are namespaced by backend
  host, so a dev token can never reach prod.
- **Hard version gate** (`core/gate.ts`): a launcher `VERSION` below the profile's
  `minLauncherVersion` hard-blocks (exit 2). Covered by the smoke test.

When one of these changes because `claude` itself changed, re-run `scripts/verify-flags.sh` and
update the ARCHITECTURE.md decisions log in the same change.

## Conventions

- **TypeScript, ESM, Node ≥ 18.17.** Runtime deps: `commander`, `@napi-rs/keyring`,
  `@inquirer/prompts`, `zod`, `execa`. Prefer these over adding new dependencies.
- Keep `docs/` authoritative: a design change lands in code **and** the relevant doc (usually
  the ARCHITECTURE.md decisions log) together.
- Secrets never touch disk except the mode-`600` `servers.json`; the durable token lives in the
  OS keychain.

## Commits

- **Attribute commits to the committer only.** Do **not** add a `Co-Authored-By: Claude`
  trailer, a "Generated with Claude Code" line, or any AI/Claude attribution to commits or PRs
  in this repo.
- Only commit or push when asked. Keep messages factual and scoped to the change.
