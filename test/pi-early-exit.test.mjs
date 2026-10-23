// DMN-32: a pi that exits early (before or after reading its first prompt) used to crash the
// runner with an unhandled `write EPIPE` on its stdin. It is now a failed attempt:
// turn_end { ok: false, kind: 'crash' } with pi's stderr in the attempt's stderr.log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as pi from '../harness/pi.mjs'
import { createSandbox, sandboxBackend } from '../harness/sandbox.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn32-'))
const script = (body) => {
  const bin = join(tmp(), 'pi')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
// Exits without reading stdin; a prompt larger than the pipe buffer then fails with EPIPE.
const BEFORE = script('echo "pi: cannot load models.json (before)" >&2; exit 3')
// Reads the first prompt, then exits.
const AFTER = script('read line; echo "pi: died after the prompt" >&2; exit 4')
const BIG = 'x'.repeat(1 << 20)

describe('AC1: pi exiting early is a crash turn, never an uncaught exception', () => {
  for (const [when, bin, code, msg] of [
    ['before the first prompt', BEFORE, 3, /cannot load models\.json/],
    ['after the first prompt', AFTER, 4, /died after the prompt/],
  ]) {
    test(`runOnce: ${when}`, async () => {
      const res = await pi.runOnce({ bin, prompt: BIG }).done
      assert.equal(res.code, code)
      assert.equal(res.outcome?.type, 'turn_end')
      assert.equal(res.outcome.ok, false)
      assert.equal(res.outcome.kind, 'crash')
      assert.match(res.outcome.detail, new RegExp(`exited \\(${code}\\)`))
      assert.match(res.stderr, msg)
    })

    test(`startSession: ${when}`, async () => {
      const s = pi.startSession({ bin })
      const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
      const exited = once(s.events, 'exit')
      assert.equal(s.send(BIG), true)
      const end = await ended
      assert.equal(end.ok, false)
      assert.equal(end.kind, 'crash')
      await exited
      assert.equal(s.alive, false)
      assert.equal(s.send('again'), false, 'a dead session takes no turn')
    })

    test(`through the eval runner: ${when}`, async () => {
      const outDir = tmp()
      const harness = { name: pi.name, runOnce: (o) => pi.runOnce({ ...o, bin }) }
      const scenario = { name: `pi-early-exit-${code}`, inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }, expect: [] }
      const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
      assert.equal(r.pass, false)
      assert.ok(r.errorKinds.includes('crash'), JSON.stringify(r))
      assert.ok(!r.errorKinds.includes('timeout'), JSON.stringify(r))
      assert.ok(r.failed.some((f) => /harness turn ended with crash/.test(f.message)), JSON.stringify(r.failed))
      assert.match(readFileSync(join(outDir, scenario.name, '1', 'stderr.log'), 'utf8'), msg)
    })
  }

  test('a missing binary is a crash turn too', async () => {
    const res = await pi.runOnce({ bin: join(tmp(), 'no-such-pi'), prompt: 'x' }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /pi adapter: .*ENOENT/)
  })

  test('a pi the caller kills did not crash', async () => {
    const run = pi.runOnce({ bin: script('read line; sleep 30'), prompt: 'x' })
    setTimeout(() => run.close('SIGTERM'), 100)
    const res = await run.done
    assert.equal(res.outcome, null)
  })
})

describe('the OS sandbox lets a node-package harness read its own package', () => {
  test('…/node_modules is readable, the rest of HOME is not', { skip: sandboxBackend() !== 'sandbox-exec' && 'needs sandbox-exec (macOS)' }, async (t) => {
    // pi's bin is …/node_modules/@earendil-works/pi-coding-agent/dist/cli.js; it reads its
    // package.json and dependencies (hoisted, or nested in a global install) at startup.
    const home = tmp()
    const pkg = join(home, 'lib/node_modules/@scope/agent')
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    mkdirSync(join(home, 'lib/node_modules/dep'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"@scope/agent"}\n')
    writeFileSync(join(home, 'lib/node_modules/dep/index.js'), 'dep\n')
    writeFileSync(join(home, 'secret'), 'secret\n')
    const bin = join(pkg, 'dist/cli')
    writeFileSync(bin, `#!/bin/sh\ncat "${join(pkg, 'package.json')}" "${join(home, 'lib/node_modules/dep/index.js')}" && ! cat "${join(home, 'secret')}" 2>/dev/null\n`)
    chmodSync(bin, 0o755)
    const saved = process.env.HOME
    process.env.HOME = home
    t.after(() => (process.env.HOME = saved))
    const res = await pi.runOnce({ bin, prompt: 'x', sandbox: createSandbox({ root: tmp() }) }).done
    assert.equal(res.code, 0, res.stderr)
  })
})
