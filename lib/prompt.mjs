// Renders a prompt's {{NAME}} placeholders from a JSON overlay of private values
// (prompts/local.json, gitignored; prompts/local.example.json lists every key).
// A placeholder with no non-empty string value throws: a prompt never ships with
// a silently empty owner, call list or channel id.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

export const placeholders = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]

export function renderPrompt(text, overlay, source = 'prompt') {
  const has = (k) => Object.hasOwn(overlay, k) && typeof overlay[k] === 'string' && overlay[k] !== ''
  const missing = placeholders(text).filter((k) => !has(k))
  if (missing.length) throw new Error(`${source}: prompt overlay is missing key(s): ${missing.join(', ')}`)
  return text.replace(PLACEHOLDER, (_, k) => overlay[k])
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
