# mb-ai — Build Plan (TypeScript)

## What it does, in plain language

When you run **`mb-ai`**, it does five things, then gets out of the way:

```
  1. Check itself     "Am I the current version?"       → if not, tell you to update
  2. Check login      "Do I have a valid login?"        → if not, ask username + password (once)
  3. Get the setup    "What is today's configuration?"  → ask the server for the
                                                           prompt, tools, permissions, skills
  4. Get ready        "Put everything in place"         → write the setup to files,
                                                           load the login token
  5. Start Claude     "Hand it all over and open"       → launch the real Claude with
                                                           that setup, opened on the board
```

Then you just talk to Claude normally. Everything above happens in well under a second on a
warm cache; the only time it pauses is the very first login.

The server decides the prompt/tools/permissions/skills, so changing behaviour for everyone is
a server-side edit — nobody re-installs anything. The *tool* updates through npm like any CLI.

---

## What it does, one level down (per run)

```
mb-ai
   │
   ├─ 0. backend    default https://api.mb.ai, or --backend-url / MB_AI_BACKEND_URL override
   │                (keychain + cache/ + plugins/ namespaced by the backend host)
   │
   ├─ 1. version    update-notifier nudge (once/day) + server minLauncherVersion gate
   │
   ├─ 2. auth       token in keychain & not near expiry?
   │                   ├─ yes → use it
   │                   ├─ near expiry → POST /auth/refresh → store
   │                   └─ missing/expired → prompt user+pass → POST /auth/token → store
   │
   ├─ 3. profile    GET /harness/profile  (If-None-Match: etag, Bearer)
   │                   ├─ 200 → validate (zod) → cache + save etag
   │                   ├─ 304 → use cached profile
   │                   └─ offline → last-known-good cache (warn)
   │
   ├─ 4. materialize  write servers.json (mode 600, token injected)
   │                  system prompt kept inline (no file); intersect allowedTools w/ ceiling
   │
   ├─ 4b. skills      pinned mb-skills zip cached in ~/.mb-ai/plugins/ ?
   │                    ├─ no  → GET <url> → verify sha256 → cache
   │                    └─ yes → skip (no network)
   │
   └─ 5. exec       claude --system-prompt "<inline string>" --mcp-config <servers.json> --strict-mcp-config
                    --plugin-dir ~/.mb-ai/plugins/mb-skills-<v>.zip
                    --allowed-tools mcp__task__list_ready_tasks …   (variadic → keep LAST)
                    <flags>   (spawn, inherit stdio, forward signals, mirror exit code)
                    # alt skills delivery: claude plugin install (persistent) · --plugin-url (remote)
```

---

## What needs to be built

### A. Project scaffold & CLI
- [ ] TS project: `package.json` (`bin: { "mb-ai": … }`, shebang `#!/usr/bin/env node`), `tsconfig`, `tsup` build to `dist/`.
- [ ] CLI wiring with **commander** (simple; enough for our handful of commands). *(oclif later only if we want its plugin/auto-update machinery.)*
- [ ] Commands: default (the run flow), `login`, `logout`, `doctor` (diagnostics), `--version`, `--help`.
- [ ] Global flags: **`--backend-url <url>`** (override the baked-in prod default; also `MB_AI_BACKEND_URL`), `--verbose` (debug logs), `--no-update-check`.

### B. Backend, paths & state
- [ ] `backend.ts` — resolve the backend URL: baked-in **prod default**, overridden by `--backend-url` / `MB_AI_BACKEND_URL`. One released tool, backend chosen at runtime (no `--env`/registry). Print the target each run.
- [ ] `paths.ts` — namespaced by backend host: `~/.mb-ai/backends/<host>/{cache,plugins}`; create on first run. `config.toml` stays global. *(The flow/exec snippets write `~/.mb-ai/cache|plugins/…` as shorthand for `~/.mb-ai/backends/<host>/…`.)*
- [ ] `state.ts` — config store via **`conf`** (atomic writes + schema); holds `stateVersion`, device id, installed version, and per-backend cached etag / last update-check.

### C. Secrets (keychain)
- [ ] `secrets.ts` — wrapper over **`@napi-rs/keyring`**; `getToken(host)`, `setToken(host, …)`, `clearToken(host)` under service `mb-ai/<host>` (keyed by backend host). Token never touches disk; a dev token can never be used against prod.

### D. Auth
- [ ] `auth.ts` — `login(backend, user, pass)` → `POST {backend}/auth/token` → store token + `expiresAt` under that backend's keychain slot.
- [ ] `getValidToken(backend)` → return the backend's token; if near expiry → `POST /auth/refresh`; if missing/expired → throw `NeedsLogin` (naming the backend).
- [ ] Password prompt via **`@inquirer/prompts`** (masked); password used once, never stored.
- [ ] Clean errors: bad credentials, refresh failed, backend unreachable.

