import pc from 'picocolors'

// One shared theme so every command formats and colors the same way. picocolors auto-detects
// support and honors NO_COLOR / FORCE_COLOR / non-TTY, so piped, redirected, and CI output degrade
// to plain text on their own — nothing here has to special-case that.
export const c = pc

// Status glyphs — use these instead of bare ✓/⚠/✗ so their colors stay consistent everywhere.
export const sym = {
  ok: pc.green('✓'),
  warn: pc.yellow('⚠'),
  err: pc.red('✗'),
  bullet: pc.dim('·'),
}

// Fixed-width, dimmed label column shared by `doctor` and the diagnostics. Pad the visible text
// first, then color it — ANSI codes have zero display width, so alignment is preserved.
export const LABEL_W = 12
export const label = (s: string) => pc.dim(s.padEnd(LABEL_W))
export const indent = ' '.repeat(LABEL_W)

/** A dimmed horizontal rule, optionally captioned: "── caption ─────────". */
export function rule(caption?: string, width = 62): string {
  if (!caption) return pc.dim('─'.repeat(width))
  const dashes = Math.max(4, width - caption.length - 3)
  return pc.dim(`── ${caption} ` + '─'.repeat(dashes))
}

// Matches one JSON token in `JSON.stringify` output: a string (optionally a key, if a `:` follows),
// a keyword, or a number. Strings are matched whole (escapes included) and come first, so keywords
// or digits *inside* a string are never recolored.
const JSON_TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

/**
 * Pretty-print a value as JSON and syntax-highlight it (keys, strings, numbers, booleans, null).
 * When color is off (piped / NO_COLOR / non-TTY) it returns the plain, still-valid JSON untouched,
 * so `mb-ai profile | jq` keeps working. Pass a string to highlight already-serialized JSON.
 */
export function highlightJson(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!pc.isColorSupported) return json
  return json.replace(JSON_TOKEN, (m, str, colon, keyword, num) => {
    if (str !== undefined) return colon ? pc.cyan(str) + pc.dim(colon) : pc.green(str)
    if (keyword !== undefined) return keyword === 'null' ? pc.dim(keyword) : pc.yellow(keyword)
    if (num !== undefined) return pc.yellow(num)
    return m
  })
}
