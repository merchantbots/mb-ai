import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { skillsDir } from './config'
import { parseError, MbError } from './errors'
import { info, warn, debug } from './log'
import type { Profile } from './profile'

// The backend ships MB's skills as a Claude Code *plugin* (e.g. "mb-skills"). The profile carries
// a content id (`commit`) and a `downloadUrl` for an archive of that plugin. We cache the unpacked
// bundle under ~/.mb-ai/backends/<host>/skills/, keyed by commit, and pass its path to
// `claude --plugin-dir`. On each run we compare the profile's commit to what's on disk: same →
// reuse silently; different (or nothing cached) → download the new one, telling the user first.

export interface ResolvedSkills {
  plugin: string
  commit: string
  downloadUrl: string
}

/** The skills bundle to sync, or null when the profile carries none to act on. */
export function resolveSkills(profile: Profile): ResolvedSkills | null {
  const s = profile.skills
  if (!s) return null
  // Older/placeholder profiles omit commit+downloadUrl → nothing to sync.
  if (!s.commit || !s.downloadUrl) return null
  return { plugin: s.plugin || 'skills', commit: s.commit, downloadUrl: s.downloadUrl }
}

interface State {
  commit: string
  /** Basename under skillsDir of what's on disk: a `<commit>/` folder or a `<commit>.zip`. */
  artifact: string
}

function readState(path: string): State | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    if (j && typeof j.commit === 'string' && typeof j.artifact === 'string') return j as State
  } catch {
    // missing or corrupt → treat as no cache
  }
  return null
}

function short(commit: string): string {
  return commit.length > 8 ? commit.slice(0, 8) : commit
}

/**
 * Resolve the artifact basename to the path we hand `--plugin-dir`. A `.zip` is passed as-is
 * (claude loads a plugin `.zip` directly); a folder is resolved to the plugin root inside it —
 * the dir holding `.claude-plugin/plugin.json`, which may be the folder itself or a single
 * wrapper dir (git-archive tarballs nest everything under `<name>/`).
 */
function pluginDirPath(dir: string, artifact: string): string {
  const path = join(dir, artifact)
  if (artifact.endsWith('.zip')) return path
  if (existsSync(join(path, '.claude-plugin', 'plugin.json'))) return path
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(path, entry.name, '.claude-plugin', 'plugin.json')))
      return join(path, entry.name)
  }
  return path // no manifest found → let claude treat it as a folder of plugins
}

/**
 * Ensure the profile's skills bundle is on disk and return the `--plugin-dir` path(s) for it
 * (0 or 1). Never throws: a fetch/unpack failure degrades to a cached copy if we have one, or to
 * launching without skills — skills are additive, and blocking the whole session over them is worse.
 */
export async function ensureSkills(host: string, profile: Profile, token: string): Promise<string[]> {
  const skills = resolveSkills(profile)
  if (!skills) return []

  const dir = skillsDir(host)
  mkdirSync(dir, { recursive: true })
  const statePath = join(dir, 'state.json')
  const state = readState(statePath)

  // Cache hit: same commit and the bundle is still on disk → reuse, no download, no chatter.
  if (state && state.commit === skills.commit && existsSync(join(dir, state.artifact))) {
    debug(`skills: ${skills.plugin} up to date (${short(skills.commit)})`)
    return [pluginDirPath(dir, state.artifact)]
  }

  info(
    state
      ? `Skills changed — re-downloading, hang tight for a bit…`
      : `Fetching skills — hang tight for a bit…`,
  )
  try {
    const artifact = await download(dir, skills, token)
    writeFileSync(statePath, JSON.stringify({ commit: skills.commit, artifact }))
    prune(dir, artifact)
    debug(`skills: ${skills.plugin} ready (${short(skills.commit)})`)
    return [pluginDirPath(dir, artifact)]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Fall back to a previously cached bundle if there is one, else launch without skills.
    if (state && existsSync(join(dir, state.artifact))) {
      warn(`Couldn't fetch the latest skills (${msg}); using the cached copy.`)
      return [pluginDirPath(dir, state.artifact)]
    }
    warn(`Couldn't fetch skills (${msg}); continuing without them.`)
    return []
  }
}

/** Download the archive and land it under `dir`; return the stored artifact basename. */
async function download(dir: string, skills: ResolvedSkills, token: string): Promise<string> {
  const res = await fetch(skills.downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw await parseError(res)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new MbError('empty archive', 'SKILLS_EMPTY')

  const tmpArchive = join(dir, `.dl-${process.pid}`)
  const tmpDir = join(dir, `.x-${process.pid}`)
  try {
    writeFileSync(tmpArchive, buf)
    // `tar -xf` auto-detects gzip; bsdtar (macOS) also reads zip. Extraction gives us a real
    // plugin folder, which is the format claude loads most predictably.
    mkdirSync(tmpDir, { recursive: true })
    try {
      await execa('tar', ['-xf', tmpArchive, '-C', tmpDir])
    } catch (e: any) {
      if (e?.code === 'ENOENT')
        throw new MbError('`tar` is required to unpack skills but was not found on PATH', 'TAR_NOT_FOUND')
      // Couldn't untar. If it's a zip, claude accepts a plugin `.zip` via --plugin-dir directly.
      if (buf[0] === 0x50 && buf[1] === 0x4b) {
        rmSync(tmpDir, { recursive: true, force: true })
        const zip = `${skills.commit}.zip`
        renameSync(tmpArchive, join(dir, zip))
        return zip
      }
      throw new MbError('unrecognized skills archive (not a tarball or zip)', 'SKILLS_FORMAT')
    }
    if (readdirSync(tmpDir).length === 0) throw new MbError('archive was empty after unpacking', 'SKILLS_EMPTY')

    const out = skills.commit
    const outPath = join(dir, out)
    // Atomic-ish publish: swap the freshly extracted dir into place (unless a peer beat us to it).
    if (existsSync(outPath)) {
      rmSync(tmpDir, { recursive: true, force: true })
    } else {
      renameSync(tmpDir, outPath)
    }
    return out
  } finally {
    rmSync(tmpArchive, { force: true })
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Drop every sibling except the artifact we just published and our own state file. */
function prune(dir: string, keep: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === keep || entry === 'state.json') continue
    try {
      rmSync(join(dir, entry), { recursive: true, force: true })
    } catch {
      // best effort — a locked/leftover entry shouldn't fail the launch
    }
  }
}
