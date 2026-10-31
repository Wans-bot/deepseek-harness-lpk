#!/usr/bin/env node
'use strict'

// Re-create working directories recorded by earlier releases.
//
// Why this exists (review #22166: "每次重启应用，在原来开启的旧会话中继续对话报错"):
// releases up to 1.1.15 started dsh with HOME=/root, so a workspace created in
// the Web UI was recorded as `/root/<name>` — on the container's own writable
// layer, which is thrown away whenever the container is recreated. The durable
// registry (/data/storages/workspace.json) and every session header keep that
// old absolute path, and @deepseek-ai/dsh-working-directory refuses to run a
// turn whose directory is gone:
//
//     working-directory: directory does not exist: "/root/work1"
//
// entry.sh now links /root onto the persistent volume (so /root/x and
// $DSH_HOME/home/x are the same directory from now on) and this script makes
// sure every recorded directory exists again. Old sessions therefore keep
// working, and anything they write lands on the persistent volume.
//
// Read-only with respect to dsh's data: it only creates directories.
//
// Usage: node patch-dsh-workspace-dirs.js <workspace.json> [<sessions-root>...]

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// Only ever create directories under the roots dsh can legitimately record:
// the persistent volume, the legacy /root home, the netdisk documents mount.
const ALLOWED_ROOTS = ['/root/', '/data/', '/lzcapp/', '/home/', '/workspace/']

// Session logs can be large; the header is always the first line, so read a
// bounded prefix and only fall back to the whole file when that prefix does not
// contain a complete compressed frame.
const PREFIX_BYTES = 256 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_SESSION_FILES = 400

const args = process.argv.slice(2)
const jsonFiles = args.filter((arg) => arg.endsWith('.json'))
const sessionRoots = args.filter((arg) => !arg.endsWith('.json'))

const seen = new Set()
let repaired = 0
let kept = 0
let warned = 0
let scanned = 0

function allowed(dir) {
  return ALLOWED_ROOTS.some((root) => dir === root.slice(0, -1) || dir.startsWith(root))
}

function ensure(dir, source) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) return
  const normalized = path.posix.normalize(dir)
  if (seen.has(normalized)) return
  seen.add(normalized)
  let info
  try {
    info = fs.statSync(normalized)
  } catch {
    info = undefined
  }
  if (info) {
    if (info.isDirectory()) kept += 1
    else {
      warned += 1
      console.error(`WARN: recorded working directory is not a directory: ${normalized} (${source})`)
    }
    return
  }
  if (!allowed(normalized)) {
    warned += 1
    console.error(`WARN: refusing to create ${normalized} outside the known roots (${source})`)
    return
  }
  try {
    fs.mkdirSync(normalized, { recursive: true })
    repaired += 1
    console.log(`re-created missing working directory: ${normalized} (${source})`)
  } catch (error) {
    warned += 1
    console.error(`WARN: could not create ${normalized}: ${error.message}`)
  }
}

function readJson(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch {
    console.error(`WARN: ${file} is not valid JSON; skipped`)
    return undefined
  }
}

// Returns the first line of a session log, transparently handling the formats
// dsh writes: plain .jsonl, .jsonl.gz and .jsonl.zstd (v4 logs are zstd).
function firstLine(file) {
  let read
  if (file.endsWith('.zstd') || file.endsWith('.gz')) {
    const decompress = file.endsWith('.zstd') ? zlib.zstdDecompressSync : zlib.gunzipSync
    if (typeof decompress !== 'function') return undefined
    const decode = (buffer) => decompress(buffer).toString('utf8').split('\n', 1)[0]
    let prefix
    try {
      prefix = fs.readFileSync(file).subarray(0, PREFIX_BYTES)
    } catch {
      return undefined
    }
    try {
      return decode(prefix)
    } catch {
      // The prefix cut the frame short: fall back to the whole file, bounded.
    }
    let size
    try {
      size = fs.statSync(file).size
    } catch {
      return undefined
    }
    if (size > MAX_FILE_BYTES) return undefined
    try {
      return decode(fs.readFileSync(file))
    } catch {
      return undefined
    }
  }
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      read = fs.readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.subarray(0, read).toString('utf8').split('\n', 1)[0]
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

// 1. Workspace registry: tables.workspaces[*].path
for (const file of jsonFiles) {
  const data = readJson(file)
  const workspaces = data && data.tables && data.tables.workspaces
  if (!workspaces || typeof workspaces !== 'object') continue
  for (const record of Object.values(workspaces)) {
    if (record && typeof record === 'object' && typeof record.path === 'string') {
      ensure(record.path, path.basename(file))
    }
  }
}

// 2. Session headers: a Session whose cwd was a subdirectory of a workspace (or
//    predates workspaces entirely) records that directory in its header. The
//    session log lives at <root>/<projectKey(cwd)>/<id>/session.*.jsonl[.zstd],
//    and the project key cannot be decoded reliably, so read the header instead.
function walkSessions(dir, depth) {
  if (depth > 4 || scanned >= MAX_SESSION_FILES) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (scanned >= MAX_SESSION_FILES) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSessions(full, depth + 1)
      continue
    }
    if (!entry.isFile() || !/\.jsonl(\.(zstd|gz))?$/.test(entry.name)) continue
    scanned += 1
    const head = firstLine(full)
    if (!head) continue
    let header
    try {
      header = JSON.parse(head)
    } catch {
      continue
    }
    const cwd = header && (header.cwd ?? (header.header && header.header.cwd))
    if (typeof cwd === 'string') ensure(cwd, 'session header')
  }
}

for (const root of sessionRoots) walkSessions(root, 0)

if (repaired > 0 || warned > 0) {
  console.log(
    `working directories: re-created ${repaired}, already present ${kept}, warnings ${warned}, session logs scanned ${scanned}`,
  )
}
