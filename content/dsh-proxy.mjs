// dsh auth auto-proxy: forwards all requests to the loopback dsh server.
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
const LISTEN = Number(process.env.PROXY_LISTEN || 3080)
const TARGET_HOST = process.env.DSH_TARGET_HOST || '127.0.0.1'
const TARGET_PORT = Number(process.env.DSH_TARGET_PORT || 3081)
const TOKEN = process.env.DSH_TOKEN || ''
const PUBLIC_HOST = process.env.DSH_PUBLIC_HOST || ''
const DEBUG = process.env.DSH_PROXY_DEBUG === '1'
const IMG_PREFIX = '/dsh-img/'
const GHPROXY = process.env.DSH_IMG_PROXY || 'https://gh-proxy.com'

function log(...args) {
  if (DEBUG) console.error('[proxy]', ...args)
}
// A browser that navigates away or closes a tab aborts sockets mid-stream. Every
// hop below owns raw sockets or streams, and an abort surfaces as an 'error'
// event on the socket Node handed us — with no listener that is an uncaught
// exception, which takes the whole container down (the app then shows as
// stopped until the platform restarts it). These helpers keep one broken
// connection local instead of fatal.
function swallow(socket, label) {
  socket.on('error', (err) => log(label, 'error', err.message))
  return socket
}
function closeTogether(a, b, label) {
  swallow(a, label + ':a')
  swallow(b, label + ':b')
  a.on('close', () => b.destroy())
  b.on('close', () => a.destroy())
}
function encodeBase64Url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
function expectedCookieName() {
  if (PUBLIC_HOST === '') return ''
  const authority = PUBLIC_HOST.toLowerCase()
  return 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest())
}
function hasValidCookie(req) {
  if (PUBLIC_HOST === '') return false
  const cookie = req.headers.cookie ?? ''
  const name = expectedCookieName()
  const segments = cookie.split(';').map((s) => s.trim())
  return segments.some((seg) => seg.startsWith(name + '='))
}
function withToken(path) {
  const url = new URL(path, 'http://dsh.local')
  if (url.pathname !== '/' || url.searchParams.has('token')) return path
  return url.search === '' ? '/?token=' + encodeURIComponent(TOKEN) : url.search + '&token=' + encodeURIComponent(TOKEN)
}
function targetHeaders(req) {
  const headers = { ...req.headers, connection: 'close' }
  if (PUBLIC_HOST !== '') headers.host = PUBLIC_HOST
  normalizeBrowserMarkers(headers)
  return headers
}
function upgradeHeaders(req) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (typeof v === 'string' && v.includes(',') && (lk.startsWith('sec-websocket') || lk === 'upgrade' || lk === 'connection')) {
      headers[k] = v.split(',')[0].trim()
    } else {
      headers[k] = v
    }
  }
  if (PUBLIC_HOST !== '') headers.host = PUBLIC_HOST
  normalizeBrowserMarkers(headers)
  return headers
}
/**
 * LazyCat ingress may terminate TLS on a non-default port (e.g. :10001 in the
 * box test route), while PUBLIC_HOST carries the bare authority. DSH compares
 * the Origin host to the rewritten Host, so a port mismatch would be rejected.
 * Normalize ONLY requests whose Origin hostname is our own PUBLIC_HOST; any
 * other Origin and any genuinely cross-site Fetch Metadata is preserved so
 * DSH's browser-trust fence can reject it.
 */
