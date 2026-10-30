// ─────────────────────────────────────────────────────────
// House ownership transfers
// A house keeps one record per owner. When a house is sold, the old owner's
// record stays (marked inactive) together with every payment made under it,
// and the new owner gets a fresh record on the same house number. Maintenance
// history is therefore never rewritten; the house timeline shows both owners
// in order with the transfer between them.
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, canDelete, canManage } = require('../middleware/auth');
const { houseKeySql } = require('./ledger');

const router = express.Router();

async function ensureSchema() {
  // A house number may now repeat across owners, but only one owner can be active.
  await pool.query(`
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT con.conname FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
        WHERE con.conrelid = 'members'::regclass AND con.contype = 'u'
          AND array_length(con.conkey, 1) = 1 AND a.attname = 'house_number'
      LOOP
        EXECUTE format('ALTER TABLE members DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_members_active_house
      ON members (house_number) WHERE is_active
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS house_transfers (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      house_number   VARCHAR(50) NOT NULL,
      from_member_id UUID NOT NULL REFERENCES members(id),
      to_member_id   UUID NOT NULL REFERENCES members(id),
      note           TEXT,
      transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_by    UUID
    )
  `);
}
const schemaReady = ensureSchema().catch(err =>
  console.error('transfers: schema setup error (run add_ownership_transfer.sql manually):', err.message));

// POST /api/transfers — { fromMemberId, newOwner: { fullName, phonePrimary, phoneSecondary?, email? }, note? }
router.post('/', requireLogin, canDelete, async (req, res) => {
  const { fromMemberId, newOwner = {}, note } = req.body || {};
  if (!fromMemberId || !String(newOwner.fullName || '').trim() || !String(newOwner.phonePrimary || '').trim()) {
    return res.status(400).json({ error: 'Choose the current owner and enter the new owner\'s name and phone.' });
  }
  await schemaReady;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [fromMemberId])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Owner not found.' }); }
    if (!old.is_active) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This owner is already inactive. Transfer from the current owner.' }); }

    // Payments of this house that were never linked belong to the old owner.
    await client.query(
      `UPDATE payment_ledger SET member_id = $1
       WHERE member_id IS NULL AND ${houseKeySql('house_number')} = ${houseKeySql('$2::text')}`,
      [old.id, old.house_number]);

    await client.query(`UPDATE members SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [old.id]);
    await client.query(`UPDATE users SET is_active = FALSE WHERE member_id = $1`, [old.id]);   // old owner's login

    const created = await client.query(
      `INSERT INTO members (full_name, house_number, unit_type, phone_primary, phone_secondary, email, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [String(newOwner.fullName).trim(), old.house_number, old.unit_type,
       String(newOwner.phonePrimary).trim(), newOwner.phoneSecondary || null, newOwner.email || null, req.user.userId]);
    const newId = created.rows[0].id;

    await client.query(
      `INSERT INTO house_transfers (house_number, from_member_id, to_member_id, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [old.house_number, old.id, newId, note ? String(note).slice(0, 300) : null, req.user.userId]);
    await client.query('COMMIT');
    return res.status(201).json({ message: 'Ownership transferred.', newMemberId: newId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /transfers error:', err);
    return res.status(500).json({ error: `Could not transfer ownership: ${err.message}` });
  } finally {
    client.release();
  }
});

// GET /api/transfers/member/:id — the house timeline: owners in order, each with
// their payments, and the transfers between them.
router.get('/member/:id', requireLogin, canManage, async (req, res) => {
  try {
    await schemaReady;
    const me = (await pool.query(`SELECT id, house_number FROM members WHERE id = $1`, [req.params.id])).rows[0];
    if (!me) return res.status(404).json({ error: 'Member not found.' });

    const owners = (await pool.query(
      `SELECT m.id, m.full_name, m.is_active, m.created_at,
              t.transferred_at AS acquired_at, t.note AS acquired_note,
              (SELECT t2.transferred_at FROM house_transfers t2 WHERE t2.from_member_id = m.id) AS handed_over_at
       FROM members m
       LEFT JOIN house_transfers t ON t.to_member_id = m.id
       WHERE ${houseKeySql('m.house_number')} = ${houseKeySql('$1::text')}
       ORDER BY COALESCE(t.transferred_at, '-infinity'::timestamptz), m.created_at`,
      [me.house_number])).rows;

    const ids = owners.map(o => o.id);
    const pays = (await pool.query(
      `SELECT id, member_id, payment_date, amount, payment_mode, receipt_number, description,
              payer_name, start_quarter, quarters_covered
       FROM payment_ledger WHERE member_id = ANY($1::uuid[])
       ORDER BY payment_date, created_at`, [ids])).rows;

    return res.json({
      houseNumber: me.house_number,
      owners: owners.map(o => ({
        id: o.id, name: o.full_name, isActive: o.is_active,
        acquiredAt: o.acquired_at, handedOverAt: o.handed_over_at, note: o.acquired_note,
        payments: pays.filter(p => p.member_id === o.id),
        total: pays.filter(p => p.member_id === o.id).reduce((s, p) => s + Number(p.amount), 0),
      })),
    });
  } catch (err) {
    console.error('GET /transfers/member error:', err);
    return res.status(500).json({ error: 'Could not load the house history.' });
  }
});

module.exports = router;
