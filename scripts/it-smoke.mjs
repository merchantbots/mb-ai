// Integration smoke test: stub backend + fake `claude`, no interactivity, no live services.
// Covers the happy path (profile → materialize → exec argv), the hard version gate, and the
// skills plugin sync (fresh download, cache-hit reuse, commit-change re-download).
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

let failures = 0
const ok = (c, m) => { console.log(`${c ? '  PASS' : '  FAIL'}: ${m}`); if (!c) failures++ }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 30 * 86400
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'platform', exp })}.sig`

// Hermetic defaults: every launch points Claude-state reads at files that don't exist, so the
// launcher never touches the real ~/.claude* and never reports usage unless a case opts in.
const NO_CLAUDE = join(tmpdir(), 'mbai-nonexistent-claude.json')

// A throwaway ~/.claude.json fixture for the usage-reporting cases.
function claudeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mbai-claude-'))
  const cfgPath = join(dir, 'claude.json')
  writeFileSync(cfgPath, JSON.stringify({
    machineID: 'machine-xyz',
    oauthAccount: {
      emailAddress: 'u@example.com', accountUuid: 'acc-1', organizationName: 'Org',
      organizationRole: 'admin', organizationRateLimitTier: 'default_claude_max_20x',
    },
    cachedUsageUtilization: {
      fetchedAtMs: 1700000000000, accountUuid: 'acc-1',
      utilization: {
        five_hour: { utilization: 39, resets_at: '2026-10-07T21:00:00Z' },
        seven_day: { utilization: 50, resets_at: '2026-10-09T19:00:00Z' },
        limits: [{ kind: 'session', group: 'session', percent: 39 }],
      },
    },
  }))
  return { dir, cfgPath }
}

// Force a report on this launch: pin the backend's interval to 0 so nothing is throttled.
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

// Force a report on this launch: pin the backend's interval to 0 so nothing is throttled.
const reportNow = (minLauncherVersion) => ({ ...baseProfile(minLauncherVersion), usage: { reportIntervalMs: 0 } })

// Point the profile at the stub's download route for a given commit (git-archive style bundle).
const withSkills = (profile, port, commit) => ({
  ...profile,
  skills: {
    plugin: 'mb-skills',
    commit,
    downloadUrl: `http://localhost:${port}/api/v1/mb-harness/skills/download?ref=${commit}`,
  },
})

