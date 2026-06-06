// Daily task digest. Primary channel: a Zoho Cliq team summary (one message per org).
// Also sends per-person email when SMTP is configured. Both fall back to console preview.
import { db } from './db.js'
import { sendMail, mailerMode } from './mailer.js'
import { postToCliq, cliqEnabled } from './cliq.js'

const today = () => new Date().toISOString().slice(0, 10)
const OPEN = "('To Do','In Progress','Blocked','In Review','Reopened')"

function fmtTask(t) {
  const due = t.due_date ? ` (due ${t.due_date}${t.due_date < today() ? ' ⚠️ overdue' : ''})` : ''
  return `   • [${t.priority}] ${t.title} — ${t.status}${due}`
}

// One Cliq channel message summarising every member's open tasks (team standup).
export function buildTeamSummary(orgId) {
  const members = db.prepare("SELECT id, name FROM users WHERE org_id=? AND role IN ('employee','manager') ORDER BY name").all(orgId)
  const lines = [`📋 Daily Tasks — ${today()}`, '']
  let totalOpen = 0, totalOverdue = 0
  for (const u of members) {
    const tasks = db.prepare(
      `SELECT * FROM tasks WHERE assignee_id=? AND parent_task_id IS NULL AND status IN ${OPEN} AND visible_to_manager=1 ORDER BY due_date IS NULL, due_date`
    ).all(u.id)
    if (!tasks.length) continue
    const overdue = tasks.filter((t) => t.due_date && t.due_date < today()).length
    totalOpen += tasks.length; totalOverdue += overdue
    lines.push(`${u.name} — ${tasks.length} open${overdue ? ` (${overdue} overdue)` : ''}`)
    tasks.slice(0, 8).forEach((t) => lines.push(fmtTask(t)))
    if (tasks.length > 8) lines.push(`   …and ${tasks.length - 8} more`)
    lines.push('')
  }
  if (totalOpen === 0) lines.push('No open tasks today. 🎉')
  else lines.push(`Team total: ${totalOpen} open${totalOverdue ? `, ${totalOverdue} overdue` : ''}.`)
  return lines.join('\n')
}

// Per-person email body (used only when SMTP is configured).
export function buildDigest(user) {
  const mine = db.prepare(
    `SELECT * FROM tasks WHERE assignee_id=? AND parent_task_id IS NULL AND status IN ${OPEN} ORDER BY due_date IS NULL, due_date`
  ).all(user.id)
  if (user.role === 'employee' && mine.length === 0) return null
  const lines = [`Good morning ${user.name},`, '']
  lines.push(mine.length ? `You have ${mine.length} open task(s):` : 'You have no open tasks today. 🎉')
  mine.forEach((t) => lines.push(fmtTask(t)))
  lines.push('', '— Befach Task Manager')
  return { subject: `Your tasks for ${today()} — ${mine.length} open`, text: lines.join('\n') }
}

// Run the digest: post a Cliq summary per org, plus emails if SMTP is set.
export async function sendDailyDigests() {
  const orgs = db.prepare('SELECT DISTINCT org_id FROM users').all().map((r) => r.org_id)
  let cliqMode = 'off', cliqMessages = 0
  for (const org of orgs) {
    const r = await postToCliq(buildTeamSummary(org))
    cliqMode = r.mode; cliqMessages++
  }

  let emails = 0
  if (mailerMode() === 'smtp') {
    const users = db.prepare("SELECT * FROM users WHERE email IS NOT NULL AND email != ''").all()
    for (const u of users) {
      const d = buildDigest(u)
      if (d) { await sendMail({ to: u.email, subject: d.subject, text: d.text }); emails++ }
    }
  }

  const summary = { cliq: cliqEnabled() ? cliqMode : 'preview', cliqMessages, emails, emailMode: mailerMode() }
  console.log(`[digest] ${today()} → cliq:${summary.cliq} (${cliqMessages} msg), emails:${emails}`)
  return summary
}
