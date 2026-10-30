// ─────────────────────────────────────────────────────────
// Payment Ledger Route
// A flat log of maintenance payments received — mirrors the
// society's handwritten register during the transition phase.
// No bill generation or due/penalty split.
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, canWrite, canDelete, canManage } = require('../middleware/auth');

const router = express.Router();

const VALID_MODES = ['cash','cheque','online','online_upi','online_neft','online_rtgs','demand_draft'];

// Each payment records how long it covers: start_quarter (1-4, within the financial
// year of the payment date) and quarters_covered (1-4; 4 = complete financial year).
// Older / imported rows have NULL here and are only checked against the yearly total.
// Safe to run on every startup.
async function ensureSchema() {
  await pool.query(`
    ALTER TABLE payment_ledger
      ADD COLUMN IF NOT EXISTS start_quarter    SMALLINT,
      ADD COLUMN IF NOT EXISTS quarters_covered SMALLINT,
      ADD COLUMN IF NOT EXISTS remark           TEXT
  `);
}
const schemaReady = ensureSchema().catch(err =>
  console.error('ledger: schema setup error (run add_payment_duration.sql manually):', err)
);

// Runs once after the schema is ready: links existing payments to residents.
schemaReady.then(() => mapLedgerToMembers()).then(r =>
  console.log(`ledger: linked ${r.linkedByHouse} by house, ${r.linkedByName} by name; ${r.unmapped.length} still unlinked`)
).catch(err => console.error('ledger: resident mapping error:', err.message));

// Maintenance per quarter by unit type (Rs.). Homes 4,000; shops 750.
const QUARTER_FEE_HOME = 4000;
const QUARTER_FEE_SHOP = 750;

// A remark typed or chosen by the recorder: trimmed, max 200 characters.
//   not sent at all  -> NULL  ("never set": older rows; the amount rule below applies)
//   sent but blank   -> ''    (the recorder chose "No remark": stays blank)
function cleanRemark(v) {
  if (v === undefined) return null;
  if (v === null) return '';
  return String(v).trim().slice(0, 200);
}

// Financial quarter of a YYYY-MM-DD date: Apr-Jun=1, Jul-Sep=2, Oct-Dec=3, Jan-Mar=4.
function quarterOfDate(isoDate) {
  const m = parseInt(String(isoDate).slice(5, 7), 10);
  if (m >= 4 && m <= 6)  return 1;
  if (m >= 7 && m <= 9)  return 2;
  if (m >= 10 && m <= 12) return 3;
  return 4;
}

// Validates the duration a recorder chose. Returns {start, count} or {error}.
// If neither value is supplied: 1 quarter, matching the payment date.
function resolveDuration(quartersCovered, startQuarter, paymentDate) {
  const noneGiven = (quartersCovered === undefined || quartersCovered === null || quartersCovered === '')
                 && (startQuarter === undefined || startQuarter === null || startQuarter === '');
  if (noneGiven) return { start: quarterOfDate(paymentDate), count: 1 };
  const count = parseInt(quartersCovered, 10);
  if (!(count >= 1 && count <= 4)) return { error: 'Duration must be between 1 quarter and the complete financial year.' };
  let start = (startQuarter === undefined || startQuarter === null || startQuarter === '')
    ? Math.min(quarterOfDate(paymentDate), 5 - count)
    : parseInt(startQuarter, 10);
  if (count === 4) start = 1;
  if (!(start >= 1 && start <= 4) || start + count - 1 > 4) {
    return { error: 'The chosen quarters must fall within one financial year.' };
  }
  return { start, count };
}

// Canonical house-number key as a SQL expression, mirroring houseKey() in the
// frontend: ignores case, spaces, hyphens/dots and leading zeros, and collapses
// block names to abbreviations (Kingston=K, Regal=R, Row House=RH).
// "Kingston - 05", "K-5" and "k 05" all become K5.
function houseKeySql(col) {
  return `regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '', 'g'),
                  '^KINGSTON', 'K'),
                '^REGAL', 'R'),
              '^ROWHOUSE', 'RH'),
            '([A-Z])0+([0-9])', '\\1\\2', 'g')`;
}


