#!/usr/bin/env node
'use strict'

// Keep cordis.patch.yml's working-directory entry in sync WITHOUT touching
// anything else. History: the old entry.sh rewrote everything between
// `# >>> lazycat managed >>` / `# <<< lazycat managed <<`, but dsh appends its
// own settings entries (llm providers, ui-settings-general, …) to the END of
// that same file, i.e. inside our block. Every container start then deleted the
// user's custom models. Reported by the user as "custom model disappears after
// restart".
//
// New rule: locate the top-level sequence item whose `id:` is
// `working-directory` by text, replace exactly that item (or append one), and
// leave every other byte — including dsh's later additions — untouched.
//
// Usage: node patch-dsh-working-directory.js <patch.yml> <workspace-dir>

const fs = require('node:fs')
const path = require('node:path')

const [, , targetArg, workspaceDir] = process.argv
if (!targetArg || !workspaceDir) {
  throw new Error('patch-dsh-working-directory: expected <patch.yml> <workspace-dir>')
}
const target = path.resolve(targetArg)

const MANAGED_ITEM = [
  '- id: working-directory',
  '  config:',
  `    defaultDirectory: ${JSON.stringify(workspaceDir)}`,
]
const LEGACY_MARKER = /^#\s*(>>>|<<<)\s*lazycat managed/
// Upstream ships the patch layer as a comments-only file whose document is the
// empty flow sequence `[]`. Appending block-style `- id:` items after that line
// makes the file invalid YAML (YAMLException: end of the stream or a document
// separator is expected) and dsh refuses to start ("failed to parse overlay").
// A fresh install therefore dropped straight into that state, so treat the
// empty-document forms as "no items" and drop the line before appending.
const EMPTY_DOCUMENT = /^(\[\s*\]|~|null|\{\s*\})\s*(#.*)?$/
const ITEM_START = /^-\s/
const WORKDIR_ID = /^-\s*id:\s*["']?working-directory["']?\s*(#.*)?$/

let original = ''
try {
  original = fs.readFileSync(target, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

// 1. Drop legacy managed-block marker comments (they only ever bracketed our
//    own entry; dsh entries that ended up between them stay).
const lines = original
  .split('\n')
  .filter((line) => !LEGACY_MARKER.test(line.trim()))
  .filter((line) => !EMPTY_DOCUMENT.test(line.trim()))

// 2. Find the working-directory item and its span (up to the next top-level item).
function itemEnd(start) {
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]
    if (ITEM_START.test(line)) return index
    // A top-level key (`foo:`) also terminates the sequence item.
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')) return index
    index += 1
  }
  return lines.length
}

const starts = []
for (let index = 0; index < lines.length; index += 1) {
  if (WORKDIR_ID.test(lines[index])) starts.push(index)
}
const duplicates = starts.length > 1
if (duplicates) {
  // Second and later copies are stale; remove them from the tail first.
  for (const start of starts.slice(1).reverse()) {
    lines.splice(start, itemEnd(start) - start)
  }
}

const head = starts.length > 0 ? starts[0] : -1
if (head >= 0) {
  lines.splice(head, itemEnd(head) - head, ...MANAGED_ITEM)
} else {
  // Append at the end, keeping exactly one blank line of separation.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > 0) lines.push('')
  lines.push(...MANAGED_ITEM)
}

let output = lines.join('\n')
if (!output.endsWith('\n')) output += '\n'

// 3. Verify before writing: exactly one working-directory item, our value in it,
//    and no item count regression (dsh's own entries must survive).
const count = (text) => (text.match(/^-\s*id:/gm) || []).length
const before = count(original)
const after = count(output)
if (!output.includes(`defaultDirectory: ${JSON.stringify(workspaceDir)}`)) {
  throw new Error('patch-dsh-working-directory: verification failed (defaultDirectory missing)')
}
if ((output.match(/^-\s*id:\s*["']?working-directory["']?\s*$/gm) || []).length !== 1) {
  throw new Error('patch-dsh-working-directory: verification failed (working-directory item count != 1)')
}
// Duplicate working-directory items are stale copies we remove on purpose; every
// other item (dsh's own settings) must survive. Expected = before - stale + maybe-new.
const expected = before - Math.max(0, starts.length - 1) + (starts.length > 0 ? 0 : 1)
// A document that is a scalar/empty sequence cannot also hold block items: that
// combination is exactly what broke the fresh install, so never write it out.
if (output.split('\n').some((line) => EMPTY_DOCUMENT.test(line.trim())) && after > 0) {
  throw new Error('patch-dsh-working-directory: verification failed (empty-document marker next to items)')
}
if (after !== expected) {
  throw new Error(
    `patch-dsh-working-directory: verification failed (item count ${before} -> ${after}, expected ${expected})`,
  )
}

if (output !== original) {
  const temporary = `${target}.lzc-patch.tmp`
  fs.writeFileSync(temporary, output)
  fs.renameSync(temporary, target)
  console.log(`working-directory.defaultDirectory -> ${workspaceDir} (other settings preserved)`)
} else {
  console.log('working-directory.defaultDirectory already correct')
}
