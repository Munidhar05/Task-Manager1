import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { InviteForm } from './UserManagement'

// The sidebar's "Invite people" entry, so bringing someone in is one click from
// anywhere instead of Administration -> User Management -> Invite teammate.
//
// It renders the SAME InviteForm the admin screen uses rather than a second
// dialog — including the copy-link fallback for when SMTP isn't configured.
// Departments are fetched here because the admin screen normally supplies them
// and nothing else on this path has loaded them.
export default function QuickInvite({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  const [depts, setDepts] = useState<any[]>([])
  useEffect(() => { api.get('/users/meta/departments').then(setDepts).catch(() => setDepts([])) }, [])
  return <InviteForm depts={depts} isAdmin={user?.role === 'admin'} onClose={onClose} onDone={() => {}} />
}
