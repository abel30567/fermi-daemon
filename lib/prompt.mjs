// Renders a prompt's {{NAME}} placeholders from a JSON overlay of private values
// (prompts/local.json, gitignored; prompts/local.example.json lists every key).
// A required placeholder with no non-empty string value throws: a prompt never ships
// with a silently empty owner, call list or channel id. Only the keys in OPTIONAL_KEYS
// may be left out; they render their default.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

// Optional keys and their defaults. A `bullets` key renders each non-empty line of its
// value as a "- " bullet; on a line of its own, its placeholder line is dropped when empty.
export const OPTIONAL_KEYS = {
  OWNER_NAME: { fallback: 'the owner' },
  OWNER_EXTRA_RULES: { fallback: '', bullets: true },
}

const asBullets = (v) => v.split('\n').map((l) => l.trim().replace(/^[-*]\s+/, '')).filter(Boolean).map((l) => `- ${l}`).join('\n')

export const placeholders = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]

export function renderPrompt(text, overlay, source = 'prompt') {
  const has = (k) => Object.hasOwn(overlay, k) && typeof overlay[k] === 'string' && overlay[k] !== ''
  const missing = placeholders(text).filter((k) => !has(k) && !Object.hasOwn(OPTIONAL_KEYS, k))
  if (missing.length) throw new Error(`${source}: prompt overlay is missing key(s): ${missing.join(', ')}`)
  const value = (k) => {
    const opt = Object.hasOwn(OPTIONAL_KEYS, k) && OPTIONAL_KEYS[k]
    if (!opt) return overlay[k]
    const v = has(k) ? overlay[k] : opt.fallback
    return opt.bullets ? asBullets(v) : v
  }
  // One pass, so a value is never itself re-rendered.
  return text.replace(/^\{\{([A-Z][A-Z0-9_]*)\}\}\n|\{\{([A-Z][A-Z0-9_]*)\}\}/gm, (_, line, k) =>
    line ? (value(line) ? `${value(line)}\n` : '') : value(k))
}

// The Teams turn's owner note, " (sender S on channel C is the same person: NAME)", from the
// overlay at `overlayPath`. '' when the overlay, OWNER_CHANNEL or OWNER_SENDER is missing, so
// the turn omits the note instead of failing.
export function ownerNote(overlayPath) {
  let overlay
  try {
    overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  } catch {
    return ''
  }
  const value = (k) => (typeof overlay?.[k] === 'string' ? overlay[k] : '')
  if (!value('OWNER_CHANNEL') || !value('OWNER_SENDER')) return ''
  const name = value('OWNER_NAME') || OPTIONAL_KEYS.OWNER_NAME.fallback
  return ` (sender ${value('OWNER_SENDER')} on channel ${value('OWNER_CHANNEL')} is the same person: ${name})`
}

// Reads `promptPath` and renders it with `overlayPath` (default: local.json next to
// the prompt). A prompt without placeholders needs no overlay.
export function loadPrompt(promptPath, overlayPath = join(dirname(promptPath), 'local.json')) {
  const text = readFileSync(promptPath, 'utf8')
  if (!placeholders(text).length) return text
  let overlay
  try {
    overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  } catch (e) {
    throw new Error(`${promptPath}: cannot read prompt overlay ${overlayPath} (${e.message}); copy prompts/local.example.json and fill in the real values`)
  }
  return renderPrompt(text, overlay, overlayPath)
}
