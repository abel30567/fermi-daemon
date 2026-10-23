// More core tools for the in-process fake target (fake-target.mjs): skills,
// profile docs, memory writes and schedules. The validation and the
// { ok: false, error } results are ported from fermi-mcp's worker
// (lib/profile-store.ts, lib/schedule-store.ts), so a scenario that hits
// over_budget or a bad cadence behaves the same under the fake target.
import { randomUUID } from 'node:crypto'

export const PROFILE_BUDGETS = { agent: 2200, user: 1375 }
const EVERY_MINUTES_MIN = 5
const EVERY_MINUTES_MAX = 10_080

// Same edit semantics as updateProfileDoc: add a line, replace the first matching line, remove matching lines.
function updateProfileDoc(db, { target, action, content, match }) {
  const limit = PROFILE_BUDGETS[target]
  if (!limit) return { ok: false, error: 'invalid_target' }
  const current = db.profile[target] ?? ''
  let next
  if (action === 'add') {
    const c = content?.trim()
    if (!c) return { ok: false, error: 'content_required' }
    if (current.split('\n').includes(c)) return { ok: false, error: 'duplicate_entry' }
    next = current ? `${current}\n${c}` : c
  } else if (action === 'replace' || action === 'remove') {
    if (!match) return { ok: false, error: 'match_required' }
    if (!current.includes(match)) return { ok: false, error: 'match_not_found' }
    if (action === 'replace') {
      const c = content?.trim()
      if (!c) return { ok: false, error: 'content_required' }
      let replaced = false
      next = current
        .split('\n')
        .map((line) => (!replaced && line.includes(match) ? ((replaced = true), c) : line))
        .join('\n')
    } else next = current.split('\n').filter((line) => !line.includes(match)).join('\n')
  } else return { ok: false, error: 'invalid_action' }
  next = next.trim()
  if (next.length > limit) return { ok: false, error: 'over_budget', usage: next.length, limit }
  db.profile[target] = next
  return { ok: true, usage: next.length, limit }
}

function createSchedule(db, { channel, chat_id, prompt, every_minutes, at }) {
  if (!String(prompt ?? '').trim()) return { ok: false, error: 'prompt_empty' }
  if ((every_minutes != null) === (at != null)) return { ok: false, error: 'exactly_one_of_every_or_at' }
  let runAt = null
  if (every_minutes != null) {
    if (!Number.isInteger(every_minutes) || every_minutes < EVERY_MINUTES_MIN || every_minutes > EVERY_MINUTES_MAX)
      return { ok: false, error: 'every_minutes_out_of_range' }
  } else {
    runAt = typeof at === 'number' ? at : Date.parse(at)
    if (Number.isNaN(runAt)) return { ok: false, error: 'invalid_at_timestamp' }
    if (runAt <= Date.now()) return { ok: false, error: 'run_at_in_past' }
  }
  const id = randomUUID().slice(0, 8)
  const kind = every_minutes != null ? 'every' : 'at'
  const next_run_at = kind === 'every' ? Date.now() + every_minutes * 60_000 : runAt
  db.schedules.push({ id, channel, chat_id, prompt: prompt.trim(), kind, run_at: runAt, every_minutes: every_minutes ?? null, next_run_at, enabled: 1, created_at: Date.now() })
  return { ok: true, id, kind, next_run_at }
}

// `skillBodies` maps a seeded skill's slug to its SKILL.md body (the dump keeps metadata only).
export const coreTools = (db, skillBodies) => ({
  skill_load: ({ slug }) => {
    const s = db.skills.find((x) => x.slug === slug)
    return s ? { slug, name: s.name, body: skillBodies.get(slug) ?? '', allowed_tools: s.allowed_tools } : { error: 'skill_not_found', slug }
  },
  profile_update: (args) => updateProfileDoc(db, args),
  memory_write: ({ kind, body, pinned = false }) => {
    const m = { id: db.memories.length + 1, kind, body, pinned: !!pinned, created_at: Date.now(), decayed_at: null }
    db.memories.push(m)
    return { ok: true, id: m.id }
  },
  schedule_create: (args) => createSchedule(db, args),
  schedule_list: () => ({ schedules: db.schedules.filter((s) => s.enabled) }),
})
