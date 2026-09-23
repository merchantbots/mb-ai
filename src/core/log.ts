// All launcher chatter goes to stderr so stdout stays clean for the `claude` child.
let verbose = false

export function setVerbose(v: boolean) {
  verbose = v
}

export function info(msg: string) {
  console.error(msg)
}

export function warn(msg: string) {
  console.error(`! ${msg}`)
}

export function debug(msg: string) {
  if (verbose) console.error(`· ${msg}`)
}