// ─────────────────────────────────────────────────────────
// Mapping payments to residents (payment_ledger.member_id)
// ─────────────────────────────────────────────────────────
// The register writes house numbers its own way (R.H.-15, K-05, A1-26, Shop No.3,
// "RH 15") while the residents list uses block names (Royale - 15, Kingston - 05,
// A1 - 26, Shop No. 3). Both are reduced to {family, number}. Within a family the
// number is unique (row-house numbers never repeat across Antilia / Empress /
// Royale, and A1 = 1-32, A2 = 33-64), so a number identifies one house.
const FAMILIES = [
  ['KINGSTON','K'], ['REGAL','R'], ['ANTILIA','RH'], ['ANTILLIA','RH'], ['EMPRESS','RH'],
  ['ROYALE','RH'], ['ROWHOUSE','RH'], ['SHOPNO','S'], ['SHOP','S'],
  ['RH','RH'], ['K','K'], ['R','R'], ['A1','A'], ['A2','A'], ['A','A'],
];
function famNum(house) {
  const t = String(house || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // Ṛ -> R
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const [prefix, fam] of FAMILIES) {
    if (t.startsWith(prefix)) {
      const m = t.slice(prefix.length).match(/^0*(\d+)$/);
      if (m) return fam + ':' + parseInt(m[1], 10);
    }
  }
  return null;
}

function buildMemberIndex(members) {
  // 'RH:15' -> member, or null if two members share it. After a sale a house has an
  // inactive previous owner and an active new one: the active owner is used.
  const byHouse = new Map();
    const groups = new Map();
  for (const m of members) {
    const k = famNum(m.house_number);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const [k, list] of groups) {
    const active = list.filter(m => m.is_active !== false);
    const use = active.length ? active : list;
    byHouse.set(k, use.length === 1 ? use[0] : null);
  }
  return { members, byHouse };
}

// Strict, spelling-tolerant name comparison (used only for rows with no house number).
const NAME_NOISE = new Set(['mr','mrs','ms','smt','shri','shree','sri','dr','late','lt','ku','kumari',
  's','o','d','w','c','of','and','sh','sd','wd','sio','dio','wio']);
function nameTokens(n) {
  return String(n || '').toLowerCase().replace(/s\/o|d\/o|w\/o|c\/o/g, ' ')
    .split(/[^a-z]+/).filter(w => w.length > 1 && !NAME_NOISE.has(w));
}
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[a.length][b.length];
}
function tokenSim(a, b) { return 1 - lev(a, b) / Math.max(a.length, b.length); }
// Share of the payer's name words found (allowing spelling slips) in the resident's name.
function nameScore(payer, resident) {
  const P = nameTokens(payer), R = nameTokens(resident);
  if (P.length < 2 || !R.length) return 0;        // a single word is never enough
  let hit = 0;
  for (const p of P) if (R.some(r => tokenSim(p, r) >= 0.8)) hit++;
  return hit / P.length;
}
function matchByName(payer, idx) {
  const scored = idx.members.map(m => ({ m, s: nameScore(payer, m.full_name) }))
    .filter(x => x.s >= 1).sort((a, b) => b.s - a.s);
  return scored.length === 1 ? scored[0].m : null; // exactly one resident fits
}

// Finds the resident for a payment: by house number first; by name only if there is
// no house number. Returns { member, how } or { member: null, why }.
function resolveResident(houseNumber, payerName, idx, { useNames = true } = {}) {
  const hasHouse = String(houseNumber || '').trim() !== '';
  if (hasHouse) {
    const k = famNum(houseNumber);
    if (!k) return { member: null, why: 'House number not understood' };
    if (!idx.byHouse.has(k)) return { member: null, why: 'House number not in residents list' };
    const m = idx.byHouse.get(k);
    return m ? { member: m, how: 'house' } : { member: null, why: 'More than one resident has this house number' };
  }
  if (!useNames) return { member: null, why: 'No house number' };
  const m = matchByName(payerName, idx);
  return m ? { member: m, how: 'name' } : { member: null, why: 'No house number, and no single resident matches the name' };
}

