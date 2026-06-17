import React, { useState } from 'react'
import { Task } from '../api'
import { PriorityBadge, Avatar, ConfidenceTag, dueLabel, STATUS_COLORS } from '../ui'

// Columns mirror the task lifecycle (same order as the status sort rank).
const COLUMNS = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

// A drag-and-drop Kanban board. Cards are grouped into one column per status;
// dropping a card on another column moves it via onMove (which calls the status API).
export default function TaskBoard({ tasks, onOpen, onMove }: {
  tasks: Task[]
  onOpen: (id: string) => void
  onMove: (id: string, status: string) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)

  const drop = (status: string) => {
    const id = dragId
    setDragId(null); setOverCol(null)
    if (!id) return
    const t = tasks.find((x) => x.id === id)
    if (t && t.status !== status) onMove(id, status)
  }

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.status === col)
        return (
          <div
            key={col}
            className={'board-col' + (overCol === col ? ' drop-over' : '')}
            onDragOver={(e) => { e.preventDefault(); if (overCol !== col) setOverCol(col) }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol((c) => (c === col ? null : c)) }}
            onDrop={() => drop(col)}
          >
            <div className="board-col-head">
              <span className="board-col-dot" style={{ background: STATUS_COLORS[col] || '#64748b' }} />
              <span className="board-col-title">{col}</span>
              <span className="board-col-count">{items.length}</span>
            </div>
            <div className="board-col-body">
              {items.map((t) => (
                <div
                  key={t.id}
                  className={'board-card' + (dragId === t.id ? ' dragging' : '')}
                  draggable
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null) }}
                  onClick={() => onOpen(t.id)}
                >
                  <div className="board-card-title">{t.title}</div>
                  <ConfidenceTag c={t.ownership_confidence} />
                  <div className="board-card-foot">
                    <PriorityBadge p={t.priority} />
                    <span className="board-card-due">{dueLabel(t)}</span>
                  </div>
                  {t.assignee && (
                    <div className="board-card-assignee">
                      <Avatar name={t.assignee.name} color={t.assignee.avatar_color} size={20} />
                      <span>{t.assignee.name}</span>
                    </div>
                  )}
                </div>
              ))}
              {items.length === 0 && <div className="board-col-empty">Drop tasks here</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
