# mb-ai — Harness Architecture

> `mb-ai = Claude Code + four things`, delivered by the server on every launch.
> The user authenticates **once** (username + password); the launcher self-manages a
> long-lived (~30-day) bearer token and pulls its entire configuration — system prompt,
> MCP config, allowed-tools, plugins, and any `claude` flags — from the backend each run.

**Mental model:** the *tool* updates like any CLI (Homebrew / npm); the *behavior*
(the harness profile) updates over HTTP every run. Two different mechanisms, kept separate.

---

## 1. The idea in one paragraph

`mb-ai` is a thin **launcher** that wraps the real `claude` CLI. It carries almost no
config of its own. On every run it (a) makes sure it has a valid bearer token, (b) asks the
backend for the current **harness profile**, (c) materializes that profile into `claude`
flags and files, then (d) `exec`s the real `claude`. The backend is the single control
point — change the system prompt / tools / permissions / skills once on the server and the
whole fleet picks it up on next launch. The launcher itself is updated through a normal
package manager, not a bespoke self-update scheme.

The **four things** layered on:

| # | Thing | Type | Source of truth |
|---|-------|------|-----------------|
| 1 | system prompt (`--system-prompt`) | INTENT | backend profile |
| 2 | allowed-tools (`--allowed-tools`) | PERMISSION | backend profile (with a client-side ceiling) |
| 3 | MCP config (`--mcp-config`) | CAPABILITY | backend profile (token injected via env) |
| 4 | mb-skills plugin (installed via `claude plugin`) | CAPABILITY | backend pins version + marketplace source |

---

## 2. Component map

```
┌───────────────────────── YOUR MACHINE ─────────────────────────┐
│                                                                 │
│   mb-ai (launcher)                                          │
│   ├─ token manager   keychain-backed; refresh-on-launch         │
│   ├─ profile fetcher  GET /harness/profile (ETag-cached)       │
│   ├─ materializer     writes servers.json (600) + prompt inline │
│   ├─ version gate     hard minLauncherVersion gate (blocks)     │
│   └─ exec             bakes token into servers.json, execs claude│
│                                                                 │
│   claude (child)                                                │
│   └─ MCP calls, Authorization: Bearer <token> ──────────────┐   │
│                                                             │   │
│   OS keychain: bearer token (the only durable secret)       │   │
└──────────────────────────────────────────────────────────────┼─┘
                                             TLS + 30-day bearer │
                    ┌──────────────────────── BACKEND ──────────▼─┐
                    │  Auth        /auth/token · /auth/refresh     │
                    │  Harness API /harness/profile · minVersion   │  ← control plane
                    │  MCP servers task · blackboard · metrics     │
                    │  Skills      mb-skills marketplace           │
                    │  Admin UI    operators edit the ONE profile  │
                    └──────────────────────────────────────────────┘

Tool distribution (separate path): Homebrew tap / npm  ◀── CI publishes releases
```

The token rides into MCP calls by the launcher **writing it into `servers.json` at launch**
(mode `600`, rewritten each run) — Claude Code does **not** expand `${VARS}` in `--mcp-config`
(verified against 2.1.280), so the resolved bearer goes in the file. No sidecar is needed (see §6).

---

## 3. Local layout (what lives on disk)

```
~/.mb-ai/
  config.toml                # global: device id, installed launcher version, stateVersion
  backends/
    api.mb.ai/               # one dir per backend host — keeps prod & dev state apart
      cache/
        profile.json         #   whole profile body + ETag (offline fallback; token-free)
        servers.json         #   MCP config; mode 600, token injected, rewritten each launch
      plugins/mb-skills-<v>.zip   #   pinned skills artifact for THIS backend
    api.dev.mb.ai/
      cache/ · plugins/ …    #   dev's own profile/skills — cannot bleed into prod

OS keychain (NOT on disk), keyed by backend host:
  mb-ai/api.mb.ai/token      # the ~30-day JWT for production
  mb-ai/api.dev.mb.ai/token  # a separate JWT for dev — a dev token can never reach prod
```

