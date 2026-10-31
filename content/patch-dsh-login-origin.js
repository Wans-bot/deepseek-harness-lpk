#!/usr/bin/env node
'use strict'

// LazyCat serves this DSH app on a box sub-domain, so the browser origin is
// https://<app>.<box domain>, never loopback.
//
// DSH's web sign-in passes `window.location.origin` as the OAuth callback
// origin. Both ends then insist on a loopback callback:
//   - Host:   loginOrigin(callbackOrigin) accepts ONLY
//             http://{127.0.0.1|localhost|[::1]}:<non-zero port>
//   - Platform: auth_init rejects anything else with 50005
//               PAYLOAD_SCHEMA_MISMATCH (verified by direct probe)
// On a LazyCat hostname the first check throws PlatformAuthError("protocol")
// inside the click handler, so the popup closes and the flow never reaches the
// platform. Relaxing the client alone is useless: the platform repeats the same
// rule and rejects the request one hop later.
//
// The callback is NOT a separate listener. DSH registers it on its own HTTP
// server (`{ kind: "exact", path: "/oauth/callback" }`, container port 3081), so
// a callback arriving through the LazyCat reverse proxy is served normally and
// `state` is verified in-process. The only broken link is the last OAuth
// redirect: the platform sends the browser to 127.0.0.1, which on the user's
// machine is their own computer, not this container.
//
// Repair: pin the WEB callbackOrigin to the container's own loopback address,
// which both ends accept. The authorize URL stays on platform.deepseek.com; only
// the final redirect target changes, and the user carries that one URL to the
// app origin by hand (the address bar keeps it even though the loopback
// connection fails). Desktop sign-in is untouched.
//
// Least privilege: exactly one string literal is replaced, and only with a
// loopback origin matched against the platform's own accepted shape. Arbitrary
// or attacker-supplied origins can never be injected here.
//
// Fail-closed: an unknown bundle shape, an ambiguous match, or a malformed
// override aborts instead of silently leaving sign-in broken in a different way.

const fs = require('node:fs')
const path = require('node:path')

const MARKER_PREFIX = 'dsh-lazycat-login-origin-v1'
const DSH_ROOT = process.env.DSH_MODULE_ROOT || '/usr/local/lib/node_modules/@deepseek-ai/dsh'
const NESTED = path.join(DSH_ROOT, 'node_modules', '@deepseek-ai')
const BUNDLE_SUFFIX = path.join('lib', 'client.js')

// The container's own web port, set by entry.sh (`dsh web --port 3081`).
const DEFAULT_LOGIN_ORIGIN = 'http://127.0.0.1:3081'

// Same shape the platform accepts: plain http, loopback host, explicit
// non-zero port, no path/query/fragment/credentials.
function parseLoopbackOrigin(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.trim()
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(cleaned)
  if (!match) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return cleaned
}

const loginOrigin = parseLoopbackOrigin(process.env.DSH_LOGIN_ORIGIN || DEFAULT_LOGIN_ORIGIN)
if (loginOrigin === null) {
  throw new Error(
    `patch-dsh-login-origin: DSH_LOGIN_ORIGIN must be http://<loopback>:<port>; got ${JSON.stringify(process.env.DSH_LOGIN_ORIGIN)}`,
  )
}

// The web fallback of the callbackOrigin argument. `window.location.origin` is
// the only part replaced; the desktop branch keeps using its stream base URL.
const NEEDLE = ': window.location.origin, desktop ? "desktop" : "web")'
const replacement = `: ${JSON.stringify(loginOrigin)}, desktop ? "desktop" : "web") /* ${MARKER_PREFIX}:${loginOrigin} */`

function patchFile(target) {
  const original = fs.readFileSync(target, 'utf8')
  if (original.includes(MARKER_PREFIX)) {
    console.log(`patch-dsh-login-origin: already applied in ${target}`)
    return 'already'
  }

  const occurrences = original.split(NEEDLE).length - 1
  if (occurrences === 0) return 'no-anchor'
  if (occurrences > 1) return 'ambiguous'

  const patched = original.split(NEEDLE).join(replacement)

  const marks = patched.split(MARKER_PREFIX).length - 1
  if (marks !== 1 || !patched.includes(`: ${JSON.stringify(loginOrigin)}, desktop ?`)) {
    throw new Error('patch-dsh-login-origin: post-write verification failed')
  }

  const temporary = `${target}.lzc-patch.tmp`
  fs.writeFileSync(temporary, patched)
  fs.renameSync(temporary, target)
  console.log(`patch-dsh-login-origin: pinned web callbackOrigin to ${loginOrigin} in ${target}`)
  return 'patched'
}

// dsh ships its UI plugins as nested deps under its own node_modules. The
// account bundle is `dsh-client-ui-settings-account` today, but the sign-in
// call site is what matters, so discover by content instead of by name.
function discoverTargets() {
  const explicit = process.env.DSH_ACCOUNT_CLIENT_FILE
  if (explicit) return { targets: [explicit], seen: [] }

  const targets = []
  const seen = []
  for (const root of [NESTED, DSH_ROOT]) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      seen.push(`${root}: unreadable`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!entry.name.startsWith('dsh-client-')) continue
      const candidate = path.join(root, entry.name, BUNDLE_SUFFIX)
      if (!fs.existsSync(candidate)) continue
      let source
      try {
        source = fs.readFileSync(candidate, 'utf8')
      } catch {
        seen.push(`${candidate}: unreadable`)
        continue
      }
      if (source.includes(NEEDLE) || source.includes(MARKER_PREFIX)) targets.push(candidate)
    }
  }
  return { targets, seen }
}

const { targets, seen } = discoverTargets()
if (targets.length === 0) {
  throw new Error(
    `patch-dsh-login-origin: no client bundle contains the startSignIn call site under ${NESTED}\n  ${seen.join('\n  ')}`,
  )
}

for (const target of targets) {
  const result = patchFile(target)
  if (result === 'patched' || result === 'already') process.exit(0)
  seen.push(`${target}: ${result}`)
}

throw new Error(
  `patch-dsh-login-origin: could not patch the sign-in call site (dsh layout changed?)\n  ${seen.join('\n  ')}`,
)
