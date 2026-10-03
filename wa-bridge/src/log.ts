// launchd captures stdout to the log file; keep everything on one line each.
export function log(msg: string): void {
	console.log(`${new Date().toISOString()} ${msg}`)
}

// Debug lines only when WA_BRIDGE_DEBUG=1 (see config.ts).
let debug = false
export function setDebug(on: boolean): void {
	debug = on
}
export function logDebug(msg: string): void {
	if (debug) log(`debug: ${msg}`)
}
