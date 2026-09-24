# mb-ai

A thin launcher for the `claude` CLI (Claude Code). It logs you in to the MerchantBots backend,
fetches your harness profile (system prompt, MCP servers, allowed tools, flags), wires it all
into `claude`, and hands off. The backend controls behavior — you just run `mb-ai`.

## Prerequisites

- **Node.js ≥ 18.17**
- **Claude Code** on your PATH — `npm i -g @anthropic-ai/claude-code`

## Install

Install the global `mb-ai` command from GitHub (no npm registry — always the latest `main`):

```bash
npm i -g github:equalcollective/mb-ai
```

Or run it once, without installing:

```bash
npx github:equalcollective/mb-ai
```

## Usage

```bash
mb-ai          # first run prompts you to log in, then launches claude
mb-ai doctor   # show the backend, auth status, and detected claude version
```

By default mb-ai talks to production (`https://api.merchantbots.com`). Your token is stored in
the OS keychain, namespaced per backend.

## Updating

There are no version tags — re-run the install to pull the latest `main`:

```bash
npm i -g github:equalcollective/mb-ai
```

If the backend requires a newer launcher than you have, mb-ai refuses to run and prints this
same command.

## Advanced

- **Point at a different backend** (e.g. local dev):
  ```bash
  mb-ai --backend-url http://localhost:8000
  # or, for the whole shell session:
  export MB_AI_BACKEND_URL=http://localhost:8000
  ```
- **Headless / no keychain** — supply a token via the environment to skip the prompt:
  ```bash
  MB_AI_TOKEN=<jwt> mb-ai
  ```
- `mb-ai logout` clears the stored token for the current backend.

## Development

See [CLAUDE.md](./CLAUDE.md) for internals, layout, and gotchas.
