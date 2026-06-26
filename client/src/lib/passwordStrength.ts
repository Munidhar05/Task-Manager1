// Lightweight password strength scoring (no dependency). Returns a 0–4 score, a
// label, and the most common weak passwords are flagged as "Too common".

const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyui', 'qwerty123', '11111111', '00000000', 'abc12345', 'iloveyou',
  'admin123', 'welcome1', 'welcome123', 'letmein1', 'letmein123', 'football', 'monkey12',
  'sunshine', 'princess', 'dragon123', 'master123', 'login123', 'changeme', 'secret12',
])

export function isCommonPassword(pw: string): boolean {
  return COMMON.has((pw || '').toLowerCase())
}

export interface Strength { score: number; label: string; ok: boolean }

// Scoring: length + character-class variety. Common passwords are forced to 0.
export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: '', ok: false }
  if (isCommonPassword(pw)) return { score: 0, label: 'Too common', ok: false }
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  score = Math.min(4, score)
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong']
  // "ok" = acceptable to submit: at least 8 chars and not weak/common (Fair or better).
  return { score, label: labels[score], ok: pw.length >= 8 && score >= 2 }
}
