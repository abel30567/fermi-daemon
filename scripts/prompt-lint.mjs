#!/usr/bin/env node
// Checks that every Fermi tool named in prompts/*.md exists in fermi-mcp's tool surface,
// so a worker-side rename fails the gates instead of silently breaking the agent.
// Each prompt is linted as rendered with the example overlay (lib/prompt.mjs), so a
// placeholder with no key in prompts/local.example.json fails too.
//
//   node scripts/prompt-lint.mjs                    lint against test/fixtures/tool-surface.json
//                                                   (fetched from fermi-mcp master when CI is set)
//   node scripts/prompt-lint.mjs --refresh          re-vendor the fixture from fermi-mcp master
//   node scripts/prompt-lint.mjs --prompts DIR --surface FILE --overlay FILE
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { renderPrompt } from '../lib/prompt.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SURFACE_URL = 'https://raw.githubusercontent.com/abel30567/fermi-mcp/master/packages/worker/tool-surface.json'
const FIXTURE = join(ROOT, 'test/fixtures/tool-surface.json')
const EXAMPLE_OVERLAY = join(ROOT, 'prompts/local.example.json')

// A tool-name shape: a whole backticked snake_case identifier, e.g. `task_claim`.
const TOOL_SHAPE = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g

// Backticked snake_case identifiers in the prompts that are not tools (arguments, result codes).
const IGNORE = new Set([
  'budget_exceeded', 'budget_usd', 'call_id', 'chat_id', 'every_minutes', 'max_minutes',
  'notify_channel', 'notify_chat_id', 'over_budget', 'parent_task_id', 'proof_contract', 'ttl_seconds',
])

async function fetchSurface() {
  const res = await fetch(SURFACE_URL)
  if (!res.ok) throw new Error(`GET ${SURFACE_URL} -> ${res.status}`)
  return res.json()
}

const toolNames = (surface) => new Set(surface.map((t) => t.name))

export function lint(promptsDir, tools, overlay) {
  const problems = []
  for (const file of readdirSync(promptsDir).filter((f) => f.endsWith('.md')).sort()) {
    const lines = renderPrompt(readFileSync(join(promptsDir, file), 'utf8'), overlay, join(promptsDir, file)).split('\n')
    lines.forEach((text, i) => {
      for (const [, name] of text.matchAll(TOOL_SHAPE)) {
        if (!tools.has(name) && !IGNORE.has(name)) problems.push({ file: join(promptsDir, file), line: i + 1, name })
      }
    })
  }
  return problems
}

async function main() {
  const { values } = parseArgs({
    options: {
      refresh: { type: 'boolean' },
      prompts: { type: 'string', default: join(ROOT, 'prompts') },
      surface: { type: 'string' },
      overlay: { type: 'string', default: EXAMPLE_OVERLAY },
    },
  })

  if (values.refresh) {
    // Vendor only the names: the lint needs nothing else, and descriptions/schemas churn.
    const names = [...toolNames(await fetchSurface())].sort().map((name) => ({ name }))
    writeFileSync(FIXTURE, JSON.stringify(names, null, 2) + '\n')
    console.log(`prompt-lint: wrote ${names.length} tools to ${relative(ROOT, FIXTURE)}`)
    return
  }

  const surface = values.surface
    ? JSON.parse(readFileSync(values.surface, 'utf8'))
    : process.env.CI ? await fetchSurface() : JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const problems = lint(values.prompts, toolNames(surface), JSON.parse(readFileSync(values.overlay, 'utf8')))
  for (const p of problems) {
    const rel = relative(process.cwd(), p.file)
    console.error(`${rel.startsWith('..') ? p.file : rel}:${p.line}: unknown tool \`${p.name}\``)
  }
  if (problems.length) {
    console.error(`prompt-lint: ${problems.length} unknown tool name(s). Fix the prompt, or add a non-tool identifier to IGNORE in scripts/prompt-lint.mjs.`)
    process.exit(1)
  }
  console.log('prompt-lint: ok')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
