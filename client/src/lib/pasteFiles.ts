// Files that arrive by paste or by drop — a screenshot taken a moment ago,
// "Copy image" from a web page, a file copied in the file manager, a picture
// the phone's keyboard offers from its clipboard — turned into File objects any
// attach flow can take. Every box that accepts attachments asks this one module
// what a paste "is", so the rule is the same everywhere:
//
//   • Words win. Word, Excel and Google Docs put a picture of the copied text on
//     the clipboard next to the text itself; pasting that must still paste the
//     words. So when the clipboard has plain text, the paste is text.
//   • Otherwise any files on it are the paste.
//
// A drop is always files when it carries any: there is no "text version" of a
// dragged screenshot to prefer.

// Clipboard pictures usually arrive with a placeholder name ("image.png" from
// Chrome, "blob", or none at all). Ten of them in one chat would all read
// "image.png", so they are renamed after the moment they were pasted.
const GENERIC_NAME = /^(image|blob|clipboard|pasted[ -]?image)?(\.[a-z0-9]+)?$/i
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic' }

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

function named(files: File[]): File[] {
  const at = stamp()
  return files.map((f, i) => {
    if (f.name && !GENERIC_NAME.test(f.name)) return f
    const ext = EXT[f.type] || (f.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')
    const name = `${f.type.startsWith('image/') ? 'Screenshot' : 'Pasted file'} ${at}${files.length > 1 ? ` (${i + 1})` : ''}.${ext}`
    return new File([f], name, { type: f.type, lastModified: f.lastModified || Date.now() })
  })
}

function filesOf(dt: DataTransfer): File[] {
  // `files` is the reliable list where it is filled in; some browsers only fill
  // `items` for clipboard images, so fall back to those.
  const direct = Array.from(dt.files || [])
  if (direct.length) return direct
  const out: File[] = []
  for (const it of Array.from(dt.items || [])) {
    if (it.kind !== 'file') continue
    const f = it.getAsFile()
    if (f) out.push(f)
  }
  return out
}

/** The files a paste carries, or [] when it is a paste of words. */
export function clipboardFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  if ((dt.getData('text/plain') || '').trim()) return []
  return named(filesOf(dt))
}

/** The files a drop carries ([] for a drop of text or a link). */
export function droppedFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  return named(filesOf(dt))
}

/** Whether a drag carries files at all — decided before the drop, when only the types are visible. */
export function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types || []).includes('Files')
}

/** Whether this browser can read a picture off the clipboard when asked (a button, not Ctrl+V). */
export const canReadClipboardImages = () =>
  typeof navigator !== 'undefined' && !!navigator.clipboard && typeof (navigator.clipboard as any).read === 'function'

/**
 * Read pictures off the clipboard on request — the "Paste from clipboard"
 * button for phones, where there is no Ctrl+V. Must run inside a tap. Throws
 * when the browser or the user refuses; resolves [] when there is no picture.
 */
export async function readClipboardImages(): Promise<File[]> {
  const items: ClipboardItem[] = await (navigator.clipboard as any).read()
  const out: File[] = []
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    out.push(new File([blob], '', { type: blob.type || type }))
  }
  return named(out)
}
