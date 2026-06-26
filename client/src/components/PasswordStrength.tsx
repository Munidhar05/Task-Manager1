import React from 'react'
import { passwordStrength } from '../lib/passwordStrength'

// A 4-segment strength bar + label, shown under a password field as you type.
const COLORS = ['#ef4444', '#ef4444', '#f59e0b', '#3b82f6', '#10b981']

export default function PasswordStrength({ password }: { password: string }) {
  if (!password) return null
  const { score, label } = passwordStrength(password)
  const color = COLORS[score]
  return (
    <div className="pw-strength" aria-live="polite">
      <div className="pw-strength-bar">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="pw-seg" style={{ background: i < score ? color : 'var(--border)' }} />
        ))}
      </div>
      <span className="pw-strength-label" style={{ color }}>{label}</span>
    </div>
  )
}