// A real plugin tarball, git-archive style: everything nested under a single `mb-skills/` dir, so
// the launcher must descend into the wrapper to find `.claude-plugin/plugin.json`.
function pluginTarball(commit) {
  const root = mkdtempSync(join(tmpdir(), 'mbai-plug-'))
  const plug = join(root, 'mb-skills')
  mkdirSync(join(plug, '.claude-plugin'), { recursive: true })
  mkdirSync(join(plug, 'skills', 'hello'), { recursive: true })
  writeFileSync(join(plug, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'mb-skills', version: '0.0.1', description: `probe ${commit}` }))
  writeFileSync(join(plug, 'skills', 'hello', 'SKILL.md'), `---\nname: hello\ndescription: probe skill\n---\nSay hello.\n`)
  const tgz = join(root, 'bundle.tgz')
  const r = spawnSync('tar', ['-czf', tgz, '-C', root, 'mb-skills'])
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`)
  const buf = readFileSync(tgz)
  rmSync(root, { recursive: true, force: true })
  return buf
}

// Stub backend with mutable state so ONE server (one port → one on-disk backend dir) can serve an
// updated profile/archive across runs — needed to exercise cache reuse and re-download.
async function serve(initial) {
  const state = { downloads: 0, unauth: 0, archive: Buffer.alloc(0), usage: [], ...initial }
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/auth/login') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_token: jwt, token_type: 'bearer', role: 'platform' }))
    }
    // Everything under /mb-harness requires the same bearer as the profile curl — the skills
    // download included. A missing/wrong Authorization header is a 401 (proves the launcher sends it).
    if (req.url.startsWith('/api/v1/mb-harness/') && req.headers.authorization !== `Bearer ${jwt}`) {
      state.unauth++
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 'AUTH_UNAUTHENTICATED', message: 'Not authenticated' }))
    }
    if (req.method === 'GET' && req.url === '/api/v1/mb-harness/profile') {
      if (state.profileError) {
        res.writeHead(state.profileError.status, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(state.profileError.body))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(state.profile))
    }
    // Usage reporting sink: record each posted body (or simulate a failure via state.usageError).
    if (req.method === 'POST' && req.url === '/api/v1/mb-harness/usage') {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        if (state.usageError) {
          res.writeHead(state.usageError, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ code: 'ERR', message: 'usage boom' }))
        }
        try { state.usage.push(JSON.parse(raw)) } catch { state.usage.push(null) }
        res.writeHead(204)
        res.end()
      })
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/mb-harness/skills/download')) {
      state.downloads++
      res.writeHead(200, { 'content-type': 'application/gzip' })
      return res.end(state.archive)
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => server.close(), state }
}

// async spawn (NOT spawnSync) so the in-process stub server's event loop stays free to respond.
// keepBackend leaves ~/.mb-ai/backends/<host> in place so a later run can hit the skills cache.
function runLauncher(port, { keepBackend = false, env: extraEnv = {} } = {}) {
  const seg = `localhost:${port}`.replace(/[^a-zA-Z0-9._-]/g, '_')
  const backendDir = join(homedir(), '.mb-ai', 'backends', seg)
  const dir = mkdtempSync(join(tmpdir(), 'mbai-it-'))
  const argsFile = join(dir, 'args')
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${argsFile}"\nexit 0\n`)
  chmodSync(join(dir, 'claude'), 0o755)
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js', '--backend-url', `http://localhost:${port}`], {
      // MB_AI_TOKEN skips interactive login (and cross-process keychain prompts).
      // NO_COLOR keeps output plain so assertions match regardless of the runner's TTY/FORCE_COLOR.
      // MB_AI_CLAUDE_* keep usage reads hermetic (overridden by cases that exercise reporting).
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, MB_AI_TOKEN: jwt, NO_COLOR: '1',
        MB_AI_CLAUDE_CONFIG: NO_CLAUDE, ...extraEnv,
      },
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
      const statePath = join(backendDir, 'skills', 'state.json')
      const skillsState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
      const pi = args ? args.indexOf('--plugin-dir') : -1
      const pluginDir = pi !== -1 ? args[pi + 1] : null
      rmSync(dir, { recursive: true, force: true })
      if (!keepBackend) rmSync(backendDir, { recursive: true, force: true })
      resolve({ status: code, stderr, args, servers, skillsState, pluginDir, backendDir })
    })
  })
}

// Run the `doctor` subcommand and capture its stdout (the config preview prints there).
function runDoctor(port, env = {}) {
  return runSub(port, 'doctor', env)
}
// Run the `profile` subcommand and capture its stdout (the JSON dump prints there).
function runProfile(port) {
  return runSub(port, 'profile')
}
function runSub(port, sub, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/index.js', '--backend-url', `http://localhost:${port}`, sub], {
      env: {
        ...process.env, MB_AI_TOKEN: jwt, NO_COLOR: '1',
        MB_AI_CLAUDE_CONFIG: NO_CLAUDE, ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.on('close', (code) => resolve({ status: code, stdout }))
  })
}

// ── Case A: happy path (floor 0.1.0 == our version) ──────────────────────────
console.log('[A] happy path')
{
  const s = await serve({ profile: baseProfile('0.1.0') })
  const r = await runLauncher(s.port); s.close()
  ok(r.status === 0, `exit 0 (got ${r.status})`)
  ok(r.args?.includes('--system-prompt'), '--system-prompt passed')
  ok(r.args?.some((a) => a.startsWith('# mb-ai')), 'system prompt passed inline (string)')
  ok(r.args?.includes('--mcp-config') && r.args?.includes('--strict-mcp-config'), '--mcp-config + --strict-mcp-config (default ON when profile silent)')
  ok(r.args?.includes('--model') && r.args?.includes('claude-opus-4-8'), 'flags applied (--model)')
  ok(r.args?.includes('mcp__merchantbots') && r.args?.includes('mcp__metrics'), 'server-level allowed-tools passed')
  const at = r.args ? r.args.indexOf('--allowed-tools') : -1
  ok(at !== -1 && at === r.args.length - 3, '--allowed-tools is LAST (variadic-safe)')
  ok(!r.args?.includes('--plugin-dir'), 'no --plugin-dir when skills carry no commit/downloadUrl')
  ok(r.servers?.mode === '600', `servers.json is mode 600 (got ${r.servers?.mode})`)
  ok(!!r.servers && r.servers.body.includes(jwt) && !r.servers.body.includes('${MB_TOKEN}'), 'bearer substituted (no placeholder left)')
}

