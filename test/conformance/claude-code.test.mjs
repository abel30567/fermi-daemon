// The conformance suite (./suite.mjs) for the Claude Code adapter, against ./fake-claude-code.mjs.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from './suite.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'dmn4-bin-')), 'claude')
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude-code.mjs')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)

runConformance(() => import('../../harness/claude-code.mjs'), { name: 'claude-code', options: { bin } })
