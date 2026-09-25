// ─────────────────────────────────────────────────────────
// Auth middleware — JWT verification and role-based access
//
// ROLE HIERARCHY (highest to lowest):
//   super_admin  — developer/admin account (you). Full access.
//   president    — full access + deletion rights
//   secretary    — full access + deletion rights
//   treasurer    — full access + deletion rights
//   manager      — add/edit only. Zero deletion rights.
//   committee    — view + enter notices/complaints only
//   resident     — own data only
//
// PERMISSION GROUPS (used by requirePermission()):
//   CAN_DELETE   — super_admin, president, secretary, treasurer
//   CAN_WRITE    — above + manager (add/edit but not delete)
//   CAN_MANAGE   — above + committee (broader management access)
//   STAFF_ONLY   — all non-resident roles
// ─────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

// Roles that can delete records
const DELETION_ROLES = ['super_admin', 'president', 'secretary', 'treasurer'];

// Roles that can add and edit (but not necessarily delete)
const WRITE_ROLES    = [...DELETION_ROLES, 'manager'];

// Roles that can access management views (finances, members, bills etc.)
const MANAGE_ROLES   = [...WRITE_ROLES, 'committee'];

// All non-resident roles
const STAFF_ROLES    = [...MANAGE_ROLES]; // same set currently

function requireLogin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not logged in. No token provided.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// Require one of a specific list of roles (exact match)
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this.' });
    }
    next();
  };
}

// Require membership in a named permission group
function requirePermission(group) {
  const groupMap = {
    'delete':  DELETION_ROLES,
    'write':   WRITE_ROLES,
    'manage':  MANAGE_ROLES,
    'staff':   STAFF_ROLES,
  };
  const allowed = groupMap[group];
  if (!allowed) throw new Error(`Unknown permission group: ${group}`);

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

// Convenience helpers
const canDelete  = requirePermission('delete');
const canWrite   = requirePermission('write');
const canManage  = requirePermission('manage');
const staffOnly  = requirePermission('staff');

module.exports = {
  requireLogin,
  requireRole,
  requirePermission,
  canDelete,
  canWrite,
  canManage,
  staffOnly,
  DELETION_ROLES,
  WRITE_ROLES,
  MANAGE_ROLES,
};
