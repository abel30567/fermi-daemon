// The conformance suite (./suite.mjs) for the pi adapter, against ./fake-pi.mjs.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from './suite.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'dmn5-bin-')), 'pi')
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-pi.mjs')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)

runConformance(() => import('../../harness/pi.mjs'), { name: 'pi', options: { bin } }, {
  expectedFail: {
    tool_names:
      "pi's built-in shell tool is `bash`, not `Bash`; the contract keeps name = bareToolName(rawName), so it stays `bash` (MCP prefixes are stripped)",
    credential_isolation:
      'SWAP-GATE BLOCKER: pi takes its credential only from argv, env (inherited by its bash tool) or auth.json (readable by its tools); no fd handoff, so the adapter refuses tokenFd (see harness/pi.mjs)',
  },
})
