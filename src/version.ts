// Injected from package.json at build time (see tsup.config.ts) — one place to bump.
// Bump package.json when raising the backend's minLauncherVersion floor, so the version
// gate can tell an outdated install from a current one.
declare const __MB_AI_VERSION__: string
export const VERSION = __MB_AI_VERSION__
// How users install/update the launcher: GitHub default branch — no npm registry, no tags.
export const INSTALL_COMMAND = 'npm i -g github:merchantbots/mb-ai'