The launcher binary itself lives wherever the package manager puts it
(`/opt/homebrew/bin/mb-ai`, or npm's global bin) — not under `~/.mb-ai`.

### Which backend (dev vs prod)

There is **one `mb-ai` — the released, npm-installed tool** — on every machine, dev included.
Dev vs prod is **not** a different build of the tool; it's purely **which backend it points at**.
A developer runs the same production `mb-ai` and aims it at the dev backend. (Hacking on the
launcher *itself* is the only reason to run an unreleased build — that's just `npm link` / running
from source, unrelated to backend choice.)

One knob selects the backend:

- **Default:** a baked-in production URL (`https://api.mb.ai`) — plain `mb-ai` hits prod.
- **Override:** `--backend-url https://api.dev.mb.ai` (or `MB_AI_BACKEND_URL`, so a dev can set it
  once in their shell and skip the flag).

Everything keys off the resolved URL: all HTTP (`/auth/*`, `/harness/profile`, skills fetch) uses
it, and keychain + `cache/` + `plugins/` are namespaced by its **host** — so prod and dev tokens
and caches stay isolated automatically, and a dev token can never be sent to prod. The launcher
**prints the target each run** (`mb-ai · api.dev.mb.ai`), and `doctor` shows it.

*In the flow/exec snippets below, `~/.mb-ai/cache/…` and `~/.mb-ai/plugins/…` are shorthand for
the active backend's `~/.mb-ai/backends/<host>/…`.*

---

## 4. Flow A — first run (`login`, done once)

```
user runs mb-ai
        │
        ▼
 bearer token in keychain?  ── no ──►  prompt username + password
        │ yes                                    │
        │                          POST /auth/token  (password grant)
        │                                    │
        │                          ◄── { access_token (JWT, ~30d), expires_at }
        │                                    │
        │                          store token in keychain
        ▼                                    ▼
 continue to Flow B ◄───────────────────────┘
```

The password is used exactly once to mint the token; it is never stored. The ~30-day JWT in
the keychain is what "self-addresses" auth from then on. **Login targets the resolved backend** —
`mb-ai --backend-url https://api.dev.mb.ai login` stores under `mb-ai/api.dev.mb.ai/token`,
independent of prod.

---

## 5. Flow B — every launch (the round-trip)

```
0. BACKEND          default https://api.mb.ai, or --backend-url / MB_AI_BACKEND_URL override
                    (keychain + cache/ + plugins/ namespaced by the backend host)
                          │
1. VERSION CHECK    once/day: is a newer release out?  → print nudge ("brew upgrade")
                    server minVersion > installed?      → warn / hard-block
                          │
2. ENSURE AUTH      token present & not near expiry?  ── no ──► POST /auth/refresh
                          │ yes                                   (or re-login if expired)
                          │
3. FETCH PROFILE    GET /harness/profile   (If-None-Match: <etag>, Bearer)
                          ├─ 200 → cache manifest + etag
                          └─ 304 → use cached manifest
                          │
4. MATERIALIZE      write servers.json  (mode 600, token injected from keychain)
                    (system prompt stays in memory — passed inline, no file)
                          │
4b. SKILLS PLUGIN   pinned mb-skills zip already in ~/.mb-ai/plugins/ ?
                      ├─ missing → GET <url> → verify sha256/signature → cache
                      └─ present → skip (no network)
                          │
5. ASSEMBLE + EXEC  claude \
                      --system-prompt "<profile.systemPrompt — inline string>"
                      --mcp-config    ~/.mb-ai/cache/servers.json  --strict-mcp-config
                      --allowed-tools mcp__task__list_ready_tasks mcp__task__get_task_context …
                      --plugin-dir    ~/.mb-ai/plugins/mb-skills-<version>.zip
                      <extra flags from manifest.claude.flags>
                    # verified 2.1.280: prompt AND mcp-config also accept inline strings. Prompt →
                    # inline string (not secret; no file). MCP config → 600 FILE, because the string
                    # form puts the token in argv (ps / EDR command-line logs). Tool ids are
                    # mcp__<server>__<tool>; --allowed-tools & --mcp-config are variadic+greedy → last.
                    # alt skills delivery: claude plugin install (persistent) · --plugin-url (remote zip)
```

The profile is fetched fresh (ETag → usually a fast `304`) and is fleet-wide, so "one setup
for the whole fleet, always current" holds: the backend is the only place a change is made.

---

## 6. Token handling (why no broker)

A `claude` session runs for hours; the JWT bearer lives ~30 days — so **no session ever
outlives the token**. That removes any need for a mid-session refresh sidecar. Handling is:

- **Bake into `servers.json` at launch (mode `600`).** Verified against 2.1.280: Claude Code
  does **not** expand `${VARS}` in `--mcp-config`, so the launcher writes the resolved bearer
  into the file itself and rewrites it each run. The durable copy lives in the keychain; the
  file is a short-lived, user-only materialization.
- **Refresh-on-launch.** Each run checks expiry; if within ~a few days of the edge, silently
  re-mint / `POST /auth/refresh`. Run it within any 30-day window and it renews indefinitely;
  miss the window → one more `login`.

**Trade-off, eyes open:** a 30-day bearer is a long-lived secret, it sits in a `600` file for
the session, and a stateless JWT doesn't revoke cleanly. Cheap mitigations: keychain is the
source of truth, rewrite the file each launch, and add a server-side `jti` denylist if you ever
need a lost-laptop kill switch.

> **Optional (later):** a loopback auth-broker sidecar only earns its keep if you shorten the
> token TTL, or want a single local place for request logging / rate-limit handling / policy.
> Not needed at 30-day TTL. Kept as an appendix, not the main path.

---

## 7. Tool distribution & updates (standard channels)

Split **code** (the launcher) from **config** (the profile). They update by totally
different mechanisms:

### The launcher (code) — normal package distribution

| Channel | Install / update | Use when |
|---------|------------------|----------|
| **Homebrew tap** (private) | `brew install mb/tap/mb-ai` → `brew upgrade` | Mac-first, language-agnostic. **Default pick.** |
| **npm** (private/scoped) | `npm i -g mb-ai` → `npm update -g` | launcher is Node/TS; pairs with Claude Code's ecosystem. |
| **install script** | `curl -fsSL https://get.mb.ai \| sh` | zero-dep bootstrap / non-brew users; pulls a prebuilt binary from GitHub Releases. |

Updating follows the boring norms — **do not hand-roll binary self-replacement**:

- **Delegate to the package manager** (`brew upgrade` / `npm update -g`). A nightly
  `brew upgrade` across the fleet is a perfectly standard "always current" story.
- **Hard `minLauncherVersion` gate (implemented, `core/gate.ts`)** — every run compares the
  launcher `VERSION` to the profile's `minLauncherVersion`; if the client is below the floor it
  **hard-blocks**, prints the `npm update -g` command, and exits (code 2). No self-update.
- **No update-notifier nudge (v1)** — decided against; the hard gate + manual `npm update -g`
  is the whole update story. (A daily nudge could be added later if wanted.)
- **Only** for the single-binary-via-curl route: add a `mb-ai upgrade` subcommand that
  downloads from Releases and verifies a **checksum** (the rustup / deno / gh pattern).

### The profile (config/data) — live server fetch

The system prompt, tools, permissions, skills, and flags are **not** distributed with the
tool. They come from `GET /harness/profile` on every launch (§5, §8). This is the
server-controlled, always-current path and it never touches Homebrew/npm.

---

## 8. The harness profile (data contract)

One JSON document is the whole "setup the server returns." Example:

```jsonc
{
  "profileVersion": 42,                 // monotonic; for admin/rollback bookkeeping
  "issuedAt": "2026-09-23T12:00:00Z",
  "ttlSeconds": 300,                    // client may reuse cache this long
  "minLauncherVersion": "1.4.0",        // version gate (§7)
  "claude": {
    "systemPrompt": "# mb-ai Operating Manual\n\n…",   // full markdown, inline → passed as --system-prompt string
    "mcpServers": {
      "task":       { "type": "http", "url": "https://api.mb/mcp/task",
                      "headers": { "Authorization": "Bearer <resolved-at-launch>" } },
      "blackboard": { "type": "http", "url": "https://api.mb/mcp/blackboard",
                      "headers": { "Authorization": "Bearer <resolved-at-launch>" } },
      "metrics":    { "type": "http", "url": "https://api.mb/mcp/metrics",
                      "headers": { "Authorization": "Bearer <resolved-at-launch>" } }
    },
    "allowedTools": [
      "list_ready_tasks","get_task_context","create_task","update_task",
      "complete_task","read_blackboard","describe_metric","query_metrics",
      "trend","compare_periods"
    ],
    "plugins": [{ "name": "mb-skills", "version": "1.7.0",
                  "url": "https://api.mb/plugins/mb-skills-1.7.0.zip",  // fetched → --plugin-dir
                  "sha256": "…",                                        // we verify before loading
                  "marketplace": "mb-skills",                           // for the install alternative
                  "source": "https://github.com/mb/mb-skills",          // MB-private marketplace
                  "acceptCommand": "sha256:…" }],                        // trust gate for install alt
    "flags": { "model": "claude-opus-…", "permission-mode": "default", "max-turns": null }
  }
}
```

Notes
- The launcher writes the **resolved bearer** into the on-disk `servers.json` (mode `600`) at
  launch and rewrites it each run — Claude Code does not expand `${VARS}` in `--mcp-config`.
- `allowedTools` is authoritative from the server (launcher expands each to its
  `mcp__<server>__<tool>` id) but is intersected with a **hard client-side ceiling** (§9) so a
  compromised server can't silently enable `run_sql` or other dangerous tools.
- `flags` is an open map → any future `claude` flag can be shipped from the backend without
  a launcher release. This is how "flags figured out and supplied by the backend" works.
- `plugins[]` carries the pinned version, a signed artifact **`url`** + **`sha256`** (fetched
  and verified for the recommended `--plugin-dir` delivery), plus **`marketplace`/`source`/
  `acceptCommand`** for the marketplace-install alternative.

### Skills plugin delivery

There is **no bare `--plugin name@marketplace` launch flag** (only `--plugin-dir` /
`--plugin-url`), so the launcher owns how `mb-skills` reaches the session. Four real options:

| Option | State | Warm-launch net | Who verifies bytes | Isolation |
|--------|-------|-----------------|--------------------|-----------|
| **`--plugin-dir` + local cache (recommended)** | our folder in `~/.mb-ai/plugins/` | none — we cache by version | **us** (sha/sig on the artifact) | clean, under `~/.mb-ai/` |
| `--plugin-url <zip>` | none (session) | claude re-fetches each session | claude fetches our URL | none |
| `claude plugin install` (marketplace) | persistent in `~/.claude` | none if current (reconcile) | marketplace `--accept-command` sha | writes to `~/.claude` |
| `~/.claude/skills/<name>/` (skills-dir) | persistent in `~/.claude` | none | none built-in | writes to `~/.claude` |

**Recommended: `--plugin-dir` against a version-pinned artifact we fetch ourselves** — it's the
same *fetch → verify → cache → pass-as-flag* pattern already used for the system prompt and
`servers.json`, just one more artifact:

```
pinned zip in ~/.mb-ai/plugins/mb-skills-<version>.zip ?
  missing → GET <url> → verify sha256/signature → cache
  present → skip (no network)
exec:  claude … --plugin-dir ~/.mb-ai/plugins/mb-skills-<version>.zip   # session-scoped
```

Why it wins for us: **we** own the supply chain (fetch + verify the exact pinned bytes — there
is no marketplace-declared install command to trust), it is session-scoped (no persistent
enable/disable state to drift), it stays isolated under `~/.mb-ai/`, and warm launches are
truly zero-network because we cache by version. `--plugin-dir` accepts a `.zip` directly, so no
unzip step is needed.

**When to prefer another:** use the **marketplace install** if you also want humans to get
these skills in their *own* bare `claude` sessions (discoverable, claude-managed updates) — it
keeps the `--accept-command <sha256>` trust gate. Use **`--plugin-url`** if you'd rather not
manage a local cache dir and accept a per-session re-fetch.

---

## 9. Trust & security

- **TLS everywhere**, ideally cert-pinned to the backend.
- **Client-side tool ceiling** — a compiled-in allowlist that `allowedTools` is intersected
  with. The server can *narrow* freely; it can never *exceed* the ceiling. `run_sql` stays out.
- **Token hygiene** — the bearer's durable home is the OS keychain; at launch it's written into
  `servers.json` (mode `600`, rewritten each run) since `--mcp-config` doesn't expand env vars.
  Optional server-side `jti` denylist for revocation.
- **Skills artifact verification** — with the recommended `--plugin-dir` delivery, the launcher
  downloads the pinned `mb-skills` zip and verifies its `sha256`/signature before loading it, so
  we own the exact bytes and no third-party install command runs. (The marketplace-install
  alternative instead keeps a pinned `--accept-command <sha256>` trust gate.)
- **Version gate** — `minLauncherVersion` lets the backend refuse dangerously old clients.
- **Signed releases** — the *package manager* handles integrity (Homebrew/npm checksums,
  or a checksum-verified `upgrade` subcommand). No bespoke manifest signing required.

---

## 10. Backend services

| Service | Endpoints | Job |
|---------|-----------|-----|
| **Auth** | `POST /auth/token` (password grant), `POST /auth/refresh`, `POST /auth/revoke` | mint/refresh/revoke bearer JWTs the MCP servers can validate. |
| **Harness API (control plane)** | `GET /harness/profile` | serve the ETag/CDN-cacheable fleet profile (incl. `minLauncherVersion`). |
| **MCP app servers** | `task`, `blackboard`, `metrics` (HTTP MCP) | the capabilities; validate the JWT; expose entity tools. `run_sql` exists but is *not* in the profile's allowed-tools. |
| **Skills artifacts** | MB-private: a versioned signed `mb-skills` **zip** (+`sha256`), and/or a marketplace | launcher fetches+verifies the pinned zip → `--plugin-dir` (recommended); marketplace `install` / `--plugin-url` are alternatives. |
| **Admin UI** | — | where operators edit the ONE profile (prompt, tools, flags, pinned versions). "The server controls everything." |
| **Releases** | Homebrew tap repo / npm registry / GitHub Releases | tool distribution — separate from the profile. |

Separation that matters: `/auth/*` is **per-user**; `/harness/profile` is **fleet-wide and
cacheable**. Auth identifies you; the profile is the same for everyone.

---

## 11. Resilience

- **Offline / backend down** → use last-known-good `cache/profile.json`, warn, continue.
  Never fetched before → hard fail with a clear message.
- **Config unchanged** → `304 Not Modified` via ETag makes launches fast and cheap.
- **Content-addressed assets** (system prompt by hash) → only re-download when it changes.

---

## 12. Local state & migrations

Local state carries a **`stateVersion`** (in `~/.mb-ai/config.toml`). When the on-disk layout,
config schema, or cache format changes, the migration that reaches the new shape **ships
inside the new launcher version** — an old version can't know a future format, so migrations
are always *forward-carried by the new code*. Same model as DB migrations (Alembic / Rails /
golang-migrate) and CLI configs (`gh`, `terraform`).

On launch, early (before real work):

```
compare disk stateVersion vs code stateVersion
  disk == code  → nothing to do
  disk <  code  → back up ~/.mb-ai → run migrations disk+1 … code in order → stamp new version
  disk >  code  → refuse: state newer than the tool → "upgrade the tool"
  disk <  floor → refuse: too old to migrate in place → "reinstall"
```

- **Whole ladder, not one step.** Package managers let people skip versions (v1 → v5 in one
  `brew upgrade`), so the new binary bundles every migration from the supported floor upward
  and runs the ones this machine is missing, in order. Don't delete old migrations.
- **Forward-only + safe.** Snapshot `~/.mb-ai` first; write atomically (temp → rename). No
  down-migrations for local state — only move forward.

### Who migrates what

| State | Migrated by | Trigger |
|-------|-------------|---------|
| **Local tool state** — `~/.mb-ai` root, config, cache, any local repo/clone | the **launcher** (ships in the new tool version) | `brew upgrade` / next launch |
| **Backend state** — the board, MCP databases | the **backend** (server-side, on deploy) | deploy |
| **Profile schema** — the §8 contract between them | nobody *migrates* it; it's **versioned + additive** and gated | — |

### Ordering guarantee (no chicken-and-egg)

A new profile must never demand a local state the running tool can't produce. The
`minLauncherVersion` gate (§7) enforces order:

```
backend raises minLauncherVersion
   → old client blocked, told to `brew upgrade`
   → new client boots → runs local migration up to the required stateVersion
   → only THEN consumes the new profile
```

The migration *lives in* the new tool version and the gate *forces* the tool upgrade first,
so it's always: tool upgrade (carries the migration) → local migrate-up → new profile
consumed. Three independent ladders — **code** via the package manager, **local state**
in-process on launch, **server state** server-side on deploy — coordinated by one version
number.

---

## 13. Suggested build order

1. **MVP walking skeleton** — launcher that: prompts login → `POST /auth/token` → keychain;
   fetches the profile; injects `MB_TOKEN`; execs `claude`. Proves the round-trip.
2. **Distribution** — publish via npm; the hard `minLauncherVersion` gate is already wired.
3. **Hardening** — client tool ceiling, ETag caching, refresh-on-launch, offline fallback.
4. **Control-plane polish** — admin UI, per-flag overrides, canary a profile version to a
   subset before fleet-wide rollout.

---

## Decisions log

- **2026-09-23 — No auth broker.** Bearer JWT is ~30 days; no session outlives it, so the
  mid-session token-refresh sidecar is unnecessary. Bake the token into `servers.json`
  (mode 600) at launch, refresh-on-launch. Broker demoted to an optional future path (only if
  TTL shrinks or central logging/policy is wanted). — §6
- **2026-09-23 — Standard distribution, not self-updating code.** Distribute the launcher via
  npm (public or private); update via `npm update -g`, enforced by a hard `minLauncherVersion`
  gate (no nudge, no self-update). The bespoke signed-manifest binary-self-replace idea is
  dropped. The *profile* stays a live server fetch (that was never a distribution problem). — §7
- **2026-09-23 — Update policy: hard version gate, manual update.** `core/gate.ts` blocks any
  launch where the launcher `VERSION` is below the profile's `minLauncherVersion`, printing the
  `npm update -g` command and exiting (code 2). No `update-notifier`, no self-update — the user
  is responsible for updating. — §7
- **2026-09-23 — Migrations are forward-carried by the new tool version.** Local state has a
  `stateVersion`; the launcher runs the missing migrations up on launch (whole ladder,
  forward-only, with backup). Ownership split: local state → launcher, backend state → server
  deploy, profile schema → versioned/additive + `minLauncherVersion` gate to guarantee
  ordering. — §12
- **2026-09-23 — Launcher is TypeScript, distributed via npm.** Wrapping Claude Code (a Node
  tool) means every user already has the Node runtime + npm, so runtime and distribution come
  free and the launcher shares an ecosystem with the thing it launches. Stack: commander,
  commander, @napi-rs/keyring, @inquirer/prompts, zod, execa. See `BUILD-PLAN.md`.
- **2026-09-23 — mb-ai owns the skills-plugin lifecycle.** Verified against Claude Code
  2.1.280: there is no bare `--plugin name@marketplace` launch flag, but a full `claude plugin`
  CLI exists (`marketplace add`, `install` with `--scope`/`--accept-command`, `list --json`,
  `update`). The launcher reconciles `mb-skills` to the profile's pinned version before exec,
  from an MB-private marketplace, with a pinned `--accept-command` sha as the trust gate.
  Stateless alternative: `--plugin-url` per launch. — §8 "Skills plugin delivery"
- **2026-09-23 — Skills delivered via `--plugin-dir` + a self-fetched pinned artifact (revised
  default).** Preferred over marketplace `install`: same fetch→verify→cache→flag pattern as the
  prompt and `servers.json`, we verify the exact pinned bytes ourselves (no marketplace install
  command to trust), it's session-scoped (no drift), isolated under `~/.mb-ai/`, and
  `--plugin-dir` takes a `.zip` directly (no unzip). Marketplace install kept for humans on bare
  `claude`; `--plugin-url` for the no-local-cache case. — §8
- **2026-09-23 — Flags verified live against claude 2.1.280** (`scripts/verify-flags.sh`).
  Working: `--system-prompt-file` (canary echoed), `--plugin-dir <dir|.zip>` loads a local plugin
  and runs its command with **no trust prompt**, `--mcp-config <file> --strict-mcp-config` loads
  servers, `--allowed-tools mcp__<server>__<tool>` gates/allows them. Corrections: prompt & mcp
  config are **plain paths** (no `@`); add **`--strict-mcp-config`**; tool ids are
  **`mcp__<server>__<tool>`**; `--allowed-tools`/`--mcp-config` are **variadic+greedy** (keep last);
  **`${VARS}` not expanded** in `--mcp-config` → bake the token into `servers.json` (mode 600). — §5, §6
- **2026-09-23 — Inline string for the prompt, file for the MCP config.** Verified both
  `--system-prompt "<str>"` and `--mcp-config '<json>'` work at runtime. Decision: pass the
  **system prompt as an inline string** (not secret; drop `operating-manual.md`), but keep the
  **MCP config a mode-600 file** — the string form embeds the bearer in argv (`ps` / EDR
  command-line logs), a worse exposure than a locked file. — §5
- **2026-09-23 — One tool, backend chosen by URL (no `--env`/registry).** There's a single
  released `mb-ai` (even on dev machines); dev vs prod = which backend it points at. Default =
  baked-in prod URL; override with `--backend-url` / `MB_AI_BACKEND_URL`. State + keychain are
  namespaced by backend **host** (`~/.mb-ai/backends/<host>/…`, `mb-ai/<host>/token`) so prod/dev
  never mix. Print the target each run. — §3

---

## Appendix — auth broker (only if token TTL shrinks)

If a future decision shortens the bearer TTL below plausible session length, reintroduce a
loopback sidecar: `claude` → `127.0.0.1:<port>` (broker) → upstream MCP, with the broker
attaching a fresh token per call and refreshing on `401`. Bind loopback only, random port,
per-session shared secret. This fully decouples token lifetime from session lifetime at the
cost of one extra process. Not needed at 30-day TTL.