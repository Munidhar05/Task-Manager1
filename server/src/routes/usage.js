import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { usageForOrg } from '../ai/usage.js'

// An org admin's view of THEIR OWN organization's AI/API usage. Gated behind the
// usage_access flag, which only a platform (super) admin can grant. Platform
// admins can always see it. Never crosses org boundaries.
const r = Router()
r.use(authRequired, requireRole('admin'))

r.get('/', (req, res) => {
  const org = db.prepare('SELECT id, name, usage_access FROM organizations WHERE id=?').get(req.user.org_id)
  const allowed = !!req.user.platform_admin || !!(org && org.usage_access)
  if (!allowed) return res.status(403).json({ error: 'Usage tracking is not enabled for your organization.', code: 'USAGE_DISABLED' })
  res.json({ org_name: org?.name || '', ...usageForOrg(req.user.org_id) })
})

export default r