async function loadIndex(client = pool) {
  const r = await client.query(`SELECT id, full_name, house_number, is_active FROM members`);
  return buildMemberIndex(r.rows);
}

// Links every unlinked payment to a resident. Safe to run repeatedly; it only fills
// rows whose member_id is empty and never overwrites an existing link.
async function mapLedgerToMembers({ useNames = true } = {}) {
  await schemaReady;
  const idx  = await loadIndex();
  const rows = (await pool.query(
    `SELECT id, payer_name, house_number, payment_date, amount, receipt_number
     FROM payment_ledger WHERE member_id IS NULL ORDER BY payment_date, created_at`)).rows;
  let byHouse = 0, byName = 0;
  const unmapped = [];
  for (const r of rows) {
    const out = resolveResident(r.house_number, r.payer_name, idx, { useNames });
    if (!out.member) { unmapped.push({ id: r.id, payment_date: r.payment_date, payer_name: r.payer_name,
      house_number: r.house_number, amount: r.amount, receipt_number: r.receipt_number, reason: out.why }); continue; }
    // A row without a house number takes the resident's house number from the match.
    await pool.query(
      `UPDATE payment_ledger SET member_id = $1,
         house_number = CASE WHEN NULLIF(TRIM(COALESCE(house_number,'')),'') IS NULL THEN $2 ELSE house_number END
       WHERE id = $3 AND member_id IS NULL`,
      [out.member.id, out.member.house_number, r.id]);
    if (out.how === 'house') byHouse++; else byName++;
  }
  return { checked: rows.length, linkedByHouse: byHouse, linkedByName: byName, unmapped };
}

// Normalise the free-form payment mode from the ledger
function normMode(val) {
  const v = String(val || '').trim().toLowerCase().replace(/\s+/g, '_');
  const map = {
    cash:'cash', cheque:'cheque', check:'cheque',
    online:'online', upi:'online_upi', online_upi:'online_upi',
    neft:'online_neft', rtgs:'online_rtgs', dd:'demand_draft',
  };
  return map[v] || 'cash';
}

