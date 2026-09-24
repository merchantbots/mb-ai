import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// Single source of truth for the launcher version: package.json. Injected at build time
// (consumed by src/version.ts) so VERSION is never hand-synced — a drifted VERSION would
// make the backend version gate misfire.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  // shebang so the built file is directly executable as the `mb-ai` bin
  banner: { js: '#!/usr/bin/env node' },
  // runtime deps are resolved from node_modules (native addon must not be bundled)
  external: ['@napi-rs/keyring', 'execa', 'commander', 'zod', '@inquirer/prompts'],
  // bake the package.json version into the bundle (see src/version.ts)
  define: { __MB_AI_VERSION__: JSON.stringify(version) },
})
