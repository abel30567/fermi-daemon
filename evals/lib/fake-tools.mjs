// The fake target's tools beyond the core drain loop, so breadth scenarios can
// exercise every tool family on fermi-mcp's surface (test/fixtures/tool-surface.json,
// vendored by scripts/prompt-lint.mjs). For a tool on that surface, in order:
//   1. the first of the scenario's `fixtures.tools` canned results that matches
//      ({ tool, match?, result, isError? }; match is a regex source tested against
//      the arguments' JSON, result a string or JSON value);
//   2. a small stateful stand-in (memory, profile, skills, schedules, secrets; secrets
//      stay out of the dump, as eval-dump.mjs has no secrets table);
//   3. mac_* go to the fake Mac bridge, like the real worker's Mac proxy;
//   4. otherwise an error naming the missing canned result.
// A tool that is not on the surface is unknown. With the real eval worker (--worker),
// the MCP proxy answers `fixtures.tools` (cannedResult) and the worker answers the rest.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SURFACE = JSON.parse(readFileSync(fileURLToPath(new URL('../../test/fixtures/tool-surface.json', import.meta.url)), 'utf8')).map((t) => t.name)

const surface = new Set(SURFACE)

// The first of `canned` ({ tool, match?, result, isError? }) that answers this call, as
// { text, isError }, or null.
export function cannedResult(canned = [], name, args) {
  const hit = canned.find((c) => c.tool === name && (!c.match || new RegExp(c.match).test(JSON.stringify(args))))
  if (!hit) return null
  return { text: typeof hit.result === 'string' ? hit.result : JSON.stringify(hit.result ?? null), isError: !!hit.isError }
}

export function extraTools({ db, canned = [], skillBodies, macCall }) {
  const stateful = {
    // secret_set / secret_resolve are the fake target's own (db.secrets).
    secret_list: () => ({ secrets: db.secrets.map(({ name }) => ({ name })) }),
    memory_write: ({ kind = 'fact', body, pinned = false }) => {
      const m = { id: db.memories.length + 1, kind, body: String(body ?? ''), pinned: !!pinned, created_at: Date.now(), decayed_at: null }
      db.memories.push(m)
      return { ok: true, id: m.id }
    },
    profile_update: (fields) => {
      Object.assign(db.profile, fields)
      return { ok: true, profile: db.profile }
    },
    skill_search: ({ query = '' }) => {
      const words = String(query).toLowerCase().split(/\W+/).filter(Boolean)
      const hit = (s) => words.some((w) => `${s.slug} ${skillBodies.get(s.slug) ?? ''}`.toLowerCase().includes(w))
      return { skills: db.skills.filter(hit).map(({ slug, name, description }) => ({ slug, name, description })) }
    },
    skill_load: ({ slug }) => {
      if (!skillBodies.has(slug)) throw new Error(`skill ${slug} not found`)
      return { slug, body: skillBodies.get(slug) }
    },
    schedule_create: (args) => {
      const s = { id: `sch-${db.schedules.length + 1}`, ...args, created_at: Date.now() }
      db.schedules.push(s)
      return { ok: true, id: s.id }
    },
    schedule_list: () => ({ schedules: db.schedules }),
    schedule_delete: ({ id }) => {
      const i = db.schedules.findIndex((s) => s.id === id)
      if (i < 0) throw new Error(`schedule ${id} not found`)
      db.schedules.splice(i, 1)
      return { ok: true, id }
    },
  }

  return {
    names: SURFACE,
    has: (name) => surface.has(name),
    async call(name, args) {
      const hit = cannedResult(canned, name, args)
      if (hit) {
        if (hit.isError) throw new Error(hit.text)
        return hit.text
      }
      if (stateful[name]) return stateful[name](args)
      if (name.startsWith('mac_')) return macCall(name, args)
      throw new Error(`fake target: no canned result for ${name} (add one to fixtures.tools)`)
    },
  }
}
