import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { id, now } from './util.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'smarttask.db')

// Ensure the data directory exists.
import fs from 'node:fs'
fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

export function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    department_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','employee')),
    phone TEXT DEFAULT '',
    -- comma-separated aliases the AI can match against spoken names (e.g. "Munidhar,Muni")
    aliases TEXT DEFAULT '',
    preferred_language TEXT DEFAULT 'en',
    avatar_color TEXT DEFAULT '#6366f1',
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id),
    FOREIGN KEY (department_id) REFERENCES departments(id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    department_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    uploaded_by TEXT,
    source_type TEXT DEFAULT 'transcript',     -- transcript | audio
    audio_filename TEXT,
    raw_transcript TEXT,                        -- original, language preserved
    detected_languages TEXT DEFAULT '[]',       -- JSON array
    status TEXT DEFAULT 'uploaded',             -- uploaded | processing | processed | failed
    summary_json TEXT,                          -- JSON: executive summary, decisions, risks...
    engine TEXT,                                -- claude | rule-based
    created_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id)
  );

  CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    speaker TEXT,
    text TEXT NOT NULL,
    language TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    assignee_id TEXT,
    assignee_name_raw TEXT,                     -- name as spoken, before matching
    assigned_by_id TEXT,
    assigned_by_name_raw TEXT,
    due_date TEXT,
    due_date_raw TEXT,                          -- the original natural-language phrase
    priority TEXT DEFAULT 'Medium' CHECK (priority IN ('Critical','High','Medium','Low')),
    status TEXT DEFAULT 'To Do',                -- To Do | In Progress | Blocked | In Review | Done | Reopened
    project_id TEXT,
    department_id TEXT,
    meeting_id TEXT,                            -- origin meeting, if any
    ownership_confidence TEXT DEFAULT 'high',   -- high | low | needs_confirmation
    parent_task_id TEXT,                        -- for subtasks
    progress INTEGER DEFAULT 0,                 -- 0-100
    approval_status TEXT DEFAULT 'none',        -- none | pending | approved | rejected
    source_quote TEXT,                          -- exact transcript line that created it
    assigned_at TEXT,                           -- when an owner was set
    submitted_at TEXT,                          -- when the assignee submitted for review
    completed_at TEXT,                          -- when it was marked Done/approved
    visible_to_manager INTEGER DEFAULT 1,       -- 0 = private employee draft, hidden until submitted
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id),
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,                       -- recipient
    type TEXT NOT NULL,                          -- task_submitted | task_approved | task_reopened | task_assigned
    message TEXT NOT NULL,
    task_id TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Internal team chat messages. Each belongs to a conversation (direct or group).
  -- recipient_id is legacy (used only by old 1:1 rows) — nullable, no FK — because
  -- group messages have many recipients, tracked via chat_participants instead.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    conversation_id TEXT,
    sender_id TEXT NOT NULL,
    recipient_id TEXT,
    body TEXT,
    file_name TEXT,
    file_stored TEXT,
    file_type TEXT,
    file_size INTEGER,
    deleted_for_all INTEGER DEFAULT 0,
    reply_to TEXT,
    edited_at TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, recipient_id, created_at);

  -- "Delete for me": rows here hide a message from a single user's view only.
  -- (A message deleted for everyone is flagged on chat_messages.deleted_for_all.)
  CREATE TABLE IF NOT EXISTS chat_message_hidden (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Conversations: a 1:1 (direct) or multi-person (group) chat. Messages belong
  -- to a conversation; membership + per-user read position live in participants.
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'direct',     -- direct | group
    name TEXT,                                -- group name (null for direct)
    avatar_color TEXT DEFAULT '#6366f1',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_participants (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',      -- admin | member
    last_read_at TEXT,                         -- drives unread counts + read receipts
    joined_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_part_user ON chat_participants(user_id);

  -- Emoji reactions (one row per user+emoji on a message).
  CREATE TABLE IF NOT EXISTS chat_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );

  -- Starred / bookmarked messages (per user).
  CREATE TABLE IF NOT EXISTS chat_stars (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  );

  -- AI Assistant chat history. One row per conversation thread; messages is a
  -- JSON array of {role, text, tasks?}. Scoped to the owning user so threads
  -- follow the manager across devices/browsers.
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New chat',
    messages TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_convo_user ON conversations(user_id, updated_at);

  -- Meeting attendees. Only these users can be suggested as task owners.
  CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (meeting_id, user_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- AI Review Queue: tasks the AI proposes from a meeting, held for manager
  -- review BEFORE they become real (assigned) tasks. Kept separate from the
  -- tasks table so pending suggestions never leak into dashboards or task lists.
  CREATE TABLE IF NOT EXISTS suggested_tasks (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    suggested_assignee_id TEXT,                 -- resolved among attendees, may be null
    suggested_assignee_raw TEXT,                -- spoken name before matching
    assignee_reasoning TEXT,                    -- why the AI chose this person
    confidence INTEGER DEFAULT 50,              -- 0-100 confidence score
    priority TEXT DEFAULT 'Medium',
    due_date TEXT,
    due_date_raw TEXT,
    source_quote TEXT,                          -- exact transcript line
    status TEXT DEFAULT 'pending',              -- pending | approved | rejected | merged
    merged_into TEXT,                           -- suggestion id this was merged into
    created_task_id TEXT,                       -- the real task created on approval
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (suggested_assignee_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_suggested_meeting ON suggested_tasks(meeting_id, status);
  `)

  // Lightweight migrations: add columns to existing DBs that predate them.
  ensureColumn('tasks', 'assigned_at', 'TEXT')
  ensureColumn('tasks', 'submitted_at', 'TEXT')
  ensureColumn('tasks', 'completed_at', 'TEXT')
  ensureColumn('tasks', 'visible_to_manager', 'INTEGER DEFAULT 1')
  ensureColumn('users', 'phone', "TEXT DEFAULT ''")
  ensureColumn('meetings', 'description', "TEXT DEFAULT ''")

  // Chat file attachments + "delete for everyone" flag.
  ensureColumn('chat_messages', 'file_name', 'TEXT')      // original filename shown to users
  ensureColumn('chat_messages', 'file_stored', 'TEXT')    // generated name on disk (data/chat_uploads)
  ensureColumn('chat_messages', 'file_type', 'TEXT')      // mime type
  ensureColumn('chat_messages', 'file_size', 'INTEGER')   // bytes
  ensureColumn('chat_messages', 'deleted_for_all', 'INTEGER DEFAULT 0')
  ensureColumn('chat_messages', 'conversation_id', 'TEXT') // owning conversation
  ensureColumn('chat_messages', 'reply_to', 'TEXT')        // message id being replied to
  ensureColumn('chat_messages', 'edited_at', 'TEXT')       // set when the body is edited

  // Index on conversation_id — created here (not in the inline schema) so it runs
  // AFTER the column is ensured above; otherwise older DBs predating the column fail.
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_convo ON chat_messages(conversation_id, created_at);')

  // Rebuild chat_messages on older DBs where recipient_id was NOT NULL with a FK
  // (which blocks group messages). Recreates it nullable / FK-free, preserving rows.
  runOnce('chat_messages_rebuild_v2', () => {
    const cols = db.prepare('PRAGMA table_info(chat_messages)').all()
    const recip = cols.find((c) => c.name === 'recipient_id')
    if (!recip || recip.notnull === 0) return // already nullable — nothing to do
    db.pragma('foreign_keys = OFF')
    const rebuild = db.transaction(() => {
      db.exec(`CREATE TABLE chat_messages_new (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, conversation_id TEXT, sender_id TEXT NOT NULL,
        recipient_id TEXT, body TEXT, file_name TEXT, file_stored TEXT, file_type TEXT, file_size INTEGER,
        deleted_for_all INTEGER DEFAULT 0, reply_to TEXT, edited_at TEXT, read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE );`)
      db.exec(`INSERT INTO chat_messages_new (id,org_id,conversation_id,sender_id,recipient_id,body,file_name,file_stored,file_type,file_size,deleted_for_all,reply_to,edited_at,read,created_at)
        SELECT id,org_id,conversation_id,sender_id,recipient_id,body,file_name,file_stored,file_type,file_size,deleted_for_all,reply_to,edited_at,read,created_at FROM chat_messages;`)
      db.exec('DROP TABLE chat_messages;')
      db.exec('ALTER TABLE chat_messages_new RENAME TO chat_messages;')
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_convo ON chat_messages(conversation_id, created_at);')
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, recipient_id, created_at);')
    })
    rebuild()
    db.pragma('foreign_keys = ON')
    console.log('[migrate] rebuilt chat_messages (recipient_id now nullable for group support)')
  })

  // Backfill: turn legacy 1:1 messages (sender_id/recipient_id) into conversations.
  runOnce('chat_conversations_v1', () => {
    const legacy = db.prepare("SELECT id, sender_id, recipient_id, created_at FROM chat_messages WHERE conversation_id IS NULL AND recipient_id IS NOT NULL AND recipient_id != ''").all()
    const pairKey = (a, b) => [a, b].sort().join('|')
    const convoForPair = new Map()
    for (const m of legacy) {
      const key = pairKey(m.sender_id, m.recipient_id)
      let cid = convoForPair.get(key)
      if (!cid) {
        const u = db.prepare('SELECT org_id FROM users WHERE id=?').get(m.sender_id)
        if (!u) continue
        cid = id('cv')
        db.prepare('INSERT INTO chat_conversations (id, org_id, type, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(cid, u.org_id, 'direct', m.sender_id, m.created_at || now(), now())
        for (const uid of [m.sender_id, m.recipient_id]) {
          db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)')
            .run(cid, uid, 'member', now(), now())
        }
        convoForPair.set(key, cid)
      }
      db.prepare('UPDATE chat_messages SET conversation_id=? WHERE id=?').run(cid, m.id)
    }
    if (convoForPair.size) console.log(`[migrate] created ${convoForPair.size} direct conversation(s) from legacy chat messages`)
  })

  // One-time: the Manager is now the org admin. Remove any legacy standalone
  // admin account so it no longer exists in already-seeded databases.
  runOnce('remove_standalone_admin_v1', () => {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all()
    for (const a of admins) {
      // Detach references so the delete can't trip a foreign-key constraint.
      db.prepare('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?').run(a.id)
      db.prepare('DELETE FROM task_comments WHERE user_id=?').run(a.id)
      db.prepare('DELETE FROM users WHERE id=?').run(a.id)
    }
    if (admins.length) console.log(`[migrate] removed ${admins.length} legacy admin account(s) — the manager is now the admin`)
  })

  // One-time: switch the department set to IT / Marketing / Sales / Management.
  // Rename the legacy departments in place (keeps user assignments intact) and
  // ensure all four exist.
  runOnce('departments_it_mkt_sales_mgmt_v1', () => {
    for (const [oldName, newName] of [['Engineering', 'IT'], ['QA', 'Marketing'], ['DevOps', 'Sales']]) {
      db.prepare('UPDATE departments SET name=? WHERE name=?').run(newName, oldName)
    }
    for (const org of db.prepare('SELECT id FROM organizations').all()) {
      for (const name of ['IT', 'Marketing', 'Sales', 'Management']) {
        const exists = db.prepare('SELECT id FROM departments WHERE org_id=? AND name=?').get(org.id, name)
        if (!exists) db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(id('dep'), org.id, name)
      }
    }
  })
}

// Run a migration body exactly once, tracked by a key in app_meta.
function runOnce(key, fn) {
  const seen = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)
  if (seen) return
  fn()
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, '1')
}

// Add a column only if it doesn't already exist (SQLite has no IF NOT EXISTS for columns).
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
  }
}

export default db
