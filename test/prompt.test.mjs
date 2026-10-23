import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrompt, placeholders, renderPrompt } from '../lib/prompt.mjs'
import { ROOT, runWorker } from './run-worker.mjs'

const DRAIN = join(ROOT, 'prompts/drain.md')
const EXAMPLE = join(ROOT, 'prompts/local.example.json')
const EVAL = join(ROOT, 'evals/fixtures/prompt-overlay.json')
const json = (f) => JSON.parse(readFileSync(f, 'utf8'))
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }

// One phrase per rule that carries a placeholder or came from the live prompt.
const RULES = [
  /## Owner authority\nThe owner is sender `U0EXAMPLEOWNER` on channel `sl`/,
  /never by display name/,
  /without lectures, and ask at most one clarifying question/,
  /decline something, say so in one line and offer the closest alternative/,
  /\*\*Finance channel\*\*: a task on channel `sl` with chat_id `C0EXAMPLEFIN`.*`skill_load` the `household-finance` skill/,
  /\*\*Slack formatting\*\* \(every `sl` reply\): Slack mrkdwn only\. No Markdown pipe tables, no `#` headers and no `\*\*`/,
  /ALWAYS reply to a message addressed to the bot/,
  /never send pairing codes or acks to a group/i,
  /\*\*Call list only\.\*\* .*asks: Example Owner \+15555550100; Example Contact \+15555550101 \(each entry: a name and an E\.164 number\)\. Match the requester on `sender`/,
  /Dial only after the same requester answers yes/,
  /"redial" or "again" within 30 minutes/,
  /any tone the owner asks for and may quote the owner/,
  /they are the requester's own, and never passwords or card numbers/,
  /an assistant calling on your behalf \(it will say it's an AI if asked\)/,
  /without calling itself an AI in the introduction, answers truthfully that it is an AI assistant if the callee asks .* and never claims to be human/,
]

describe('AC1: rendering with the example overlay', () => {
  test('every placeholder in prompts/drain.md has a key in the example and the eval overlays', () => {
    const keys = placeholders(readFileSync(DRAIN, 'utf8'))
    assert.deepEqual(keys.sort(), ['CALL_LIST', 'FINANCE_CHANNEL', 'OWNER_CHANNEL', 'OWNER_SENDER'])
    assert.deepEqual(Object.keys(json(EXAMPLE)).sort(), keys)
    assert.deepEqual(Object.keys(json(EVAL)).sort(), keys)
  })

  test('each placeholder is substituted, none remains, and every rule is present', () => {
    const out = loadPrompt(DRAIN, EXAMPLE)
    assert.doesNotMatch(out, /\{\{/)
    for (const v of Object.values(json(EXAMPLE))) assert.ok(out.includes(v), v)
    for (const rule of RULES) assert.match(out, rule)
  })

  test('the eval overlay renders the scenario ids', () => {
    const out = loadPrompt(DRAIN, EVAL)
    assert.doesNotMatch(out, /\{\{/)
    assert.match(out, /chat_id `C0FINANCE`/)
    assert.match(out, /sender `U0EVALOWNER`/)
  })
})

describe('renderPrompt / loadPrompt', () => {
  test('a missing, empty or non-string key throws, naming every missing key', () => {
    const text = '{{A}} {{B}} {{C}} {{D}}'
    assert.throws(() => renderPrompt(text, { A: 'x', B: '', C: 7 }), /missing key\(s\): B, C, D$/)
  })

  test('a prompt with placeholders and no overlay file throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-'))
    try {
      writeFileSync(join(dir, 'drain.md'), '{{OWNER_SENDER}}')
      assert.throws(() => loadPrompt(join(dir, 'drain.md')), /cannot read prompt overlay .*local\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a prompt without placeholders needs no overlay (heartbeat.md)', () => {
    const f = join(ROOT, 'prompts/heartbeat.md')
    assert.equal(loadPrompt(f, '/nonexistent/local.json'), readFileSync(f, 'utf8'))
  })
})

describe('AC2: warm-worker refuses to start on a missing key', () => {
  const PROMPT = 'Owner is {{OWNER_SENDER}}.\n'

  test('missing key: exits with the key named and never spawns the harness', async () => {
    const r = await runWorker({ result: SUCCESS, pending: 0, durationMs: 1500, prompt: PROMPT, overlay: { OTHER: 'x' } })
    assert.match(r.log, /refusing to start: .*local\.json: prompt overlay is missing key\(s\): OWNER_SENDER/)
    assert.equal(r.events.filter((e) => e.kind === 'spawn').length, 0)
  })

  test('missing prompts/local.json: exits and never spawns the harness', async () => {
    const r = await runWorker({ result: SUCCESS, pending: 0, durationMs: 1500, prompt: PROMPT })
    assert.match(r.log, /refusing to start: .*cannot read prompt overlay/)
    assert.equal(r.events.filter((e) => e.kind === 'spawn').length, 0)
  })

  test('complete overlay: the harness gets the rendered system prompt', async () => {
    const r = await runWorker({ result: SUCCESS, pending: 0, durationMs: 1500, prompt: PROMPT, overlay: { OWNER_SENDER: 'U0OWNER' } })
    const argv = r.events.find((e) => e.kind === 'spawn').argv
    assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], 'Owner is U0OWNER.\n')
  })
})

describe('AC3: no private values committed', () => {
  test('prompts/local.json is gitignored and prompts/ holds none of the private prefixes', () => {
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'prompts/local.json'], { cwd: ROOT }).status, 0)
    const r = spawnSync('git', ['grep', '-nE', '1786|1407|C0C1', '--', 'prompts/', 'evals/fixtures/'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.stdout, '')
  })
})