// ── Case A2: backend turns MCP isolation OFF ──────────────────────────────────
// `strict-mcp-config: false` in the profile flags → the launcher omits
// --strict-mcp-config, so claude also loads the user's own MCP servers.
console.log('[A2] backend disables --strict-mcp-config')
{
  const p = baseProfile('0.1.0')
  p.flags = { ...p.flags, 'strict-mcp-config': false }
  const s = await serve({ profile: p })
  const r = await runLauncher(s.port); s.close()
  ok(r.status === 0, `exit 0 (got ${r.status})`)
  ok(r.args?.includes('--mcp-config'), '--mcp-config still passed (our servers.json)')
  ok(!r.args?.includes('--strict-mcp-config'), '--strict-mcp-config omitted when profile sets it false')
}

// ── Case B: hard version gate (floor 9.9.9 > our version) ─────────────────────
console.log('[B] hard version gate')
{
  const s = await serve({ profile: baseProfile('9.9.9') })
  const r = await runLauncher(s.port); s.close()
  ok(r.status !== 0, `non-zero exit (got ${r.status})`)
  ok(/too old/i.test(r.stderr), 'message says the launcher is too old')
  ok(/npm i -g https:\/\/github\.com\/.+\.tgz/i.test(r.stderr), 'message includes the release tarball install command')
  ok(r.args === null, 'claude was NOT executed')
  ok(r.servers === null, 'servers.json NOT written (blocked before materialize)')
}

// ── Case C/D/E: skills plugin sync (download → cache reuse → re-download) ──────
console.log('[C/D/E] skills plugin sync')
{
  const c1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const c2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const s = await serve({ profile: withSkills(baseProfile('0.1.0'), 0, c1) })
  // now we know the port → point the profile's downloadUrl at it and load the archive
  s.state.profile = withSkills(baseProfile('0.1.0'), s.port, c1)
  s.state.archive = pluginTarball(c1)

  // [C] fresh: downloads once, wires --plugin-dir at the plugin root, tells the user
  const r1 = await runLauncher(s.port, { keepBackend: true })
  ok(r1.status === 0, `[C] exit 0 (got ${r1.status})`)
  ok(s.state.downloads === 1, `[C] downloaded exactly once (got ${s.state.downloads})`)
  ok(s.state.unauth === 0, `[C] download sent the Authorization bearer (no 401s; got ${s.state.unauth})`)
  ok(/fetching skills/i.test(r1.stderr), '[C] tells the user it is fetching skills')
  ok(!!r1.pluginDir && r1.pluginDir.includes(join(r1.backendDir, 'skills', c1)), `[C] --plugin-dir under skills/<commit> (got ${r1.pluginDir})`)
  ok(!!r1.pluginDir && existsSync(join(r1.pluginDir, '.claude-plugin', 'plugin.json')), '[C] --plugin-dir points at the plugin root (found .claude-plugin/plugin.json)')
  ok(r1.skillsState?.commit === c1, `[C] state.json records the commit (got ${r1.skillsState?.commit})`)
  const at1 = r1.args ? r1.args.indexOf('--allowed-tools') : -1
  ok(at1 !== -1 && at1 === r1.args.length - 3, '[C] --allowed-tools still LAST (after --plugin-dir)')

  // [D] cache hit: same commit → no second download, no chatter, same plugin path
  const r2 = await runLauncher(s.port, { keepBackend: true })
  ok(s.state.downloads === 1, `[D] cache hit — did NOT re-download (got ${s.state.downloads})`)
  ok(!/fetching skills|re-downloading/i.test(r2.stderr), '[D] no download message on a cache hit')
  ok(r2.pluginDir === r1.pluginDir, '[D] reuses the same --plugin-dir path')

  // [E] commit changes → re-download, new plugin path, prune the old bundle
  s.state.profile = withSkills(baseProfile('0.1.0'), s.port, c2)
  s.state.archive = pluginTarball(c2)
  const r3 = await runLauncher(s.port, { keepBackend: true })
  ok(s.state.downloads === 2, `[E] re-downloaded on commit change (got ${s.state.downloads})`)
  ok(/re-downloading/i.test(r3.stderr), '[E] tells the user it is re-downloading')
  ok(!!r3.pluginDir && r3.pluginDir.includes(join(r3.backendDir, 'skills', c2)), `[E] --plugin-dir now under the new commit (got ${r3.pluginDir})`)
  ok(r3.skillsState?.commit === c2, `[E] state.json advanced to the new commit (got ${r3.skillsState?.commit})`)
  ok(!existsSync(join(r3.backendDir, 'skills', c1)), '[E] pruned the previous commit bundle')

  s.close()
  rmSync(r1.backendDir, { recursive: true, force: true })
}

