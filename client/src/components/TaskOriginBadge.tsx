import React from 'react'
import { Task, TaskOrigin } from '../api'

// How a task reached the person holding it. Until now none of the list views said
// this at all — a task you were given, one moved off a colleague, and one part of
// a split job all looked identical, which is exactly why split parts felt like
// they had appeared from nowhere.
const LABEL: Record<Exclude<TaskOrigin, 'self'>, string> = {
  assigned: 'Assigned',
  reassigned: 'Reassigned',
  split: 'Shared part',
}

// Who handed it over, in the tense that matches how it happened. Reads off the
// hydrated objects when present and the flat SQL columns otherwise, since the
// dashboard endpoints return raw rows.
export function handoverName(t: Task): string | null {
  if (t.origin === 'reassigned') return t.reassignedBy?.name || t.reassigned_by_name || null
  return t.assignedBy?.name || t.assigned_by_name || null
}

export function TaskOriginBadge({ task, className = '' }: { task: Task; className?: string }) {
  const origin = task.origin
  // 'self' is the common case — you made it for yourself. Badging that would put
  // a chip on nearly every card and drown out the ones that carry information.
  if (!origin || origin === 'self') return null
  return (
    <span className={`origin-badge origin-${origin} ${className}`.trim()} title={originTitle(task)}>
      {LABEL[origin]}
    </span>
  )
}

function originTitle(t: Task): string {
  const who = handoverName(t)
  if (t.origin === 'split') {
    const parent = t.parent?.title || t.parent_title
    return parent ? `Part of "${parent}"${who ? `, shared by ${who}` : ''}` : 'A shared part of a larger task'
  }
  if (t.origin === 'reassigned') {
    const from = t.previousAssignee?.name
    return `Reassigned${who ? ` by ${who}` : ''}${from ? `, previously ${from}'s` : ''}`
  }
  return who ? `Assigned by ${who}` : 'Assigned to you'
}

// One-line provenance under a task title: who gave it to you, and for a split
// part, which task it came out of.
export function TaskHandoverLine({ task }: { task: Task }) {
  const origin = task.origin
  if (!origin || origin === 'self') return null
  const who = handoverName(task)
  const parent = task.parent?.title || task.parent_title
  return (
    <span className="task-handover">
      <TaskOriginBadge task={task} />
      {who && <span className="muted">by {who}</span>}
      {origin === 'split' && parent && <span className="muted">· part of “{parent}”</span>}
    </span>
  )
}

export default TaskOriginBadge
