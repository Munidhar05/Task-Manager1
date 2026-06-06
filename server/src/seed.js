import { db } from './db.js'
import { id, now } from './util.js'
import { hashPassword } from './auth.js'
import { analyzeTranscript } from './ai/rules.js'
import { persistMeeting } from './routes/meetings.js'

const DEMO_PASSWORD = 'password123'

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const MEETING_1 = `Priya: Good morning team. Let's start the standup.
Priya: Munidhar, complete the login API by Friday. It's high priority.
Munidhar: Sure Priya, I'll finish it by Friday.
Priya: Ravi, deployment documentation ready cheyyandi by tomorrow.
Ravi: Theek hai, kal tak ready kar dunga.
Priya: Anjali, payment gateway ka testing aaj complete karo, it's urgent.
Anjali: Okay, aaj hi complete karungi.
Priya: We decided to go with Razorpay for the payments integration.
Karthik: There is a blocker - staging server down hai, deployment nahi ho pa raha.
Priya: Karthik, staging server fix cheyyi ASAP, this is becoming a production issue.
Priya: Let's follow up on the mobile release next Monday.`

const MEETING_2 = `Priya: Sprint planning meeting start chestunnam.
Priya: Munidhar, dashboard UI design karo by next Monday.
Priya: Ravi, API integration cheyyi before deployment.
Anjali: Mujhe ek doubt hai - reports module kaun handle karega?
Priya: Reports module ... we will decide later, abhi unassigned rakhte hain.
Priya: Karthik, performance testing end of week tak complete cheyyandi, medium priority.
Priya: There is a risk that the client demo might get delayed.`

export function ensureSeed() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c
  if (count > 0) return

  console.log('[seed] empty database — creating demo organization...')
  const orgId = id('org')
  db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)').run(orgId, 'Befach Technologies', now())

  const deptIT = id('dep'), deptMkt = id('dep'), deptSales = id('dep'), deptMgmt = id('dep')
  db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(deptIT, orgId, 'IT')
  db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(deptMkt, orgId, 'Marketing')
  db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(deptSales, orgId, 'Sales')
  db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(deptMgmt, orgId, 'Management')

  // The Manager is the org admin — there is no separate admin account.
  const users = [
    { name: 'Priya Sharma', email: 'priya@demo.io', role: 'manager', dept: deptMgmt, aliases: 'Priya', color: '#6366f1' },
    { name: 'Munidhar Reddy', email: 'munidhar@demo.io', role: 'employee', dept: deptIT, aliases: 'Munidhar,Muni', color: '#ec4899', lang: 'te' },
    { name: 'Ravi Kumar', email: 'ravi@demo.io', role: 'employee', dept: deptSales, aliases: 'Ravi', color: '#14b8a6', lang: 'hi' },
    { name: 'Anjali Verma', email: 'anjali@demo.io', role: 'employee', dept: deptMkt, aliases: 'Anjali', color: '#f59e0b', lang: 'hi' },
    { name: 'Karthik Rao', email: 'karthik@demo.io', role: 'employee', dept: deptIT, aliases: 'Karthik', color: '#8b5cf6', lang: 'te' },
  ]
  const pwHash = hashPassword(DEMO_PASSWORD)
  for (const u of users) {
    db.prepare(`INSERT INTO users (id, org_id, department_id, name, email, password_hash, role, aliases, preferred_language, avatar_color, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id('usr'), orgId, u.dept, u.name, u.email, pwHash, u.role, u.aliases, u.lang || 'en', u.color, now())
  }

  const projPortal = id('prj'), projMobile = id('prj')
  db.prepare('INSERT INTO projects (id, org_id, name, department_id, created_at) VALUES (?,?,?,?,?)').run(projPortal, orgId, 'Customer Portal', deptIT, now())
  db.prepare('INSERT INTO projects (id, org_id, name, department_id, created_at) VALUES (?,?,?,?,?)').run(projMobile, orgId, 'Mobile App', deptIT, now())

  const manager = db.prepare("SELECT * FROM users WHERE email='priya@demo.io'").get()
  const allUsers = db.prepare('SELECT id, name FROM users WHERE org_id=?').all(orgId)
  const knownNames = allUsers.map((u) => u.name)
  const participantIds = allUsers.map((u) => u.id) // everyone attends the demo meetings

  // Process the two demo meetings through the offline engine. autoApprove turns the
  // AI suggestions straight into assigned tasks so the demo dashboards stay populated.
  const seedMeeting = (title, transcript, dateISO) => {
    const analysis = analyzeTranscript(transcript, { meetingDate: dateISO, knownNames })
    persistMeeting({ orgId, userId: manager.id, title, meetingDate: dateISO, transcript, sourceType: 'transcript', participantIds }, analysis, { autoApprove: true })
  }
  seedMeeting('Daily Standup — Engineering', MEETING_1, daysAgo(1))
  seedMeeting('Sprint Planning — Q3', MEETING_2, daysAgo(2))

  // Tag a few tasks onto projects + vary statuses so dashboards look alive.
  const tasks = db.prepare('SELECT * FROM tasks WHERE org_id=? ORDER BY created_at').all(orgId)
  if (tasks[0]) db.prepare("UPDATE tasks SET project_id=?, status='In Progress', progress=40 WHERE id=?").run(projPortal, tasks[0].id)
  if (tasks[1]) db.prepare("UPDATE tasks SET project_id=?, status='In Review', progress=90, approval_status='pending' WHERE id=?").run(projPortal, tasks[1].id)
  if (tasks[2]) db.prepare("UPDATE tasks SET project_id=?, status='Blocked' WHERE id=?").run(projPortal, tasks[2].id)
  if (tasks[3]) db.prepare("UPDATE tasks SET project_id=?, status='Done', progress=100 WHERE id=?").run(projMobile, tasks[3].id)

  console.log(`[seed] done. ${knownNames.length} users, ${tasks.length} tasks across 2 meetings.`)
  console.log('[seed] login with: priya@demo.io (manager/admin) / munidhar@demo.io (employee)  (password: password123)')
}