// ── Case F: `doctor` previews the launch config ──────────────────────────────
console.log('[F] doctor config preview')
{
  const commit = 'cccccccccccccccccccccccccccccccccccccccc'
  const s = await serve({ profile: withSkills(baseProfile('0.1.0'), 0, commit) })
  s.state.profile = withSkills(baseProfile('0.1.0'), s.port, commit)
  s.state.archive = pluginTarball(commit)
  const d = await runDoctor(s.port)
  ok(d.status === 0, `[F] exit 0 (got ${d.status})`)
  ok(/^model\s+claude-opus-4-8/m.test(d.stdout), '[F] shows the model flag')
  ok(/^mode\s+default\s+\(permission-mode\)/m.test(d.stdout), '[F] shows the permission mode')
  ok(/^tools\s+mcp__merchantbots, mcp__metrics/m.test(d.stdout), '[F] lists the allowed MCP tools')
  ok(/^skills\s+mb-skills @ cccccccc/m.test(d.stdout), '[F] shows the skills plugin + commit')
  ok(d.stdout.includes(join('skills', commit)) || /not cached/.test(d.stdout), '[F] shows the skills directory / cache state')
  ok(/merchantbots/.test(d.stdout) && /seller-metrics-engine/.test(d.stdout), '[F] shows each MCP server URL')
  ok(s.state.downloads === 0, `[F] doctor is read-only — no skills download (got ${s.state.downloads})`)
  s.close()
}

// ── Case G: a backend 5xx prints the raw response + a "share with the team" ask ──
console.log('[G] backend error → shareable report')
{
  const envelope = {
    code: 'SYSTEM_INTERNAL_ERROR', type: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred', statusCode: 500,
    traceId: 'trace-abc-123', details: { debug: { exception: 'ValueError' } },
  }
  const s = await serve({ profile: baseProfile('0.1.0') })
  s.state.profileError = { status: 500, body: envelope }

  const r = await runLauncher(s.port)
  ok(r.status !== 0, `[G] run exits non-zero (got ${r.status})`)
  ok(r.args === null, '[G] claude was NOT executed')
  ok(/tech team/i.test(r.stderr), '[G] asks the user to share it with the tech team')
  ok(/HTTP 500/.test(r.stderr) && /SYSTEM_INTERNAL_ERROR/.test(r.stderr), '[G] shows status + code')
  ok(/trace-abc-123/.test(r.stderr), '[G] surfaces the trace id')
  ok(/An unexpected error occurred/.test(r.stderr) && /ValueError/.test(r.stderr), '[G] includes the verbatim response body')

  const d = await runDoctor(s.port); s.close()
  ok(/tech team/i.test(d.stdout) && /trace-abc-123/.test(d.stdout), '[G] doctor shows the same shareable report')
}

// ── Case H: `mb-ai profile` prints valid, pretty JSON (highlight is pipe-safe) ──
console.log('[H] profile prints valid JSON')
{
  const s = await serve({ profile: baseProfile('0.1.0') })
  const p = await runProfile(s.port); s.close()
  ok(p.status === 0, `[H] exit 0 (got ${p.status})`)
  let parsed = null
  try { parsed = JSON.parse(p.stdout) } catch {}
  ok(parsed !== null, '[H] NO_COLOR output is valid JSON (pipe-safe)')
  ok(parsed?.profileVersion === 1 && !!parsed?.mcpServers?.merchantbots, '[H] round-trips the profile fields')
  ok(/\n  "profileVersion":/.test(p.stdout), '[H] pretty-printed (2-space indent)')
}

