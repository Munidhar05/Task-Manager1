// MediaRecorder does not produce the same container everywhere, and the
// transcription providers key off the FILENAME as much as the mime type — Sarvam
// and Whisper both reject an MPEG-4 payload announced as `.webm`. Chromium (desktop
// and the Android WebView) hands us webm/opus; iOS WKWebView has never supported
// webm and returns audio/mp4 instead. So the extension has to come from the blob we
// actually got, never from a literal at the call site.

const EXT: Array<[RegExp, string]> = [
  [/^audio\/webm/, 'webm'],
  [/^audio\/ogg/, 'ogg'],
  // audio/mp4 (iOS) and audio/aac are both MPEG-4 containers. `.m4a` is the
  // audio-only spelling every provider recognises; `.mp4` makes some of them
  // look for a video stream that isn't there.
  [/^audio\/(mp4|x-m4a|m4a|aac)/, 'm4a'],
  [/^audio\/(wav|x-wav|wave)/, 'wav'],
  [/^audio\/mpeg/, 'mp3'],
]

// `base` is the stem the server sees as req.file.originalname (e.g. 'command').
export function audioFilename(blob: Blob, base: string): string {
  const hit = EXT.find(([re]) => re.test((blob.type || '').toLowerCase()))
  // Empty/unknown type: webm is the safe guess, because every engine that leaves
  // mimeType blank is a Chromium one.
  return `${base}.${hit ? hit[1] : 'webm'}`
}
