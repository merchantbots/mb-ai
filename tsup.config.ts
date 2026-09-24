import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  // shebang so the built file is directly executable as the `mb-ai` bin
  banner: { js: '#!/usr/bin/env node' },
  // runtime deps are resolved from node_modules (native addon must not be bundled)
  external: ['@napi-rs/keyring', 'execa', 'commander', 'zod', '@inquirer/prompts'],
})
