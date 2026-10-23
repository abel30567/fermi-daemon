#!/usr/bin/env node
// scan-secrets.mjs [--token-fd <n>] <file|dir>... — fails (exit 1) when a file holds the
// token read from fd <n> (the CI OAuth token, never an env var or argument) or any
// secret-shaped string. Directories are scanned recursively. Findings name the file, line
// and kind, never the value. Exit 0 clean, 1 on a finding, 2 on a usage error.
// The evals workflow (.github/workflows/evals.yml) runs it over the run log and every
// artifact before anything is uploaded or posted.
import { closeSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PATTERNS = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['openai-style key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
]

// → [{ line, kind }] for one text; `token` (if any) is matched literally.
export function scanText(text, token) {
  const hits = []
  text.split('\n').forEach((l, i) => {
    if (token && l.includes(token)) hits.push({ line: i + 1, kind: 'the OAuth token' })
    for (const [kind, re] of PATTERNS) if (re.test(l)) hits.push({ line: i + 1, kind })
  })
  return hits
}

const files = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(join(p, f))) : [p])

// → [{ file, line, kind }] over every file under `paths`.
export function scanPaths(paths, token) {
  return paths.flatMap(files).flatMap((file) => scanText(readFileSync(file, 'utf8'), token).map((h) => ({ file, ...h })))
}

function main(argv) {
  const paths = []
  let fd
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token-fd' && i + 1 < argv.length) fd = Number(argv[++i])
    else if (argv[i].startsWith('-')) return usage(`unknown argument ${argv[i]}`)
    else paths.push(argv[i])
  }
  if (!paths.length) return usage('needs at least one file or directory')
  let token
  if (fd !== undefined) {
    if (!Number.isInteger(fd) || fd < 0) return usage('--token-fd needs an fd number')
    try {
      token = readFileSync(fd, 'utf8').trim()
      closeSync(fd)
    } catch {
      return usage(`cannot read --token-fd ${fd}`)
    }
    if (!token) return usage(`--token-fd ${fd} holds no token`)
  }
  let hits
  try {
    hits = scanPaths(paths, token)
  } catch (err) {
    return usage(err.message)
  }
  for (const h of hits) console.error(`scan-secrets: ${h.file}:${h.line}: ${h.kind}`)
  console.log(`scan-secrets: ${hits.length} finding(s) in ${paths.join(' ')}${token ? ' (with the token)' : ''}`)
  return hits.length ? 1 : 0
}

function usage(msg) {
  console.error(`scan-secrets: ${msg}\nusage: node scripts/scan-secrets.mjs [--token-fd <n>] <file|dir>...`)
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2))
