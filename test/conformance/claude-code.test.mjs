// The conformance suite (./suite.mjs) for the Claude Code adapter, against ./fake-claude-code.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

// DMN-41: claude exits before reading stdin, and a prompt larger than the pipe buffer makes
// the prompt write fail with EPIPE every time; it is never an uncaught exception.
test('runOnce: claude exits before reading its prompt', async () => {
  const { runOnce } = await import('../../harness/claude-code.mjs')
  const early = join(dirname(bin), 'claude-fail')
  writeFileSync(early, '#!/bin/sh\necho "claude: bad config" >&2; exit 3\n')
  chmodSync(early, 0o755)
  const r = await runOnce({ bin: early, prompt: 'x'.repeat(1 << 20) }).done
  assert.equal(r.code, 3)
  assert.equal(r.outcome, null)
  assert.match(r.stderr, /claude: bad config/)
})
