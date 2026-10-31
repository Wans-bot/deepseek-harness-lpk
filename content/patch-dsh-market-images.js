#!/usr/bin/env node
'use strict'

// The plugin market (dshmarket 1.66.x) renders every screenshot preview by
// asking images.weserv.nl to re-encode the original:
//
//   function thumbUrl(src, height) {
//     return `https://images.weserv.nl/?url=${encodeURIComponent(...)}&h=...`
//   }
//
// That resizer is a hardcoded third-party host and it is not reachable from
// every deployment — here the connection is reset, so every card thumbnail and
// theme cover fails with ERR_CONNECTION_RESET while the catalog itself loads
// fine. The market exposes no knob for it.
//
// Repair: route screenshots through the app's own /dsh-img/ proxy, which the
// manifest publishes through `public_path` and which fetches the GitHub
// original through a mirror reachable from this box. dshmarket itself did
// exactly this before 1.66, so the rendering path stays the market's own.
//
// Soft-fail on purpose: a missing or unrecognised bundle must not stop the app
// from starting — a broken thumbnail is cosmetic. The edit rewrites one function
// body, located by brace matching, and is verified by re-extracting that same
// function from the rewritten source before anything is written to disk.

const fs = require('node:fs')

const MARKER = 'dsh-lazycat-market-images-v1'

// The one file this patcher may touch. /data is fixed by the LPK manifest
// (binds /lzcapp/var/data -> /data), so this is a constant, not user input.
const MARKET_CLIENT = '/data/profiles/web/node_modules/dshmarket/client/client.js'

const skip = (message) => {
  console.error(`patch-dsh-market-images: ${message}`)
  process.exit(0) // never block startup
}

if (!fs.existsSync(MARKET_CLIENT)) {
  skip(`market client bundle not found at ${MARKET_CLIENT}; skipping preview-image repair`)
}

const original = fs.readFileSync(MARKET_CLIENT, 'utf8')

if (original.includes(MARKER)) {
  console.log(`patch-dsh-market-images: already applied in ${MARKET_CLIENT}`)
  process.exit(0)
}

const THUMB_SIGNATURE = 'function thumbUrl(src, height)'

/**
 * Locate one function body by brace matching.
 * @returns {{ body: string, start: number, end: number } | null} the body text
 *   (without the enclosing braces) and its offsets, or null when not found.
 */
function findFunctionBody(source, signature) {
  const start = source.indexOf(signature)
  if (start === -1) return null
  const open = source.indexOf('{', start + signature.length)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { body: source.slice(open + 1, i), start, end: i + 1 }
    }
  }
  return null
}

const found = findFunctionBody(original, THUMB_SIGNATURE)
if (found === null) {
  skip(`thumbUrl() not found in ${MARKET_CLIENT} (market shape changed); preview images left as upstream shipped them`)
}

if (!found.body.includes('images.weserv.nl')) {
  skip('thumbUrl() no longer uses the third-party resizer; nothing to repair')
}

const newThumbBody = `
\t\t\t// ${MARKER}: the hardcoded resizer host is unreachable from this
\t\t\t// deployment, so every screenshot goes through the app's own proxy.
\t\t\treturn \`/dsh-img/\${encodeURIComponent(src)}\`;
\t\t`

// Rebuild the whole function — signature, braces and body — so the closing brace
// is part of the replacement rather than something slice() has to preserve.
const replaced = original.slice(found.start, found.end)
const replacement = THUMB_SIGNATURE + ' {' + newThumbBody + '}'
let patched = original.slice(0, found.start) + replacement + original.slice(found.end)

// The lightbox ("click to enlarge") requests the ORIGINAL directly — the same
// unreachable host once the thumbnail resizing hop is gone.
const LIGHTBOX_OLD = 'src: shots[index],'
const LIGHTBOX_NEW = 'src: `/dsh-img/${encodeURIComponent(shots[index])}`,'
const lightboxRewritten = patched.includes(LIGHTBOX_OLD)
patched = lightboxRewritten ? patched.replace(LIGHTBOX_OLD, LIGHTBOX_NEW) : patched

// Verify by re-reading the rewritten function out of the patched source: the
// marker must be inside it, the dead host gone from it, and the proxy path
// present — all measured on the re-extracted body, not on the file at large
// (the surrounding comment still mentions the old host on purpose).
const verified = findFunctionBody(patched, THUMB_SIGNATURE)
if (verified === null) {
  skip('rewrite lost the function shape; keeping the original bundle')
}
const body = verified.body
const bodyOk =
  body.includes(MARKER) &&
  !body.includes('images.weserv.nl') &&
  body.includes('/dsh-img/') &&
  body.includes('encodeURIComponent(src)')

// The rest of the file must be byte-identical apart from the two rewrites: the
// replaced span and its replacement differ only in the function body, so the
// total size change must equal the two body-level deltas exactly.
const thumbDelta = newThumbBody.length - found.body.length
const lightboxDelta = lightboxRewritten ? LIGHTBOX_NEW.length - LIGHTBOX_OLD.length : 0
const deltaOk = patched.length - original.length === thumbDelta + lightboxDelta
const markerCount = patched.split(MARKER).length - 1

if (!bodyOk || !deltaOk || markerCount !== 1) {
  skip(`post-write verification failed (body=${bodyOk} delta=${deltaOk} markers=${markerCount}); keeping the original bundle`)
}

fs.writeFileSync(MARKET_CLIENT, patched)
console.log(
  `patch-dsh-market-images: screenshots now load through /dsh-img/ (lightbox ${lightboxRewritten ? 'also' : 'left as-is'}) in ${MARKET_CLIENT}`,
)
