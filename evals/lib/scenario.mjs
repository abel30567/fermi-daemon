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
  if (inb?.via != null && !['webhook', 'task'].includes(inb.via)) errs.push('inbound.via must be "webhook" or "task"')
  if (s.variants != null) {
    const names = (Array.isArray(s.variants) ? s.variants : []).map((v) => v?.name)
    if (!names.length || names.some((n) => typeof n !== 'string' || !n) || new Set(names).size !== names.length)
      errs.push('variants must be a non-empty list of objects with unique string names')
  }
  if (errs.length) throw new Error(`${file}: ${errs.join('; ')}`)
  return s
}

// A scenario with `variants` (paraphrased or adversarial inbounds) becomes the
// base scenario plus one scenario per variant, named `<name>~<variant>`. A
// variant's `inbound` and `fixtures` are merged key by key over the base's;
// `expect` and `fake` are always the base's, so every variant is graded the same.
export function expandVariants(s) {
  const { variants, ...base } = s
  return [
    base,
    ...(variants ?? []).map((v) => ({
      ...base,
      name: `${base.name}~${v.name}`,
      ...(v.description && { description: v.description }),
      inbound: { ...base.inbound, ...v.inbound },
      fixtures: { ...base.fixtures, ...v.fixtures },
    })),
  ]
}

// The MCP-11 eval-seed fixture for a scenario. `bindings` are channel allowlist
// entries ({ channel, sender_id, note? }), seeded into the worker's allowlist.
// An inbound with `via: "task"` (a phone call result, a cloud handoff: nothing a
// bridge webhook delivers) is seeded as the newest pending task instead.
// `history` ({ role, text, minutes_ago? }) is the inbound chat's prior transcript.
export function seedFixture(fixtures = {}, inbound = null) {
  const { profile, memories, skills } = fixtures
  const allowlist = [...(fixtures.allowlist ?? []), ...(fixtures.bindings ?? [])]
  const tasks = [...(fixtures.tasks ?? [])]
  if (inbound?.via === 'task') tasks.push({ id: 'eval-inbound', channel: inbound.channel, sender: inbound.sender, chat_id: inbound.chat, payload: inbound.text })
  const now = Date.now()
  const history = (fixtures.history ?? []).map((m) => ({
    channel: inbound?.channel,
    chat_id: inbound?.chat,
    role: m.role,
    text: m.text,
    created_at: now - (m.minutes_ago ?? 0) * 60_000,
  }))
  return {
    ...(profile && { profile }),
    ...(memories && { memories }),
    ...(skills && { skills }),
    ...((fixtures.tasks || tasks.length) && { tasks }),
    ...(allowlist.length && { allowlist }),
    ...(history.length && { history }),
  }
}

// The channel webhook request that enqueues the inbound message, as a bridge sends it.
// null for an inbound seeded as a task, and for Teams: the warm worker takes it
// as a session turn, not a queue task.
export function webhookRequest(inbound, secrets) {
  if (inbound.via === 'task' || inbound.channel === 'teams') return null
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
  // wa-bridge's inbound.ts: the sender is the phone number (digits), a DM's chat_id
  // is the same number and a group's ends in @g.us. No display name is sent.
  if (inbound.channel === 'wa') {
    return {
      path: '/wa/webhook',
      headers: { 'content-type': 'application/json', 'x-wa-bridge-secret': secrets.WA_WEBHOOK_SECRET },
      body: { sender: inbound.sender, chat_id: inbound.chat, text },
    }
  }
  throw new Error(`inbound channel "${inbound.channel}" is not supported by the runner yet (supported: sl, wa; any channel with via: "task")`)
}
