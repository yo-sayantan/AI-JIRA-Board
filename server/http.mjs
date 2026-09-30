import { open } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)

export function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj))
}

/** Read a request body as text; null when it exceeds `limit` bytes. */
export async function readBody(req, limit) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) return null
  }
  return body
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/
const MAX_CACHED_BYTES = 8 * 1024 * 1024

/**
 * Static files under `root`, limited to the `allow` patterns. The board bundle and data.js are
 * ~0.7 MB each and re-requested on every reload, so each file is kept in memory (plain + gzip)
 * until its mtime changes, and revalidated with an ETag instead of being re-sent.
 */
export function createStaticHandler(root, allow) {
  const cache = new Map()

  async function load(file) {
    const fh = await open(file)
    try {
      const st = await fh.stat()
      if (!st.isFile()) return null
      const hit = cache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
      const body = await fh.readFile()
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
      const entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        type,
        etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        body,
        gz: COMPRESSIBLE.test(type) && body.length > 1024 ? await gzipAsync(body) : null,
      }
      if (body.length <= MAX_CACHED_BYTES) cache.set(file, entry)
      return entry
    } finally {
      await fh.close()
    }
  }

  return async function serveStatic(req, res, path) {
    const safe = normalize(path).replace(/^(\.\.([/\\]|$))+/, '')
    const file = join(root, safe)
    if (!file.startsWith(root) || !allow.some((re) => re.test(safe))) {
      res.writeHead(404).end('Not found')
      return
    }
    let entry
    try {
      entry = await load(file)
    } catch {
      entry = null
    }
    if (!entry) {
      res.writeHead(404).end('Not found')
      return
    }
    const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', ETag: entry.etag, Vary: 'Accept-Encoding' }
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers).end()
      return
    }
    const useGzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')
    const body = useGzip ? entry.gz : entry.body
    if (useGzip) headers['Content-Encoding'] = 'gzip'
    headers['Content-Length'] = body.length
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body)
  }
}
