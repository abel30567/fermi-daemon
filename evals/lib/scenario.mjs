// Scenario files (JSON). See evals/README.md for the format.
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ASSERTIONS } from './assertions.mjs'
import { TURNS } from './session.mjs'

const WILD = /[*?[{]/

// `dir/*.json`-style globs without the (experimental) fs.globSync; anything with
// wildcards above the last segment falls back to it.
function glob(p) {
  const dir = dirname(p)
  if (WILD.test(dir)) return globSync(p)
  const re = new RegExp(`^${basename(p).replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`)
  return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)) : []
}

// --scenarios takes globs or paths (a shell may have expanded the glob already).
export function expandScenarios(patterns) {
  const files = new Set()
  for (const p of patterns) {
    const hits = WILD.test(p) ? glob(p) : [p]
    for (const f of hits.sort()) if (f.endsWith('.json') && statSync(f).isFile()) files.add(f)
  }
  return [...files]
}

export function loadScenario(file) {
  let s
  try {
    s = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file}: ${err.message}`)
  }
  s.name ??= basename(file, '.json')
  // The report's category: an explicit `category`, else `severity` (critical packs), else the pack dir.
  s.category ??= s.severity ?? basename(dirname(file))
  const errs = []
  const inb = s.inbound
  if (!inb || ['channel', 'sender', 'chat', 'text'].some((k) => typeof inb[k] !== 'string')) errs.push('inbound needs string channel, sender, chat, text')
  if (!Array.isArray(s.expect) || !s.expect.length) errs.push('expect must be a non-empty list')
  for (const a of s.expect ?? []) {
    const keys = Object.keys(a ?? {})
    if (keys.length !== 1 || !ASSERTIONS.includes(keys[0])) errs.push(`bad assertion ${JSON.stringify(a)} (one of: ${ASSERTIONS.join(', ')})`)
  }
  if (s.session != null && (!Array.isArray(s.session) || !s.session.length || s.session.some((t) => !TURNS[t?.turn])))
    errs.push(`session must be a non-empty list of { turn: ${Object.keys(TURNS).join(' | ')}, interruptAfter? }`)
  if (inb?.channel === 'teams' && !s.session?.some((t) => t?.turn === 'teams')) errs.push('a teams inbound needs a session with a teams turn')
  if (s.harnesses != null && (!Array.isArray(s.harnesses) || !s.harnesses.length || s.harnesses.some((h) => typeof h !== 'string' || !h)))
    errs.push('harnesses must be a non-empty list of harness names')
  if (s.expectOutcome != null && !['pass', 'fail'].includes(s.expectOutcome)) errs.push('expectOutcome must be "pass" or "fail"')
  if (errs.length) throw new Error(`${file}: ${errs.join('; ')}`)
  return s
}

// The MCP-11 eval-seed fixture for a scenario. `bindings` are channel allowlist
// entries ({ channel, sender_id, note? }), seeded into the worker's allowlist.
export function seedFixture(fixtures = {}) {
  const { profile, memories, skills, tasks } = fixtures
  const allowlist = [...(fixtures.allowlist ?? []), ...(fixtures.bindings ?? [])]
  return {
    ...(profile && { profile }),
    ...(memories && { memories }),
    ...(skills && { skills }),
    ...(tasks && { tasks }),
    ...(allowlist.length && { allowlist }),
  }
}

// The channel webhook request that enqueues the inbound message, as a bridge sends it.
// null for Teams: the warm worker takes it as a session turn, not a queue task.
export function webhookRequest(inbound, secrets) {
  if (inbound.channel === 'teams') return null
  const text = inbound.attachment
    ? `${inbound.text}\n[${inbound.attachment.kind} attachment saved to ~/fermi-daemon/media/${inbound.attachment.file}]`
    : inbound.text
  if (inbound.channel === 'sl') {
    const isIm = inbound.chat.startsWith('D')
    return {
      path: '/sl/webhook',
      headers: { 'content-type': 'application/json', 'x-sl-bridge-secret': secrets.SLACK_BRIDGE_SECRET },
      body: {
        author_id: inbound.sender,
        display_name: inbound.display_name ?? inbound.sender,
        channel_id: inbound.chat,
        team_id: inbound.team ?? null,
        is_im: isIm,
        text,
        message_id: inbound.message_id ?? `eval-${Date.now()}`,
      },
    }
  }
  throw new Error(`inbound channel "${inbound.channel}" is not supported by the runner yet (supported: sl)`)
}
