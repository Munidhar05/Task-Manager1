import React from 'react'
import { useAuth } from '../auth'
import { useCategories, addCategory } from '../lib/categories'
import PickerWithAdd from './PickerWithAdd'

// The category picker for the task form and the task drawer. The list is the
// shared one in lib/categories.ts, so a brand added while creating a task is
// already offered in the drawer, and a manager can add one from either place.
export default function CategorySelect({ value, onChange, blankLabel, compact }: {
  value: string
  onChange: (name: string) => void
  blankLabel: string          // "Auto-detect" on a new task, "Uncategorized" on an existing one
  compact?: boolean
}) {
  const { user } = useAuth()
  const cats = useCategories()
  const canAdd = user?.role === 'manager' || user?.role === 'admin'
  return (
    <PickerWithAdd
      value={value} onChange={onChange}
      options={cats.map((c) => ({ id: c.id, name: c.name }))}
      blankLabel={blankLabel} addLabel="Add another category…" noun="category"
      canAdd={canAdd} onAdd={addCategory} compact={compact} ariaLabel="Category"
    />
  )
}
