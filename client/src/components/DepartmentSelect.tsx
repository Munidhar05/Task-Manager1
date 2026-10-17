import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import PickerWithAdd from './PickerWithAdd'

export interface Dept { id: string; name: string }

// The department picker, for every form that asks for one (the user form and
// the invite dialog). The parent owns the list — it usually drives a table with
// it too — so a new department is handed up through onAdded. A parent that
// keeps no list of its own (QuickInvite) can leave onAdded out: the picker then
// remembers what it added itself, so the new department is still there to pick.
const byName = (a: Dept, b: Dept) => a.name.localeCompare(b.name)

export default function DepartmentSelect({ value, onChange, depts, onAdded }: {
  value: string
  onChange: (id: string) => void
  depts: Dept[]
  onAdded?: (d: Dept) => void
}) {
  const { user } = useAuth()
  const [own, setOwn] = useState<Dept[]>([])
  const canAdd = user?.role === 'manager' || user?.role === 'admin'
  const list = [...depts, ...own.filter((d) => !depts.some((x) => x.id === d.id))].sort(byName)
  const add = async (name: string) => {
    const d: Dept & { existed?: boolean } = await api.post('/users/meta/departments', { name })
    if (onAdded) onAdded(d)
    else setOwn((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]))
    return d
  }
  return (
    <PickerWithAdd
      value={value} onChange={onChange} options={list}
      blankLabel="—" addLabel="Add another department…" noun="department"
      canAdd={canAdd} onAdd={add} ariaLabel="Department"
    />
  )
}
