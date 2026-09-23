# mb-ai — Profile Endpoint

> One request returns the **entire** harness setup: the system-prompt markdown, the MCP
> config, the allowed-tools, and the `claude` flags — all inline, in a single JSON body.
> The launcher calls this on every run, writes **one** file (`servers.json`, mode 600), passes the prompt inline, and execs `claude`. (Flags verified vs claude 2.1.280 — see `scripts/verify-flags.sh`.)

---

## Request

```
GET /harness/profile
```

| Header | Required | Value |
|--------|----------|-------|
| `Authorization` | yes | `Bearer <token>` — the ~30-day JWT from `/auth/token`. |
| `If-None-Match` | no | `"<etag>"` — the ETag of the last cached profile. Sent on warm launches so an unchanged profile comes back as `304`. |
| `Accept` | no | `application/json` |
| `User-Agent` | no | `mb-ai/<launcher-version>` — lets the backend evaluate `minLauncherVersion`. |

### Example

```bash
curl https://api.mb.ai/harness/profile \
  -H "Authorization: Bearer $MB_TOKEN" \
  -H 'If-None-Match: "a1b2c3"' \
  -H 'Accept: application/json'
```

---

## Responses

### `200 OK` — here's the current setup

Returned when there is no `If-None-Match`, or the profile changed since that ETag.

Response headers:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `ETag` | `"<hash of this profile>"` — the launcher stores it and sends it back next time. |

Body:

```jsonc
{
  "profileVersion": 42,                 // monotonic; admin/rollback bookkeeping
  "minLauncherVersion": "1.4.0",        // launcher below this is warned / blocked
  "ttlSeconds": 300,                    // optional: client may reuse cache this long before re-asking

  "systemPrompt": "# mb-ai Operating Manual\n\nYou are the MB harness…\n\n## The board\n…",

  "mcpServers": {
    "task":       { "type": "http", "url": "https://api.mb.ai/mcp/task",
                    "headers": { "Authorization": "Bearer ${MB_TOKEN}" } },
    "blackboard": { "type": "http", "url": "https://api.mb.ai/mcp/blackboard",
                    "headers": { "Authorization": "Bearer ${MB_TOKEN}" } },
    "metrics":    { "type": "http", "url": "https://api.mb.ai/mcp/metrics",
                    "headers": { "Authorization": "Bearer ${MB_TOKEN}" } }
  },

  "allowedTools": [
    "list_ready_tasks", "get_task_context", "create_task", "update_task",
    "complete_task", "read_blackboard", "describe_metric", "query_metrics",
    "trend", "compare_periods"
  ],

  "flags": { "model": "claude-opus-…", "permission-mode": "default" }
}
```

### `304 Not Modified` — nothing changed

Returned when `If-None-Match` matches the current profile. **No body.** The launcher uses its
cached profile. This is the common case on warm launches.

### `401 Unauthorized` — token bad or expired

The launcher refreshes (`POST /auth/refresh`) or re-prompts login, then retries once.

### Network error / backend unreachable

Not an HTTP status — the launcher falls back to the last-known-good cached profile and warns.
If it has never fetched successfully, it fails with a clear message.

---

## Body fields

| Field | Type | Notes |
|-------|------|-------|
| `profileVersion` | int | Monotonic version of the profile, for admin/rollback bookkeeping. |
| `minLauncherVersion` | string (semver) | If the launcher is older, it warns or hard-blocks. |
| `ttlSeconds` | int? | Optional. Client may reuse the cached profile this long before re-requesting. |
| `systemPrompt` | string | The **full operating-manual markdown, inline**. Passed **inline as `--system-prompt "<str>"`** (verified) — no file written. Newlines/quotes are JSON-escaped (`\n`, `\"`). |
| `mcpServers` | object | The MCP config, inline (token-free — carries a `${MB_TOKEN}` placeholder). The **launcher substitutes the real bearer** and writes `servers.json` (**mode 600**): Claude Code does not expand `${VARS}` in `--mcp-config` (verified), and the string form is avoided so the token stays out of argv / EDR logs. |
| `allowedTools` | string[] | Server-authoritative tool allowlist (bare names). The launcher expands each to its `mcp__<server>__<tool>` id, then intersects with a compiled-in client ceiling (server can narrow, never exceed). |
| `flags` | object | Open map of `claude` CLI flags (e.g. `model`, `permission-mode`). New flags can ship from the backend without a launcher release. |

---

## What the launcher does with a `200`

```
validate body (zod)
  → inject the bearer into mcpServers → write servers.json (mode 600)   [only file written]
  → cache the whole JSON body (token-free) + store the ETag
  → exec:  claude \
             --system-prompt "<systemPrompt — inline string>" \
             --mcp-config    ~/.mb-ai/cache/servers.json  --strict-mcp-config \
             --plugin-dir    ~/.mb-ai/plugins/mb-skills-<v>.zip \
             --allowed-tools mcp__<server>__<tool> …   # variadic → keep last
             <flags>
```

The prompt is passed inline and `servers.json` is written from this **one** response — no second
fetch, and only the token-bearing config touches disk (mode 600).

---

## Caching, in one line

One `ETag` covers the whole document. Change the prompt, MCP config, tools, or a flag → the
ETag changes → next launch gets a `200` with the full new payload. Otherwise → `304`.
