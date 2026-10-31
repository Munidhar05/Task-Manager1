import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream'
import { id } from './util.js'

// Big uploads (chat files, task attachments) in and out of the data disk. Chat
// grew this when its limit went to 1 GB; task attachments share it so the two
// cannot drift apart, and so both count against the one disk they share.

export const MB = 1024 * 1024
// That disk also holds the SQLite database. A file that fills it does not just
// fail to save — every later write in the app fails with it — so a file is only
// let in if this much is still free once it lands.
const DISK_HEADROOM = 200 * MB
// Bytes promised to uploads still streaming in, so two big files that each fit
// on their own cannot both be let into room only one of them has. Module-wide on
// purpose: a chat file and a task attachment land on the same disk.
let reserved = 0

// multer's own diskStorage pipes the part into the file and stops there: a
// sender who drops out mid-file leaves the write stream open and the half-file
// on disk for good. For hundreds of MB over a phone connection that is the
// common case, not the rare one, so this does the same job and closes and
// removes the scrap when the request goes away unfinished.
export function streamingStorage(dir, prefix) {
  return {
    _handleFile(req, file, cb) {
      const filename = id(prefix) + path.extname(file.originalname || '').slice(0, 12)
      const abs = path.join(dir, filename)
      const out = fs.createWriteStream(abs)
      const abandon = () => { if (!req.complete) out.destroy(new Error('Upload abandoned')) }
      req.once('close', abandon)
      pipeline(file.stream, out, (err) => {
        req.off('close', abandon)
        if (err) { fs.unlink(abs, () => {}); return cb(err) }
        cb(null, { destination: dir, filename, path: abs, size: out.bytesWritten })
      })
    },
    _removeFile(req, file, cb) { fs.unlink(file.path, () => cb(null)) },
  }
}

const freeBytes = (dir) => {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize } catch { return Infinity }
}

const NO_ROOM = 'The server is out of storage space for a file this size'

// Browsers send a file's name as UTF-8, but the busboy under multer 1.4.5 reads
// it as Latin-1, so "రిపోర్ట్.xlsx" or "Q3 — final.xlsx" arrived garbled. The
// Latin-1 string still holds the exact bytes, so re-reading them as UTF-8 gets
// the name back; a name that is not valid UTF-8 is left as it came, and so is
// one already holding characters past Latin-1 (a multer that decodes properly).
const utf8Name = (name) => {
  if (!name || !/[\x80-\xff]/.test(name) || /[^\x00-\xff]/.test(name)) return name
  const fixed = Buffer.from(name, 'latin1').toString('utf8')
  return fixed.includes('�') ? name : fixed
}

// One upload route's way in: `receive` is the middleware, `refusal(bytes)` is
// the same verdict for an upload-room question asked before sending.
//
// Content-Length is the whole form, so a file that is over the limit, or that
// the disk has no room for, is turned away before a byte of it is written, and
// the connection closed so the rest is not sent for nothing. The sender's
// browser will not read that answer mid-upload — it sees a dropped connection —
// which is why the app asks the route's upload-room first. multer's own errors
// come back as a status, not the global 500.
export function bigFileUpload({ dir, prefix, max, tooBig }) {
  // +1 because busboy counts reaching the limit as going over it, and a file of
  // exactly `max` is one the app says it takes.
  const upload = multer({ storage: streamingStorage(dir, prefix), limits: { fileSize: max + 1 } })
  // [status, message] if this many bytes cannot come in right now, else null.
  // The MB of slack is the multipart wrapping around the file itself.
  const refusal = (len) => (len > max + MB ? [413, tooBig]
    : len && freeBytes(dir) - reserved - len < DISK_HEADROOM ? [507, NO_ROOM] : null)
  function receive(req, res, next) {
    const len = Number(req.headers['content-length']) || 0
    const refuse = (status, error) => { if (!res.headersSent) res.status(status).set('Connection', 'close').json({ error }) }
    const no = refusal(len)
    if (no) return refuse(...no)
    reserved += len
    let gone = false
    res.once('close', () => { reserved -= len; if (!res.writableFinished) gone = true })
    upload.single('file')(req, res, (err) => {
      if (!err) {
        if (req.file) req.file.originalname = utf8Name(req.file.originalname)
        return next()
      }
      if (gone) return // the sender left; storage has already removed the half-file
      if (err.code === 'LIMIT_FILE_SIZE') return refuse(413, tooBig)
      if (err.code === 'ENOSPC') return refuse(507, NO_ROOM)
      next(err)
    })
  }
  return { receive, refusal }
}

// Sent with res.sendFile rather than piped, because a media player needs more
// than a byte stream: Range requests (206) are how a <video> seeks — and iOS
// WebKit will not play a video at all from a server that ignores them —
// Content-Length lets a player show how far along it is, and ETag /
// Last-Modified let an image grid revalidate instead of downloading again.
// Cached privately only: the URL carries the viewer's token.
//
// An upload is served from the app's own origin, so an HTML or SVG file opened
// inline would run its scripts with the viewer's session. Those get a sandbox
// CSP, which renders them script-less in an opaque origin; images, video, audio,
// PDFs and office files never match and are untouched by it.
const ACTIVE_TYPE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/(x-)?javascript)\b/i
const ACTIVE_EXT = /\.(html?|xht|xhtml|svgz?|xml|xsl|js|mjs)$/i

// RFC 6266: an ASCII name every browser reads, plus the real one for those that
// read filename* — so "Q3 sales — final.xlsx" saves under that name, not with
// %20s in it.
const disposition = (kind, name) => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function sendStoredFile(req, res, abs, { name, type, maxAge }) {
  const filename = name || 'file'
  // The declared type wins (send never overrides a Content-Type that is
  // already set), except the generic octet-stream: then send names the type
  // from the stored extension, so a photo picked as "a file" still displays
  // and a clip still plays.
  if (type && !/^application\/octet-stream\b/i.test(type)) res.type(type)
  res.setHeader('Content-Disposition', disposition(req.query.download === '1' ? 'attachment' : 'inline', filename))
  res.setHeader('Cache-Control', `private, max-age=${maxAge}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (ACTIVE_TYPE.test(type || '') || ACTIVE_EXT.test(abs) || ACTIVE_EXT.test(filename)) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
  }
  // Dotfiles allowed because the path is ours, not the requester's; the cache
  // header is the one set above, not send's public default.
  res.sendFile(abs, { cacheControl: false, dotfiles: 'allow' }, (err) => {
    // Nothing to fix once the headers are out, or when the viewer went away
    // mid-transfer — which a seeking <video> does all the time.
    if (!err || res.headersSent || err.code === 'ECONNABORTED') return
    // send had already set the file's headers when it hit the error, and none
    // of them describe what goes out instead.
    for (const h of ['Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified', 'Accept-Ranges', 'Content-Security-Policy']) res.removeHeader(h)
    res.setHeader('Cache-Control', 'no-store')
    // A range past the end of the file, or a failed If-Match: answer with the
    // status send chose (it has already set Content-Range for a 416).
    const status = err.status || err.statusCode
    if (status === 416 || status === 412) return res.status(status).end()
    res.status(404).json({ error: 'File missing' })
  })
}