// ── Case I: usage reporting (reads ~/.claude.json, POSTs the account's limits, prints a summary) ─
console.log('[I] usage reporting')
{
  const fix = claudeFixture()
  // The backend pins the report interval to 0 (system-wide), so this launch always reports.
  const s = await serve({ profile: reportNow('0.1.0') })
  const r = await runLauncher(s.port, { env: { MB_AI_CLAUDE_CONFIG: fix.cfgPath } })
  ok(r.status === 0, `[I] exit 0 (got ${r.status})`)
  ok(r.args?.includes('--system-prompt'), '[I] claude still launched after reporting')
  ok(s.state.usage.length === 1, `[I] reported usage exactly once (got ${s.state.usage.length})`)
  ok(s.state.unauth === 0, '[I] usage POST carried the Authorization bearer (no 401s)')
  const body = s.state.usage[0]
  ok(body?.email === 'u@example.com' && body?.accountUuid === 'acc-1', '[I] body carries the per-account identity')
  ok(body?.machineId === 'machine-xyz' && body?.rateLimitTier === 'default_claude_max_20x', '[I] body carries machineId + rate-limit tier')
  ok(body?.limits?.fiveHour?.utilization === 39 && body?.limits?.sevenDay?.utilization === 50, '[I] body carries session (5h) + weekly (7d) utilization')
  ok(body?.limits?.stale === undefined, '[I] no stale flag in the body (removed)')
  ok(body?.tokens === undefined, '[I] no token/stats-cache data in the body (removed)')
  ok(typeof body?.reportedAt === 'string' && typeof body?.launcherVersion === 'string', '[I] body stamps reportedAt + launcherVersion')
  ok(/usage · u@example\.com/.test(r.stderr), '[I] prints a one-line usage summary to the terminal')

  // doctor shows the same snapshot read-only (no extra POST)
  const d = await runDoctor(s.port, { MB_AI_CLAUDE_CONFIG: fix.cfgPath })
  ok(/^account\s+u@example\.com/m.test(d.stdout), '[I] doctor shows the signed-in account')
  ok(/^session\s+39%/m.test(d.stdout), '[I] doctor shows session (5-hour) utilization')
  ok(/^weekly\s+50%/m.test(d.stdout), '[I] doctor shows weekly (7-day) utilization')
  ok(!/^tokens/m.test(d.stdout), '[I] doctor shows no machine-wide tokens line (removed)')
  ok(s.state.usage.length === 1, '[I] doctor is read-only — did NOT post usage')

  s.close()
  rmSync(fix.dir, { recursive: true, force: true })
}

// ── Case J: no signed-in Claude account → usage skipped, launch unaffected ────
console.log('[J] no Claude account → usage skipped')
{
  // Interval 0 (never throttled) proves it's the absent ~/.claude.json, not the throttle, that
  // suppresses the report — the hermetic default points MB_AI_CLAUDE_CONFIG at a missing file.
  const s = await serve({ profile: reportNow('0.1.0') })
  const r = await runLauncher(s.port)
  s.close()
  ok(r.status === 0, `[J] exit 0 (got ${r.status})`)
  ok(r.args?.includes('--system-prompt'), '[J] claude still launched')
  ok(s.state.usage.length === 0, `[J] no usage reported when not signed into Claude (got ${s.state.usage.length})`)
  ok(!/usage ·/.test(r.stderr), '[J] no usage summary line printed')
}

// ── Case K: usage endpoint fails → launch still succeeds (telemetry never blocks) ─
console.log('[K] usage endpoint fails → launch unaffected')
{
  const fix = claudeFixture()
  const s = await serve({ profile: reportNow('0.1.0') })
  s.state.usageError = 500
  const r = await runLauncher(s.port, { env: { MB_AI_CLAUDE_CONFIG: fix.cfgPath } })
  s.close()
  ok(r.status === 0, `[K] launch exits 0 despite usage HTTP 500 (got ${r.status})`)
  ok(r.args?.includes('--system-prompt'), '[K] claude still launched despite the failed report')
  rmSync(fix.dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ integration smoke: all passed' : `\n❌ integration smoke: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
