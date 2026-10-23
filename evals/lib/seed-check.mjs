// After seeding, read every fixture section the runner sent back through the eval
// target, so a worker that silently ignores one (a stale fermi-mcp checkout whose
// eval-seed.mjs predates a section, such as MCP-24's `conversation`) fails the
// attempt as a setup error instead of grading the model against missing state.
// `conversation` is read through MCP `conversation_history` (what the agent sees);
// profile, memories, skills, allowlist and tasks through the target's dump (eval-dump.mjs).
import { mcpConnect, resultText } from './mcp-client.mjs'

// The attempt never reached the harness: errorKind `setup_error`, never graded.
export class SetupError extends Error {}

const has = (rows, pred) => (rows ?? []).some(pred)

// → one line per fixture section that did not land; [] when everything did.
// `state`: the target's dump; `history`: conversation_history's messages for the seeded chat.
export function missingSections(fixture, state, history = []) {
  const out = []
  const miss = (section, lost, total) => lost && out.push(`${section}: ${lost}/${total} missing`)
  if (fixture.profile) {
    const keys = Object.keys(fixture.profile)
    miss('profile', keys.filter((k) => !(k in (state.profile ?? {}))).length, keys.length)
  }
  if (fixture.memories) miss('memories', fixture.memories.filter((m) => !has(state.memories, (x) => x.body === m.body)).length, fixture.memories.length)
  if (fixture.skills) miss('skills', fixture.skills.filter((s) => !has(state.skills, (x) => x.slug === s.slug)).length, fixture.skills.length)
  if (fixture.allowlist)
    miss('allowlist', fixture.allowlist.filter((a) => !has(state.allowlist, (x) => x.channel === a.channel && x.sender_id === a.sender_id)).length, fixture.allowlist.length)
  if (fixture.tasks) {
    const lost = fixture.tasks.filter((t) => t.id != null && !has(state.tasks, (x) => x.id === t.id)).length
    miss('tasks', Math.max(lost, fixture.tasks.length - (state.tasks?.length ?? 0)), fixture.tasks.length)
  }
  if (fixture.conversation) {
    const { channel, chat_id, history: turns } = fixture.conversation
    // The real worker returns `body`, the fake target `text`; a group's user turns carry a `[sender] ` prefix.
    const lost = turns.filter((t) => !has(history, (m) => m.role === t.role && String(m.body ?? m.text ?? '').endsWith(t.text))).length
    miss(`conversation (conversation_history ${channel}/${chat_id})`, lost, turns.length)
  }
  return out
}

// Throws a SetupError naming every section of `fixture` the target does not hold.
export async function verifySeed(target, fixture) {
  let history = []
  if (fixture.conversation) {
    const { channel, chat_id } = fixture.conversation
    const mcp = await mcpConnect(`${target.url}/mcp`, { clientName: 'fermi-eval-seed' })
    const r = await mcp.callTool('conversation_history', { channel, chat_id, limit: 50 })
    if (!r?.isError) history = JSON.parse(resultText(r)).messages ?? []
  }
  const missing = missingSections(fixture, await target.dump(), history)
  if (missing.length) throw new SetupError(`seed did not land on the eval target (stale worker checkout?): ${missing.join('; ')}`)
}
