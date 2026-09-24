# mb-ai

Thin launcher that wraps the real `claude` CLI: on each run it fetches a harness profile from
the backend (system prompt, MCP config, allowed-tools, flags), writes `servers.json`, and execs
`claude`. The backend controls behavior; users install prebuilt tarballs from GitHub Releases.

## Commands

```bash
npm ci                 # install (also builds via the prepare hook)
npm run typecheck      # tsc --noEmit
npm run test:it        # builds, then runs the stub-backend + fake-claude smoke test

mb-ai --backend-url http://localhost:8000   # auto-prompts login on first run
mb-ai doctor
mb-ai profile                               # dump the harness profile the backend returns (diagnostic)
# headless / no keychain: set MB_AI_TOKEN=<jwt> to skip the prompt
# hidden utilities: mb-ai login (pre-auth) · mb-ai logout (wipe token)
```

## Layout

`src/index.ts` (commander entry) · `src/commands/` (run, login, logout, doctor, profile). Core is flat in
`src/`: `config` (backend + on-disk paths) · `session` (keychain + JWT + login/token) · `profile`
(zod schema + fetch) · `launch` (version gate + servers.json + exec claude) · `skills` (download +
cache the plugin bundle → `--plugin-dir`) · `errors` (types + parseError + `backendReport`, the
share-with-the-team dump for backend 5xx) · `log` · `version`. Built bin: `dist/index.js`.

## Gotchas (verified vs claude 2.1.280)

- Claude Code does **not** expand `${VARS}` in `--mcp-config`, so the launcher bakes the token
  into `servers.json` (mode 600) — keep it a file, never an argv string.
- Tool ids are `mcp__<server>__<tool>`; `--allowed-tools` / `--mcp-config` are variadic → emit last.
- the version gate in `launch.ts` hard-blocks a launcher older than the profile's `minLauncherVersion`.
- `profile.skills` is the MB skills **plugin**. `skills.ts` caches it under
  `~/.mb-ai/backends/<host>/skills/<commit>/`, keyed by the profile's `commit` (re-downloads only
  when it changes; tells the user first), and passes the unpacked plugin root to
  `claude --plugin-dir`. `--plugin-dir` is per-path/repeatable (safe before `--allowed-tools`) and
  loads for that session only. A skills fetch failure degrades (cached copy, else launch without
  them) — it never blocks the session. Bundle must be a tarball (or a zip claude can load).

## Releasing

Distributed as prebuilt npm tarballs on GitHub Releases — not the npm registry, and **not** a
`github:` git install (that builds on the user's machine and fails if their npm skips devDeps).
To cut a release: bump `package.json`, commit, then `git tag vX.Y.Z && git push --tags`.
`release.yml` builds, runs `npm pack` (bundles `dist/` via the `files` field), and uploads the
tarball as both `mb-ai-X.Y.Z.tgz` (pinnable) and `mb-ai.tgz` (the "latest" asset). Users install
with `npm i -g <asset-url>` — no build step. `VERSION` is injected from `package.json` at build
(tsup `define`), so the tag, `package.json`, and `--version` all agree.

The version gate is a *mandatory floor*, not an "update available" notice: it only fires when a
launcher is below the backend's `minLauncherVersion`, and ordinary releases reach users only when
they reinstall. To force an update, move BOTH together — ship a release whose `package.json`
version is X.Y.Z **and** raise the backend's `minLauncherVersion` to X.Y.Z. Never raise the
backend floor above the newest published release, or every launcher (fresh installs included)
gets gated with no version able to satisfy it.

## Commits

Author as the committer only — no `Co-Authored-By: Claude` or AI attribution. Commit/push only when asked.