function normalizeBrowserMarkers(headers) {
  if (PUBLIC_HOST === '') return
  const origin = headers.origin
  let sameAuthority = false
  if (typeof origin === 'string') {
    try {
      sameAuthority = new URL(origin).hostname.toLowerCase() === PUBLIC_HOST.toLowerCase()
    } catch {
      sameAuthority = false
    }
  }
  if (sameAuthority) {
    headers.origin = 'https://' + PUBLIC_HOST
    if (headers['sec-fetch-site'] === 'cross-site') headers['sec-fetch-site'] = 'same-origin'
  }
}
function proxyImage(req, res) {
  let raw = decodeURIComponent(req.url.slice(IMG_PREFIX.length))
  if (!/^https?:\/\//.test(raw)) raw = 'https://' + raw
  log('IMG', raw, '->', GHPROXY + '/' + raw)
  const target = GHPROXY + '/' + raw
  const proxyReq = https.get(target, (upRes) => {
    const status = upRes.statusCode ?? 502
    swallow(upRes, 'img:upstream')
    if (status >= 300 && status < 400 && upRes.headers.location) {
      const loc = upRes.headers.location
      const next = /^https?:/.test(loc) ? loc : new URL(loc, target).href
      const r2 = https.get(next, (upRes2) => {
        const h2 = { ...upRes2.headers, 'cache-control': 'public, max-age=3600' }
        res.writeHead(upRes2.statusCode ?? 502, h2)
        upRes2.pipe(res)
        swallow(upRes2, 'img:redirect')
      })
      r2.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('img proxy err: ' + e.message) })
      return
    }
    const headers = { ...upRes.headers, 'cache-control': 'public, max-age=3600' }
    res.writeHead(status, headers)
    upRes.pipe(res)
  })
  proxyReq.on('error', (err) => {
    log('IMG ERR', err.message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('img proxy error: ' + err.message)
  })
}
const server = http.createServer((req, res) => {
  // A request body the client aborts mid-upload must not be fatal either.
  swallow(req, 'req')
  swallow(res, 'res')
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  if (url.pathname.startsWith(IMG_PREFIX) && (req.method === 'GET' || req.method === 'HEAD')) {
    proxyImage(req, res)
    return
  }
  const isRoot = url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')
  let path = req.url ?? '/'
  if (isRoot) {
    if (hasValidCookie(req) || url.searchParams.has('token')) {
      log('root-pass', req.url, 'host=' + (req.headers.host || ''), 'cookie=' + ((req.headers.cookie || '').slice(0, 40) || '-'))
    } else if (TOKEN !== '') {
      path = withToken(path)
      log('root-token', req.url, 'host=' + (req.headers.host || ''), '->', path)
    }
  } else {
    log(req.method, req.url, 'host=' + (req.headers.host || ''), 'cookie=' + ((req.headers.cookie || '').slice(0, 40) || '-'))
  }
  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, path, method: req.method, headers: targetHeaders(req) },
    (proxyRes) => {
      log('  <-', proxyRes.statusCode, req.url)
      swallow(proxyRes, 'upstream')
      if (isRoot && proxyRes.statusCode === 401 && !url.searchParams.has('token') && TOKEN !== '') {
        log('  root 401 -> retry with token')
        proxyRes.resume()
        const retryPath = withToken(url.pathname === '/' && url.search === '' ? '/' : url.pathname + url.search)
        const retryReq = http.request(
          { host: TARGET_HOST, port: TARGET_PORT, path: retryPath, method: 'GET', headers: targetHeaders(req) },
          (retryRes) => {
            log('  retry <-', retryRes.statusCode)
            swallow(retryRes, 'retry-upstream')
            const h2 = { ...retryRes.headers }
            const c2 = String(h2['content-type'] || '').toLowerCase()
            if (c2.includes('text/html')) h2['cache-control'] = 'no-store'
            if (retryRes.url?.includes('/plugins/')) h2['cache-control'] = 'no-cache'
            res.writeHead(retryRes.statusCode ?? 502, h2)
            retryRes.pipe(res)
          },
        )
        retryReq.on('error', (err) => {
          log('  retry ERR', err.message)
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('proxy retry error: ' + err.message)
        })
        retryReq.end()
        return
      }
      const headers = { ...proxyRes.headers }
      const ct = String(headers['content-type'] || '').toLowerCase()
      if (ct.includes('text/html')) {
        headers['cache-control'] = 'no-store'
      }
      if (req.url?.includes('/plugins/')) {
        headers['cache-control'] = 'no-cache'
        delete headers.etag
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    log('  ERR', err.message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('proxy error: ' + err.message)
  })
  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyReq.end()
  } else {
    req.pipe(proxyReq)
  }
})
server.on('upgrade', (req, socket, head) => {
  log('WS incoming:', req.url, 'headers:', JSON.stringify(req.headers))
  swallow(socket, 'ws:client')
  const headers = upgradeHeaders(req)
  log('WS forward headers:', JSON.stringify(headers))
  const proxyReq = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url ?? '/',
    method: req.method ?? 'GET',
    headers,
  })
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    log('  WS <- 101 for', req.url)
    // Either side resetting must tear down only this tunnel; a WebSocket that
    // dies while the tab is closing is normal traffic, not a process fault.
    closeTogether(socket, proxySocket, 'ws')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept'] ?? ''}\r\n\r\n`,
    )
    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead)
    if (head && head.length > 0) proxySocket.write(head)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })
  proxyReq.on('response', (proxyRes) => {
    log('  WS <- non-upgrade response', proxyRes.statusCode, req.url)
    swallow(proxyRes, 'ws:response')
    socket.write(`HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ''}\r\n`)
    for (const [k, v] of Object.entries(proxyRes.headers)) socket.write(`${k}: ${v}\r\n`)
    socket.write('\r\n')
    proxyRes.pipe(socket)
  })
  proxyReq.on('error', (err) => {
    log('  WS ERR', err.message)
    socket.destroy()
  })
  proxyReq.end()
})
server.listen(LISTEN, '0.0.0.0', () => {
  console.error(`dsh-auth-proxy listening on 0.0.0.0:${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT} public=${PUBLIC_HOST || '(passthrough)'} img=${IMG_PREFIX}->${GHPROXY} debug=${DEBUG ? 'on' : 'off'}`)
})