// ─────────────────────────────────────────────────────────
// GET /api/ledger — list payments, optionally filtered
// ?month=08&year=2026
// ?from=2026-04-01&to=2026-06-30   (inclusive date range, used by CSV export)
// ─────────────────────────────────────────────────────────
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    await schemaReady;
    const { month, year, from, to } = req.query;
    const conditions = [];
    const params = [];

    if (year) {
      params.push(parseInt(year));
      conditions.push(`EXTRACT(YEAR FROM payment_date) = $${params.length}`);
    }
    if (month) {
      params.push(parseInt(month));
      conditions.push(`EXTRACT(MONTH FROM payment_date) = $${params.length}`);
    }
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    if (from && isoDate.test(from)) {
      params.push(from);
      conditions.push(`payment_date >= $${params.length}::date`);
    }
    if (to && isoDate.test(to)) {
      params.push(to);
      conditions.push(`payment_date <= $${params.length}::date`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // The owner name is always mapped from the current members list (via house
    // number), so renaming a member updates the ledger automatically.
    //
    // The remark is whatever the recorder chose / typed when recording the payment.
    // Rows whose remark was never set (older entries) still show
    // "Payment of previous dues" when the amount is more than the quarters it
    // covers allow (one quarter if no duration was recorded): Rs. 4,000 per
    // quarter for homes, Rs. 750 for shops. The running yearly total is NOT used.
    const result = await pool.query(
      `WITH enriched AS (
         SELECT pl.*,
                SUM(pl.amount) OVER (
                  PARTITION BY ${houseKeySql('pl.house_number')}, pl.financial_year
                  ORDER BY pl.payment_date, pl.created_at, pl.id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cum_amount
         FROM payment_ledger pl
       ),
       joined AS (
         SELECT e.*,
                m.full_name AS member_name, m.id AS member_id_ref,
                (CASE WHEN m.unit_type::text = 'shop' THEN ${QUARTER_FEE_SHOP}
                      ELSE ${QUARTER_FEE_HOME} END) AS quarter_fee
         FROM enriched e
         LEFT JOIN LATERAL (
           SELECT mm.id, mm.full_name, mm.unit_type FROM members mm
           WHERE mm.id = e.member_id
              OR (e.member_id IS NULL AND ${houseKeySql('mm.house_number')} = ${houseKeySql('e.house_number')})
           ORDER BY (mm.id = e.member_id) DESC, mm.is_active DESC LIMIT 1
         ) m ON TRUE
       )
       SELECT j.id, j.payment_date,
              COALESCE(j.member_name, j.payer_name) AS payer_name,
              j.house_number, j.description,
              j.amount, j.payment_mode, j.bill_book_number, j.receipt_number,
              j.financial_year, j.created_at,
              j.start_quarter, j.quarters_covered,
              j.cum_amount,
              j.member_id_ref AS member_id,
              CASE
                WHEN j.remark IS NOT NULL THEN j.remark
                WHEN NULLIF(TRIM(COALESCE(j.house_number,'')),'') IS NOT NULL
                     AND j.amount > COALESCE(j.quarters_covered, 1) * j.quarter_fee
                  THEN 'Payment of previous dues'
                ELSE ''
              END AS remark
       FROM joined j
       ${where.replace(/\bpayment_date\b/g, 'j.payment_date')}
       ORDER BY j.payment_date DESC, j.receipt_number DESC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /ledger error:', err);
    return res.status(500).json({ error: 'Could not load payment ledger.' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/ledger/summary — monthly totals for a financial year
// ?year=2026 (calendar year of FY start; returns Apr–Mar)
// ─────────────────────────────────────────────────────────
router.get('/summary', requireLogin, canManage, async (req, res) => {
  try {
    const now     = new Date();
    const thisM   = now.getMonth() + 1;
    const thisY   = now.getFullYear();
    const fyStart = req.query.year ? parseInt(req.query.year) : (thisM >= 4 ? thisY : thisY - 1);

    const startDate = `${fyStart}-04-01`;
    const endDate   = `${fyStart + 1}-03-31`;

    // Per-month totals across the FY
    const monthly = await pool.query(
      `SELECT
         EXTRACT(YEAR  FROM payment_date)::int AS year,
         EXTRACT(MONTH FROM payment_date)::int AS month,
         COUNT(*)                 AS count,
         COALESCE(SUM(amount), 0) AS total
       FROM payment_ledger
       WHERE payment_date BETWEEN $1 AND $2
       GROUP BY year, month
       ORDER BY year, month`,
      [startDate, endDate]
    );

    // FY grand total
    const fyTotal = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payment_ledger
       WHERE payment_date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );

    return res.json({
      fyStart,
      fyLabel: `${fyStart}-${String(fyStart + 1).slice(-2)}`,
      months:  monthly.rows,
      fyTotal: parseFloat(fyTotal.rows[0].total),
      fyCount: parseInt(fyTotal.rows[0].count),
    });
  } catch (err) {
    console.error('GET /ledger/summary error:', err);
    return res.status(500).json({ error: 'Could not load summary.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/ledger — add a single payment entry
// ─────────────────────────────────────────────────────────
router.post('/', requireLogin, canWrite, async (req, res) => {
  try {
    const {
      paymentDate, payerName, houseNumber, description,
      amount, paymentMode, billBookNumber, receiptNumber,
      quartersCovered, startQuarter, remark,
    } = req.body;

    await schemaReady;
    if (!paymentDate || !houseNumber || amount === undefined || amount === null || amount === '') {
      return res.status(400).json({ error: 'Date, house number, and amount are required.' });
    }
    const dur = resolveDuration(quartersCovered, startQuarter, paymentDate);
    if (dur.error) return res.status(400).json({ error: dur.error });

    // The owner name comes from the members list, keyed on house number.
    let ownerName = (payerName || '').trim();
    const found = resolveResident(houseNumber, null, await loadIndex(), { useNames: false });
    let memberId = null;
    let canonicalHouse = houseNumber.trim();
    if (found.member) {
      ownerName      = found.member.full_name;
      canonicalHouse = found.member.house_number;   // store as in the members list
      memberId       = found.member.id;
    }
    if (!ownerName) {
      return res.status(404).json({
        error: `No member found for house number "${houseNumber}". Add the member first, or check the house number.`,
      });
    }

    const d  = new Date(paymentDate);
    const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    const financialYear = `${fy}-${String(fy + 1).slice(-2)}`;

    const result = await pool.query(
      `INSERT INTO payment_ledger
        (payment_date, payer_name, house_number, description,
         amount, payment_mode, bill_book_number, receipt_number,
         financial_year, recorded_by, start_quarter, quarters_covered, remark, member_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [paymentDate, ownerName, canonicalHouse,
       description || 'Maintenance', parseFloat(amount),
       normMode(paymentMode), billBookNumber || null,
       receiptNumber || null, financialYear, req.user.userId,
       dur.start, dur.count, cleanRemark(remark), memberId]
    );

    return res.status(201).json({ message: 'Payment recorded.', id: result.rows[0].id });
  } catch (err) {
    console.error('POST /ledger error:', err);
    return res.status(500).json({ error: `Could not record payment: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/ledger/unmapped — payments not yet linked to a resident
// POST /api/ledger/map-residents — run the linking again (admin roles)
// ─────────────────────────────────────────────────────────
router.get('/unmapped', requireLogin, canManage, async (req, res) => {
  try {
    const r = await mapLedgerToMembers({ useNames: true });
    return res.json({ unmapped: r.unmapped });
  } catch (err) {
    console.error('GET /ledger/unmapped error:', err);
    return res.status(500).json({ error: 'Could not check unlinked payments.' });
  }
});
router.post('/map-residents', requireLogin, canDelete, async (req, res) => {
  try {
    return res.json(await mapLedgerToMembers({ useNames: req.body.useNames !== false }));
  } catch (err) {
    console.error('POST /ledger/map-residents error:', err);
    return res.status(500).json({ error: 'Could not link payments to residents.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/ledger/import — bulk import from Excel
// ─────────────────────────────────────────────────────────
router.post('/import', requireLogin, canDelete, async (req, res) => {
  try {
    const { payments } = req.body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'No rows provided.' });
    }
    if (payments.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 rows per import.' });
    }

    const succeeded = [], failed = [];
    const idx = await loadIndex();

    for (let i = 0; i < payments.length; i++) {
      const r = payments[i];
      try {
        if (!r.paymentDate || !r.payerName || !r.amount) {
          throw new Error('Missing date, name, or amount');
        }
        const d  = new Date(r.paymentDate);
        const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
        const financialYear = `${fy}-${String(fy + 1).slice(-2)}`;
        const link  = resolveResident(r.houseNumber, r.payerName, idx);
        const house = (r.houseNumber && String(r.houseNumber).trim()) || (link.member ? link.member.house_number : null);

        await pool.query(
          `INSERT INTO payment_ledger
            (payment_date, payer_name, house_number, description,
             amount, payment_mode, bill_book_number, receipt_number,
             financial_year, recorded_by, member_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [r.paymentDate, r.payerName, house,
           r.description || 'Maintenance', parseFloat(r.amount),
           normMode(r.paymentMode), r.billBookNumber || null,
           r.receiptNumber || null, financialYear, req.user.userId, link.member ? link.member.id : null]
        );
        succeeded.push(r.receiptNumber || r.payerName);
      } catch (e) {
        failed.push({ row: r.receiptNumber || r.payerName || `Row ${i + 1}`, error: e.message });
      }
    }

    return res.json({
      successCount: succeeded.length,
      failedCount:  failed.length,
      totalRows:    payments.length,
      failed,
    });
  } catch (err) {
    console.error('POST /ledger/import error:', err);
    return res.status(500).json({ error: 'Import failed.' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/ledger/:id — edit an entry (canDelete roles only)
// ─────────────────────────────────────────────────────────
router.patch('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      paymentDate, payerName, houseNumber, description,
      amount, paymentMode, billBookNumber, receiptNumber,
      quartersCovered, startQuarter,
    } = req.body;
    const remarkSent = Object.prototype.hasOwnProperty.call(req.body, 'remark');

    await schemaReady;
    const cur = await pool.query(`SELECT * FROM payment_ledger WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

    // Keep the owner name mapped from the members list when a house number is given.
    let derivedName = payerName || null;
    let canonicalHouse = houseNumber || null;
    let memberId = null;
    if (houseNumber) {
      const found = resolveResident(houseNumber, null, await loadIndex(), { useNames: false });
      if (found.member) {
        derivedName    = found.member.full_name;
        canonicalHouse = found.member.house_number;
        memberId       = found.member.id;
      }
    }

    // Recompute the financial year if the payment date moved across an FY edge,
    // so the "previous dues" running total stays grouped correctly.
    let financialYear = null;
    if (paymentDate) {
      const d  = new Date(paymentDate);
      const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
      financialYear = `${fy}-${String(fy + 1).slice(-2)}`;
    }

    // Duration: sent as numbers -> validate and store; sent as null -> keep it "not recorded"
    // (older entry); not sent at all -> leave it as it is.
    const durationSent = Object.prototype.hasOwnProperty.call(req.body, 'quartersCovered');
    let durStart = null, durCount = null;
    if (durationSent && quartersCovered !== null && quartersCovered !== '') {
      const effDate = paymentDate || String(cur.rows[0].payment_date.toISOString ? cur.rows[0].payment_date.toISOString() : cur.rows[0].payment_date).slice(0, 10);
      const dur = resolveDuration(quartersCovered, startQuarter, effDate);
      if (dur.error) return res.status(400).json({ error: dur.error });
      durStart = dur.start; durCount = dur.count;
    }

    await pool.query(
      `UPDATE payment_ledger SET
         payment_date     = COALESCE($1, payment_date),
         payer_name       = COALESCE($2, payer_name),
         house_number     = $3,
         description      = COALESCE($4, description),
         amount           = COALESCE($5, amount),
         payment_mode     = COALESCE($6, payment_mode),
         bill_book_number = $7,
         receipt_number   = $8,
         financial_year   = COALESCE($9, financial_year),
         start_quarter    = CASE WHEN $11::boolean THEN $12::smallint ELSE start_quarter END,
         quarters_covered = CASE WHEN $11::boolean THEN $13::smallint ELSE quarters_covered END,
         remark           = CASE WHEN $14::boolean THEN $15::text ELSE remark END,
         member_id        = $16,
         updated_at       = NOW()
       WHERE id = $10`,
      [paymentDate || null, derivedName, canonicalHouse,
       description || null, amount !== undefined ? parseFloat(amount) : null,
       paymentMode ? normMode(paymentMode) : null,
       billBookNumber || null, receiptNumber || null, financialYear, id,
       durationSent, durStart, durCount,
       remarkSent, remarkSent ? cleanRemark(req.body.remark) : null, memberId]
    );
    return res.json({ message: 'Entry updated.' });
  } catch (err) {
    console.error('PATCH /ledger/:id error:', err);
    return res.status(500).json({ error: `Could not update: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/ledger/:id — canDelete roles only
// ─────────────────────────────────────────────────────────
router.delete('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM payment_ledger WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });
    return res.json({ message: 'Entry deleted.' });
  } catch (err) {
    console.error('DELETE /ledger/:id error:', err);
    return res.status(500).json({ error: 'Could not delete entry.' });
  }
});

module.exports = router;
module.exports.houseKeySql = houseKeySql;
