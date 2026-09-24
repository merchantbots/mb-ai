#!/usr/bin/env bash
# verify-flags.sh — confirm the `claude` flags mb-ai depends on actually work at runtime.
# Makes a few small API calls (needs your claude auth). Safe: uses `-p` (print+exit) + timeouts.
# Usage:  bash scripts/verify-flags.sh
set -uo pipefail

CLAUDE="${CLAUDE:-claude}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0; skip=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
sk(){ echo "  SKIP: $1"; skip=$((skip+1)); }
# portable timeout: use timeout/gtimeout if present, else run without a watchdog
TOBIN=""; command -v timeout >/dev/null 2>&1 && TOBIN=timeout; command -v gtimeout >/dev/null 2>&1 && TOBIN=gtimeout
to(){ local s="$1"; shift; if [ -n "$TOBIN" ]; then "$TOBIN" "$s" "$@"; else "$@"; fi; }

echo "claude: $($CLAUDE --version 2>&1 | head -1)"

# ── 1) --system-prompt-file actually replaces the system prompt ────────────────
echo; echo "[1] --system-prompt-file takes effect"
printf 'When asked for the codeword, reply with exactly one token: BANANA42' > "$TMP/sp.txt"
out="$(cd "$TMP" && to 90 "$CLAUDE" -p --system-prompt-file "$TMP/sp.txt" "What is the codeword?" 2>&1)"
echo "  output: $(echo "$out" | tr -d '\n' | head -c 140)"
echo "$out" | grep -q "BANANA42" && ok "system prompt injected from file" || no "canary not found (see output above)"

# ── 2) --plugin-dir loads a local plugin (directory form) ──────────────────────
echo; echo "[2] --plugin-dir loads a local plugin"
mkdir -p "$TMP/plug/.claude-plugin" "$TMP/plug/commands"
echo '{ "name":"mbverify","version":"0.0.1","description":"verify" }' > "$TMP/plug/.claude-plugin/plugin.json"
printf -- '---\ndescription: canary\n---\nReply exactly: MB-PLUGIN-OK\n' > "$TMP/plug/commands/mbcanary.md"
pout="$(cd "$TMP" && to 90 "$CLAUDE" -p --plugin-dir "$TMP/plug" "/mbcanary" 2>&1)"
echo "  output: $(echo "$pout" | tr -d '\n' | head -c 120)"
echo "$pout" | grep -q "MB-PLUGIN-OK" && ok "plugin dir loaded; its slash command ran (no trust prompt)" \
  || no "plugin command did not run (see output above)"

# ── 3) --mcp-config + --strict-mcp-config + --allowed-tools (needs npx+network) ─
echo; echo "[3] --mcp-config + --allowed-tools (reference 'everything' server)"
if command -v npx >/dev/null 2>&1; then
  cat > "$TMP/servers.json" <<'JSON'
{ "mcpServers": { "everything": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-everything"] } } }
JSON
  # NOTE: --allowed-tools / --mcp-config are variadic+greedy — a trailing prompt gets
  # swallowed as a value. Put the prompt FIRST so the variadic flags can't eat it.
  out3="$(cd "$TMP" && to 180 "$CLAUDE" -p \
        "Use the echo tool with the exact message MB-MCP-OK, then show me only the tool's returned text." \
        --strict-mcp-config --mcp-config "$TMP/servers.json" --allowed-tools mcp__everything__echo 2>&1)"
  echo "  output: $(echo "$out3" | tr -d '\n' | head -c 180)"
  echo "$out3" | grep -q "MB-MCP-OK" \
    && ok "MCP loaded + allowed-tools accepts 'mcp__<server>__<tool>' and gates it" \
    || no "echo result not seen — check MCP tool naming / server startup (see output)"
else
  sk "npx not found — skipping MCP wiring check"
fi

echo
echo "── summary: $pass passed, $fail failed, $skip skipped ──"
echo "reminder: MCP config does NOT expand \${VARS} (confirmed literal) →"
echo "          the launcher must write the token into servers.json itself (chmod 600)."
