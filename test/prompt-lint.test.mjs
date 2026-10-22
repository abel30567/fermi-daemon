import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/prompt-lint.mjs')
const SURFACE = join(ROOT, 'test/fixtures/tool-surface.json')

// CI is cleared so the script reads the vendored fixture instead of the network.
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, CI: '' } })

describe('prompt-lint', () => {
  test('passes on the real prompts against the vendored tool surface', () => {
    const r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /prompt-lint: ok/)
  })

  test('a fake tool name in a scratch drain.md fails with the name and line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-lint-'))
    try {
      const lines = readFileSync(join(ROOT, 'prompts/drain.md'), 'utf8').split('\n')
      lines.splice(4, 0, 'Then call `task_frobnicate` on it.')
      writeFileSync(join(dir, 'drain.md'), lines.join('\n'))
      const r = run('--prompts', dir, '--surface', SURFACE)
      assert.equal(r.status, 1)
      assert.match(r.stderr, /drain\.md:5: unknown tool `task_frobnicate`/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a tool renamed in the surface fails the prompt that still uses the old name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-lint-'))
    try {
      const surface = JSON.parse(readFileSync(SURFACE, 'utf8')).filter((t) => t.name !== 'task_claim')
      writeFileSync(join(dir, 'surface.json'), JSON.stringify(surface))
      const r = run('--surface', join(dir, 'surface.json'))
      assert.equal(r.status, 1)
      assert.match(r.stderr, /prompts\/drain\.md:\d+: unknown tool `task_claim`/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
