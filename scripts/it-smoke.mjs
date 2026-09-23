// Integration smoke test: stub backend + fake `claude`, no interactivity, no live services.
// Proves: seeded token → GET /harness/profile → substitute bearer → write servers.json (600)
//         → exec `claude` with the correct argv (allowed-tools last, flags applied).
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

let failures = 0
const ok = (c, m) => { console.log(`${c ? '  PASS' : '  FAIL'}: ${m}`); if (!c) failures++ }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 30 * 86400
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'platform', exp })}.sig`

const profile = {
  profileVersion: 1, minLauncherVersion: '0.1.0', ttlSeconds: 300,
  systemPrompt: '# mb-ai — Operating Manual (v1)\n\nYou are **mb-ai**…',
  mcpServers: {
    merchantbots: { type: 'http', url: 'http://x/mcp/merchantbots', headers: { Authorization: 'Bearer ${MB_TOKEN}' } },
    metrics: { type: 'http', url: 'http://x/mcp/seller-metrics-engine', headers: { Authorization: 'Bearer ${MB_TOKEN}' } },
  },
  allowedTools: ['mcp__merchantbots', 'mcp__metrics'],
  skills: { plugin: 'mb-skills', version: 'DUMMY' },
  flags: { model: 'claude-opus-4-8', 'permission-mode': 'default' },
}
const bodyStr = JSON.stringify(profile)
const etag = '"' + createHash('sha256').update(bodyStr).digest('hex').slice(0, 16) + '"'

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/auth/login') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ access_token: jwt, token_type: 'bearer', role: 'platform' }))
  }
  if (req.method === 'GET' && req.url === '/api/v1/harness/profile') {
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json', ETag: etag, 'cache-control': 'max-age=300' })
    return res.end(bodyStr)
  }
  res.writeHead(404); res.end()
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const host = `localhost:${port}`
const seg = host.replace(/[^a-zA-Z0-9._-]/g, '_')
const backendDir = join(homedir(), '.mb-ai', 'backends', seg)

// fake `claude` that records its argv (NUL-separated, so multi-line args survive) and exits 0
const dir = mkdtempSync(join(tmpdir(), 'mbai-it-'))
const argsFile = join(dir, 'args')
writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${argsFile}"\nexit 0\n`)
chmodSync(join(dir, 'claude'), 0o755)

try {
  // async spawn (NOT spawnSync — that would block the event loop and starve the stub server)
  const r = await new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js', '--backend-url', `http://localhost:${port}`, '--verbose'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MB_AI_TOKEN: jwt },
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.stdout.on('data', () => {})
    const to = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', (status, signal) => { clearTimeout(to); resolve({ status, signal, stderr }) })
  })
  if (r.status !== 0) {
    console.log(`  [debug] status=${r.status} signal=${r.signal}`)
    console.log(`  [debug] stderr:\n${(r.stderr || '').split('\n').map((l) => '    ' + l).join('\n')}`)
  }
  ok(r.status === 0, `mb-ai exited 0 (got ${r.status})`)

  const args = readFileSync(argsFile, 'utf8').split('\0').filter((s) => s.length > 0)
  const has = (v) => args.includes(v)
  ok(has('--system-prompt'), '--system-prompt passed')
  ok(args.some((a) => a.startsWith('# mb-ai')), 'system prompt passed inline (string)')
  ok(has('--mcp-config') && has('--strict-mcp-config'), '--mcp-config + --strict-mcp-config passed')
  ok(has('--model') && has('claude-opus-4-8'), 'flags applied (--model)')
  ok(has('--permission-mode') && has('default'), 'flags applied (--permission-mode)')
  ok(has('mcp__merchantbots') && has('mcp__metrics'), 'server-level allowed-tools passed')
  const at = args.indexOf('--allowed-tools')
  ok(at !== -1 && at === args.length - 3, '--allowed-tools is LAST (variadic-safe)')

  const sp = join(backendDir, 'cache', 'servers.json')
  const mode = (statSync(sp).mode & 0o777).toString(8)
  const sj = readFileSync(sp, 'utf8')
  ok(mode === '600', `servers.json is mode 600 (got ${mode})`)
  ok(sj.includes(jwt) && !sj.includes('${MB_TOKEN}'), 'bearer substituted into servers.json (no placeholder left)')
} finally {
  server.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(backendDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ integration smoke: all passed' : `\n❌ integration smoke: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
