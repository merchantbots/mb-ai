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
