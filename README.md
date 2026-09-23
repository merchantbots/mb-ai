# mb-ai

The MerchantBots harness launcher. Wraps Claude Code: fetches the current harness profile
(system prompt, MCP links, flags) from the backend and execs the real `claude` with it.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).

## Install (dev)

```bash
npm install
npm run build
```

## Use

```bash
# prod (baked-in default backend)
mb-ai login
mb-ai

# dev backend
mb-ai --backend-url http://localhost:8000 login
mb-ai --backend-url http://localhost:8000
# or: export MB_AI_BACKEND_URL=http://localhost:8000

mb-ai doctor      # backend, auth status, claude version
mb-ai logout
```

### Headless / CI

Set `MB_AI_TOKEN` to a bearer to skip both the keychain and interactive login (useful where
the OS keychain isn't available):

```bash
MB_AI_TOKEN=<jwt> mb-ai --backend-url http://localhost:8000
```

Run the end-to-end smoke test (stub backend + fake `claude`, no live services):

```bash
npm run build && npm run test:it
```

## How it works (per run)

1. Resolve the backend URL (`--backend-url` / `MB_AI_BACKEND_URL` / baked-in prod default).
2. Ensure a valid token (keychain, keyed by backend host; re-login on expiry — no refresh).
3. `GET /api/v1/harness/profile` (ETag-cached; offline → last-known-good).
4. Substitute the bearer into `mcpServers`, write `servers.json` (mode 600); prompt stays inline.
5. Exec `claude --system-prompt "…" --mcp-config servers.json --strict-mcp-config <flags> --allowed-tools …`.
