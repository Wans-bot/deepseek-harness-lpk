#!/usr/bin/env node
'use strict'

// LazyCat serves this DSH app on an arbitrary box sub-domain, not loopback.
// DSH's settings UI selects Host persistence with a loopback test on
// `ctx.remote.$host.isLoopback`. On a LazyCat hostname that flag is false, so
// Settings falls back to browser-memory mode and the Models page fails with
// "settings are unavailable in this browser".
//
// The selector moved and changed shape between dsh releases, so this repairs
// BOTH known forms:
//   dsh <= 0.2.1-rc.1  dsh-client-ui-settings/lib/client.js
//       const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"
//   dsh >= 0.2.1-rc.2  dsh-client-ui-settings-general/lib/client.js
//       const documentController = ctx.remote.$host.isLoopback ? new SettingsDocumentStore(...) : void 0
//
// Least-privilege repair: extend ONLY the settings persistence selector with an
// exact, HTTPS, canonical app-hostname match. We deliberately do NOT touch
// `ConnectionHandle.isLoopback` (an upstream "privileged surface" capability),
// so the open-config action and any future loopback-only features stay off.
//
// Fail-closed: a missing or malformed LAZYCAT_APP_DOMAIN, or a bundle whose
// selector shape is unknown, aborts container start instead of silently
// degrading Settings to memory mode.

const fs = require('node:fs')
const path = require('node:path')

const MARKER_PREFIX = 'dsh-lazycat-settings-v3'
const DSH_ROOT = process.env.DSH_MODULE_ROOT || '/usr/local/lib/node_modules/@deepseek-ai/dsh'
// dsh ships its UI plugins as nested deps under its own node_modules; the
// settings bundle has been renamed at least once (…-settings →
// …-settings-general), so scan the prefix instead of hard-coding one path.
const NESTED = path.join(DSH_ROOT, 'node_modules', '@deepseek-ai')
const BUNDLE_PREFIX = 'dsh-client-ui-settings'
const BUNDLE_SUFFIX = path.join('lib', 'client.js')

function parseCanonicalHostname(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === '') return null
  // The generated predicate must be an exact bare hostname literal: refuse a
  // scheme, path, query, fragment, credentials, whitespace or explicit port.
  if (/[/\\@?#\s]/.test(cleaned)) return null
  if (cleaned.includes(':')) return null
  const labels = cleaned.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  }
  return cleaned
}

const appHost = parseCanonicalHostname(process.env.LAZYCAT_APP_DOMAIN)
if (appHost === null) {
  throw new Error(
    'patch-dsh-settings: LAZYCAT_APP_DOMAIN is missing or not a bare hostname; refusing to start with Settings in memory mode',
  )
}

// The exact substring we extend, and the extension we append to it.
const NEEDLE = 'ctx.remote.$host.isLoopback'
const replacement =
  `(${NEEDLE} || (globalThis.location?.protocol === "https:" && ` +
  `globalThis.location?.hostname === ${JSON.stringify(appHost)}))`

function patchFile(target) {
  const original = fs.readFileSync(target, 'utf8')
  if (original.includes(MARKER_PREFIX)) {
    console.log(`patch-dsh-settings: already applied in ${target}`)
    return 'already'
  }

  const lines = original.split('\n')
  let index = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes(NEEDLE)) continue
    // Both known shapes; a bare loopback test elsewhere is not ours to touch.
    if (!line.includes('? "host" : "memory"') && !line.includes('new SettingsDocumentStore')) continue
    index = i
    break
  }
  if (index === -1) return 'no-selector'

  const occurrences = lines[index].split(NEEDLE).length - 1
  if (occurrences !== 1) return 'ambiguous'

  lines[index] = `${lines[index].split(NEEDLE).join(replacement)} /* ${MARKER_PREFIX}:${appHost} */`
  const patched = lines.join('\n')

  const marks = patched.split(MARKER_PREFIX).length - 1
  if (marks !== 1 || !patched.includes(`globalThis.location?.hostname === ${JSON.stringify(appHost)}`)) {
    throw new Error('patch-dsh-settings: post-write verification failed')
  }

  const temporary = `${target}.lzc-patch.tmp`
  fs.writeFileSync(temporary, patched)
  fs.renameSync(temporary, target)
  console.log(`patch-dsh-settings: bound Settings Host persistence to ${appHost} in ${target}`)
  return 'patched'
}

function discoverTargets() {
  const explicit = process.env.DSH_SETTINGS_CLIENT_FILE
  if (explicit) return [explicit]

  const seen = []
  const targets = []
  for (const root of [NESTED, DSH_ROOT]) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      seen.push(`${root}: unreadable`)
      continue
    }
    // Longest name first so `-settings-general` is tried before `-settings`.
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!entry.name.startsWith(BUNDLE_PREFIX)) continue
      const candidate = path.join(root, entry.name, BUNDLE_SUFFIX)
      if (fs.existsSync(candidate)) targets.push(candidate)
      else seen.push(`${candidate}: missing`)
    }
  }
  targets.sort((a, b) => b.length - a.length)
  return { targets, seen }
}

const { targets, seen } = discoverTargets()
if (targets.length === 0) {
  throw new Error(
    `patch-dsh-settings: no settings bundle found under ${NESTED}\n  ${seen.join('\n  ')}`,
  )
}

for (const target of targets) {
  const result = patchFile(target)
  if (result === 'patched' || result === 'already') process.exit(0)
  seen.push(`${target}: ${result}`)
}

throw new Error(
  `patch-dsh-settings: no settings persistence selector found (dsh layout changed?)\n  ${seen.join('\n  ')}`,
)
