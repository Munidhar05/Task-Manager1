// Link previews for chat messages — the title / description / picture card
// WhatsApp shows under a pasted link.
//
// The server fetches the page, not the browser: a browser cannot read another
// site's HTML (CORS), and doing it once here means the twentieth person to see
// the link pays nothing — results are cached in chat_link_previews.
//
// Fetching arbitrary URLs from a server is the textbook SSRF hole, so every
// connection is checked at the moment it is made, not just when the URL is
// parsed: the hostname is resolved through our own `lookup`, and an address in
// a private, loopback, link-local or cloud-metadata range is refused. Checking
// in the lookup (rather than resolving first and fetching after) is what stops
// DNS rebinding, and it applies to every redirect hop as well. Only ports 80
// and 443, only HTML, at most 400 KB read, five seconds per hop.
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import { db } from './db.js'

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const v4 = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0)

export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4(ip)
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4(base) >>> (32 - bits)))
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    if (l === '::' || l === '::1') return true
    // unique-local fc00::/7, link- and site-local fe80::/10 fec0::/10, multicast ff00::/8
    if (/^f[cd]/.test(l) || /^fe[89a-f]/.test(l) || /^ff/.test(l)) return true
    // An IPv4 address wearing IPv6 clothes (::ffff:… mapped, 64:ff9b::… NAT64),
    // written dotted or — as URL normalises it — in hex: judged as the IPv4.
    const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(l)
    if (dotted) return isBlockedAddress(dotted[1])
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l)
    if (hex) {
      const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16)
      return isBlockedAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`)
    }
    return false
  }
  return true
}

// dns.lookup with the address check in the middle. Node may ask for every
// address at once (`all: true`, used by happy-eyeballs); refuse the lot if any
// one of them is internal, rather than hoping the connection picks a good one.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err)
    const list = Array.isArray(address) ? address : [{ address, family }]
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) return cb(new Error('Blocked address'))
    if (Array.isArray(address)) cb(null, address)
    else cb(null, address, family)
  })
}

function fetchPage(url, hops = 3) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve(null) }
    if (!/^https?:$/.test(u.protocol) || (u.port && u.port !== '80' && u.port !== '443')) return resolve(null)
    // Node never calls `lookup` for an address written as an IP ("127.0.0.1",
    // "[::1]", or "2130706433", which URL turns into 127.0.0.1), so those are
    // checked here, on every hop, redirects included.
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host) && isBlockedAddress(host)) return resolve(null)
    const mod = u.protocol === 'https:' ? https : http
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.request(u, {
      method: 'GET',
      lookup: safeLookup,
      timeout: 5000,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; VoTaskLinkPreview/1.0; +https://votask.app)',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-IN,en;q=0.8',
      },
    }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location && hops > 0) {
        res.resume()
        let next
        try { next = new URL(res.headers.location, u).toString() } catch { return finish(null) }
        return fetchPage(next, hops - 1).then(finish)
      }
      if (code !== 200 || !/html/i.test(String(res.headers['content-type'] || ''))) { res.resume(); return finish(null) }
      const chunks = []
      let size = 0
      const collect = () => finish({ html: Buffer.concat(chunks).toString('utf8'), url: u.toString() })
      res.on('data', (c) => {
        chunks.push(c); size += c.length
        // The <head> is all we read, and it is near the top.
        if (size > 400000) { res.destroy(); collect() }
      })
      res.on('end', collect)
      res.on('error', () => finish(null))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => finish(null))
    req.end()
  })
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

// <meta property="og:title" content="…"> in either attribute order.
function metaOf(html, names) {
  for (const n of names) {
    const a = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)
    const b = a || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i').exec(html)
    const v = b ? decode(b[1]) : ''
    if (v) return v
  }
  return ''
}

function parse(page) {
  const head = page.html.slice(0, 200000)
  const title = metaOf(head, ['og:title', 'twitter:title']) || decode((/<title[^>]*>([^<]*)<\/title>/i.exec(head) || [])[1] || '')
  const description = metaOf(head, ['og:description', 'twitter:description', 'description'])
  let image = metaOf(head, ['og:image', 'og:image:url', 'twitter:image'])
  try { image = image ? new URL(image, page.url).toString() : '' } catch { image = '' }
  if (image && !/^https?:\/\//i.test(image)) image = ''
  let host = ''
  try { host = new URL(page.url).hostname.replace(/^www\./, '') } catch {}
  const site = metaOf(head, ['og:site_name']) || host
  if (!title && !description) return null
  return { title: title.slice(0, 200), description: description.slice(0, 300), image: image.slice(0, 1000) || null, site: site.slice(0, 80) }
}

const FRESH_MS = 7 * 86400000      // a page's preview, re-read weekly
const MISS_MS = 86400000           // a page with nothing to show, retried daily
const inflight = new Map()

export async function linkPreview(url) {
  const cached = db.prepare('SELECT data, fetched_at FROM chat_link_previews WHERE url=?').get(url)
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime()
    if (age < (cached.data ? FRESH_MS : MISS_MS)) {
      try { return cached.data ? JSON.parse(cached.data) : null } catch { return null }
    }
  }
  if (inflight.has(url)) return inflight.get(url)
  const job = (async () => {
    const page = await fetchPage(url)
    const data = page ? parse(page) : null
    db.prepare('INSERT OR REPLACE INTO chat_link_previews (url, data, fetched_at) VALUES (?,?,?)')
      .run(url, data ? JSON.stringify(data) : null, new Date().toISOString())
    return data
  })().finally(() => inflight.delete(url))
  inflight.set(url, job)
  return job
}
