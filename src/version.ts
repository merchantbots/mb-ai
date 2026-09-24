// Keep in sync with package.json. Bump when raising the backend's minLauncherVersion floor,
// so the version gate can tell an outdated install from a current one.
export const VERSION = '0.1.0'
// How users install/update the launcher: GitHub default branch — no npm registry, no tags.
export const INSTALL_COMMAND = 'npm i -g github:merchantbots/mb-ai'