### E. HTTP + profile
- [ ] `http.ts` — thin `fetch` wrapper (global fetch/undici): bearer header, timeout, small retry, JSON.
- [ ] `schema/profile.ts` — **zod** schema for the profile contract (§8 of ARCHITECTURE).
- [ ] `profile.ts` — `fetchProfile(etag)` → 200 parse+validate+cache+save etag / 304 use cache / offline → last-known-good (warn); read `minLauncherVersion`.

### F. Materialize
- [ ] `materialize.ts` — write **only** `servers.json` (**mode 600**, token injected from keychain into the profile's `mcpServers`). The system prompt is **passed inline as a string** (verified `--system-prompt "<str>"` works) — no `operating-manual.md` file.
- [ ] **Client tool ceiling** — compiled-in allowlist; `allowedTools = profile.allowedTools ∩ ceiling` (server can narrow, never exceed; `run_sql` stays out).

### F2. Skills plugin delivery
- [ ] `plugins.ts` — ensure the pinned artifact is cached: if `~/.mb-ai/plugins/mb-skills-<version>.zip` is absent, download the profile's `url`, verify `sha256`/signature, then cache (by version). Warm launches do nothing.
- [ ] At exec pass **`--plugin-dir <that .zip>`** (session-scoped; `--plugin-dir` accepts a `.zip`, so no unzip step). **Recommended** — we own fetch + verify, isolated under `~/.mb-ai/`, zero-network warm starts.
- [ ] *Alt — marketplace (persistent):* `claude plugin marketplace add <source>` + `claude plugin install mb-skills@mb-skills --scope user --accept-command <sha>`; reconcile to the pinned version; use when humans also want these skills in bare `claude`.
- [ ] *Alt — remote (no local cache):* pass `--plugin-url <url>` and let claude fetch per session.
- [ ] Invoked via `execa`; clear error if `claude` is unavailable. (Verified 2.1.280: `--plugin-dir` loads and runs the plugin's command with **no** workspace-trust prompt.)

### G. Exec Claude
- [ ] `exec.ts` — locate `claude` on PATH (clear error if missing); assemble argv: `--system-prompt "<inline string>"`, `--mcp-config <600 file> --strict-mcp-config`, `--plugin-dir`, `--allowed-tools mcp__<server>__<tool> …`, then `manifest.claude.flags`.
- [ ] **Prompt inline, config in a file** — both flags accept strings (verified), but the MCP JSON carries the token → pass it as a **600 file** (string form puts the token in argv → `ps`/EDR logs). The prompt isn't secret → inline string, no file. (execa passes argv as an array, so large prompts need no shell-escaping; fall back to `--system-prompt-file` only if a prompt ever approaches `ARG_MAX`.)
- [ ] **Variadic-flag safety** — `--allowed-tools` / `--mcp-config` are variadic+greedy (verified): a following positional gets swallowed. Emit them last; never place a positional after them.
- [ ] No `MB_TOKEN` env needed (token is baked into `servers.json`). Spawn via **`execa`** with `stdio: 'inherit'`; forward `SIGINT`/`SIGTERM`; mirror exit code.

### H. Versioning & migrations
- [ ] `version.ts` — **`update-notifier`** nudge (once/day against npm); `minLauncherVersion` gate (warn/block if installed is below).
- [ ] `migrations/` — ordered ladder keyed by `stateVersion`; on launch, back up `~/.mb-ai`, run missing migrations in order, stamp new version. Forward-only. (See ARCHITECTURE §12.)

### I. Error handling & UX
- [ ] Typed errors → friendly messages + right exit codes: not-logged-in (names the backend), token-expired, backend-down, claude-not-installed, version-too-old, profile-invalid.
- [ ] `doctor` prints: **target backend URL**, version, backend reachability, per-backend token validity, claude found, cache state.

### J. Packaging & distribution
- [ ] Build + publish **`mb-ai`** (scoped as `@mb/ai` if the private registry requires it) to the private npm registry.
- [ ] CI: on git tag → build, test, `npm publish`.
- [ ] README with `npm i -g mb-ai` + first-run `login`.

### K. Testing
- [ ] Unit: auth (refresh logic), profile parse/validate, migration ladder, argv assembly, tool-ceiling intersection.
- [ ] Integration: fake backend (**msw** or tiny express) for token/profile; run against a stub `claude` script; assert the argv and env it receives.

### L. Backend contract (dependency — server must provide these)
- [ ] `POST /auth/token` (password grant) → `{ access_token, expires_at }`.
- [ ] `POST /auth/refresh` → refreshed token.
- [ ] `GET /harness/profile` → the profile JSON (§8), with `ETag` + `minLauncherVersion`.
- [ ] Asset URL for the system prompt (content-addressed).
- [ ] MCP server endpoints (task · blackboard · metrics) that accept `Authorization: Bearer`.
- [ ] Skills artifact (MB-private): a versioned, signed `mb-skills` **zip** at a stable `url` (+ `sha256`) for the `--plugin-dir` path; optionally a marketplace **source** + install **accept-command sha** for the persistent-install alternative.
- *For the MVP the client can point at a local stub of these.*

---

## Milestones (build order)

| # | Milestone | Proves | Includes |
|---|-----------|--------|----------|
| **M0** | Walking skeleton | the round-trip works end to end | A, **backend resolve (default prod + `--backend-url`)**, minimal D (stub token ok), a **static local** profile, F, G |
| **M1** | Real auth | login once, silent after | C + real D (**per-backend** keychain + refresh), `login`/`logout`, host-keyed isolation, error UX |
| **M2** | Real profile | server drives everything | E (zod + etag + offline), content-addressed prompt, tool ceiling, **F2 skills delivery** |
| **M3** | Versioning | fleet stays current & safe | H (update nudge + minVersion gate + migrations), `doctor` |
| **M4** | Ship | installable & maintained | J (npm publish + CI), K (tests), README |

M0 is the fastest way to see `mb-ai` open the real `claude` with server-supplied flags —
we can hardcode/stub the backend and swap in the real endpoints at M2.

---

## Module layout

```
src/
  index.ts              # bin entry, commander wiring
  commands/
    run.ts              # default: the 5-step launch flow
    login.ts
    logout.ts
    doctor.ts
  core/
    backend.ts          # resolve backend URL (default prod; --backend-url/env override)
    paths.ts            # ~/.mb-ai/backends/<host> locations
    state.ts            # conf-backed config + stateVersion
    secrets.ts          # keychain wrapper
    auth.ts             # login / getValidToken / refresh
    http.ts             # fetch wrapper
    profile.ts          # fetch + validate + cache
    materialize.ts      # write servers.json (600) + tool ceiling; prompt passed inline
    plugins.ts          # fetch+verify+cache mb-skills → --plugin-dir
    exec.ts             # assemble argv + spawn claude
    version.ts          # update nudge + minVersion gate
  schema/profile.ts     # zod contract
  migrations/index.ts   # ordered ladder
tests/
package.json  tsconfig.json  tsup.config.ts
```

## Dependencies (npm)

`commander` · `conf` · `@napi-rs/keyring` · `@inquirer/prompts` · `zod` · `execa` ·
`update-notifier` · (dev) `tsup` · `typescript` · `vitest` · `msw`.

---

## Open items to confirm before M2
- **Auth grant** — password grant (simplest) vs device-code (SSO/MFA-friendly later).
- **`--mcp-config` env expansion (RESOLVED)** — Claude Code does **not** expand `${VARS}` in
  `--mcp-config` (verified 2.1.280) → launcher bakes the token into `servers.json` (mode 600).
- **Prompt vs MCP-config passing (RESOLVED)** — both accept inline strings (verified); pass the
  **system prompt inline** (no file), keep the **MCP config a 600 file** (string form would leak
  the token into argv / EDR command-line logs).
- **Skills delivery (RESOLVED)** — default `--plugin-dir` against a self-fetched, sha-verified
  pinned zip; alternatives are marketplace `install` (bare-`claude` users) and `--plugin-url`.
  Verified: `--plugin-dir` loads with no trust prompt.
- **Private npm registry** — which one (GitHub Packages / Verdaccio / npmjs private), for the
  publish + install commands.
- **Dev backend URL** — dev is `http://localhost:8000` (verified working). Still need the real
  **prod** URL for the baked-in default in `backend.ts`.
- **[BACKEND] Profile MCP URLs are missing the `/mcp` suffix** — verified 2026-09-23 against the
  live dev backend: the profile returns `mcpServers[*].url` as the bare mount
  (`…/mcp/merchantbots`), which `307`→`404`s and Claude can't connect. The working endpoint is
  `…/mcp/merchantbots/mcp` (FastMCP `streamable_http_app` serves at `/mcp`). With the `/mcp`
  suffix, `whoami` returns the real identity. **Fix belongs in the profile/backend** — the
  launcher passes the URLs verbatim (correct) and needs no change.