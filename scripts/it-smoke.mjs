// Integration smoke test: stub backend + fake `claude`, no interactivity, no live services.
// Covers the happy path (profile → materialize → exec argv) AND the hard version gate.
import http from 'node:http'
import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

let failures = 0
const ok = (c, m) => { console.log(`${c ? '  PASS' : '  FAIL'}: ${m}`); if (!c) failures++ }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 30 * 86400
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'platform', exp })}.sig`

const baseProfile = (minLauncherVersion) => ({
  profileVersion: 1, minLauncherVersion,
  systemPrompt: '# mb-ai — Operating Manual (v1)\n\nYou are **mb-ai**…',
  mcpServers: {
    merchantbots: { type: 'http', url: 'http://x/mcp/merchantbots', headers: { Authorization: 'Bearer ${MB_TOKEN}' } },
    metrics: { type: 'http', url: 'http://x/mcp/seller-metrics-engine', headers: { Authorization: 'Bearer ${MB_TOKEN}' } },
  },
  allowedTools: ['mcp__merchantbots', 'mcp__metrics'],
  skills: { plugin: 'mb-skills', version: 'DUMMY' },
  flags: { model: 'claude-opus-4-8', 'permission-mode': 'default' },
})

async function serve(profile) {
  const bodyStr = JSON.stringify(profile)
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/auth/login') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_token: jwt, token_type: 'bearer', role: 'platform' }))
    }
    if (req.method === 'GET' && req.url === '/api/v1/mb-harness/profile') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(bodyStr)
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => server.close() }
}

// async spawn (NOT spawnSync) so the in-process stub server's event loop stays free to respond
function runLauncher(port) {
  const seg = `localhost:${port}`.replace(/[^a-zA-Z0-9._-]/g, '_')
  const backendDir = join(homedir(), '.mb-ai', 'backends', seg)
  const dir = mkdtempSync(join(tmpdir(), 'mbai-it-'))
  const argsFile = join(dir, 'args')
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${argsFile}"\nexit 0\n`)
  chmodSync(join(dir, 'claude'), 0o755)
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js', '--backend-url', `http://localhost:${port}`], {
      // MB_AI_TOKEN skips interactive login (and cross-process keychain prompts)
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MB_AI_TOKEN: jwt },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => {
      const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\0').filter((s) => s.length > 0) : null
      const sp = join(backendDir, 'cache', 'servers.json')
      const servers = existsSync(sp)
        ? { mode: (statSync(sp).mode & 0o777).toString(8), body: readFileSync(sp, 'utf8') }
        : null
      rmSync(dir, { recursive: true, force: true })
      rmSync(backendDir, { recursive: true, force: true })
      resolve({ status: code, stderr, args, servers })
    })
  })
}

// ── Case A: happy path (floor 0.1.0 == our version) ──────────────────────────
console.log('[A] happy path')
{
  const s = await serve(baseProfile('0.1.0'))
  const r = await runLauncher(s.port); s.close()
  ok(r.status === 0, `exit 0 (got ${r.status})`)
  ok(r.args?.includes('--system-prompt'), '--system-prompt passed')
  ok(r.args?.some((a) => a.startsWith('# mb-ai')), 'system prompt passed inline (string)')
  ok(r.args?.includes('--mcp-config') && r.args?.includes('--strict-mcp-config'), '--mcp-config + --strict-mcp-config')
  ok(r.args?.includes('--model') && r.args?.includes('claude-opus-4-8'), 'flags applied (--model)')
  ok(r.args?.includes('mcp__merchantbots') && r.args?.includes('mcp__metrics'), 'server-level allowed-tools passed')
  const at = r.args ? r.args.indexOf('--allowed-tools') : -1
  ok(at !== -1 && at === r.args.length - 3, '--allowed-tools is LAST (variadic-safe)')
  ok(r.servers?.mode === '600', `servers.json is mode 600 (got ${r.servers?.mode})`)
  ok(!!r.servers && r.servers.body.includes(jwt) && !r.servers.body.includes('${MB_TOKEN}'), 'bearer substituted (no placeholder left)')
}

// ── Case B: hard version gate (floor 9.9.9 > our version) ─────────────────────
console.log('[B] hard version gate')
{
  const s = await serve(baseProfile('9.9.9'))
  const r = await runLauncher(s.port); s.close()
  ok(r.status !== 0, `non-zero exit (got ${r.status})`)
  ok(/too old/i.test(r.stderr), 'message says the launcher is too old')
  ok(/npm i -g github:/i.test(r.stderr), 'message includes the GitHub install command')
  ok(r.args === null, 'claude was NOT executed')
  ok(r.servers === null, 'servers.json NOT written (blocked before materialize)')
}

console.log(failures === 0 ? '\n✅ integration smoke: all passed' : `\n❌ integration smoke: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
