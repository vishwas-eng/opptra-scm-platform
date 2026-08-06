// Waypoint's own Postgres (Neon) - the real source of truth for SO data, queried directly
// instead of scraping Waypoint's CSV export. Read-only: this pipeline never writes here.
//
// Schema (verified against the live DB, not guessed):
//   SalesOrder(so_code pk, so_status, marketplace, dispatch_warehouse_code, ship_to_city,
//              so_value, so_creation_date, po_code, suppressed, ...)
//   SoLineItem(so_code fk, brand_name, units, ...)          - one row per SKU on the SO
//   Appointment(so_code fk, appointment_date, appointment_id, created_at, ...)
import pg from 'pg';

let pool = null;
function pool_(dbUrl) {
  // A distinct pool from @opptra/core's db() - this is a different database entirely
  // (Waypoint's, not the platform's own), so it must never share a connection pool.
  if (!pool) pool = new pg.Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  return pool;
}

// EVERY status, not just CREATED: whatever view/filter ops happen to be looking at in
// Waypoint, the sheet takes the whole order book (CREATED, PROCESSING, DISPATCHED, ...).
// `suppressed` is not a status - it marks rows Waypoint itself has withdrawn - so those
// stay out.
const ALL_SOS_SQL = `
  SELECT
    so.so_code, so.so_status, so.marketplace, so.customer_code, so.dispatch_warehouse_code,
    so.ship_to_city, so.so_value, so.so_creation_date, so.po_code,
    li.brands, li.total_units,
    ap.appointment_date, ap.appointment_id
  FROM "SalesOrder" so
  LEFT JOIN (
    SELECT so_code, string_agg(DISTINCT brand_name, ',') AS brands, sum(units) AS total_units
    FROM "SoLineItem" WHERE brand_name IS NOT NULL GROUP BY so_code
  ) li ON li.so_code = so.so_code
  LEFT JOIN LATERAL (
    SELECT appointment_date, appointment_id FROM "Appointment" a
    WHERE a.so_code = so.so_code ORDER BY a.created_at DESC LIMIT 1
  ) ap ON true
  WHERE so.suppressed = false
  ORDER BY so.so_creation_date DESC
`;

// Pure - a Neon SQL row -> the same key shape phase1Mapper already reads from a Waypoint
// CSV export row, so the rest of the pipeline doesn't care which source ran.
export function mapNeonRow(r) {
  return {
    'SO Code': r.so_code,
    'SO Status': r.so_status,
    'PO Code': r.po_code,
    Warehouse: r.dispatch_warehouse_code || '',
    // Customer (customer_code) is the Marketplace ops expect on the sheet; channel
    // marketplace stays as a fallback when customer_code is blank.
    Customer: r.customer_code || '',
    Marketplace: r.marketplace || '',
    'Brand(s)': r.brands || '',
    'Total Units': r.total_units || 0,
    'SO Value': r.so_value,
    'Created Date': r.so_creation_date,
    'Ship-to City': r.ship_to_city || '',
    'Appt Date': r.appointment_date,
    'Appt ID': r.appointment_id || '',
  };
}

/** All non-suppressed sale orders from Waypoint's Neon DB, any status. */
export async function fetchSOsFromNeon(dbUrl) {
  const { rows } = await pool_(dbUrl).query(ALL_SOS_SQL);
  return rows.map(mapNeonRow);
}

/** Cheap connectivity probe for connector health, never touches business tables' data. */
export async function pingWaypointDb(dbUrl) {
  const { rows } = await pool_(dbUrl).query('SELECT count(*)::int AS n FROM "SalesOrder"');
  return { ok: true, salesOrders: rows[0]?.n ?? 0 };
}

/**
 * Filtered, LIMITed SO query for the Agent connector. Unlike fetchSOsFromNeon (the sheet
 * pipeline wants the whole order book), agent questions are "recent/specific", pulling
 * every row to answer a 20-row question wastes Neon compute and tool-result tokens.
 * All filters are parameterized; free-text values never touch the SQL string.
 */
export function buildWaypointSOQuery({
  soCode, poCode, status, customer, warehouse, createdFrom, createdTo, limit = 50,
} = {}) {
  const where = ['so.suppressed = false'];
  const params = [];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
  if (soCode) add('so.so_code = ?', String(soCode).trim());
  if (poCode) add('so.po_code = ?', String(poCode).trim());
  if (status) add('upper(so.so_status) = upper(?)', String(status).trim());
  if (customer) add('upper(so.customer_code) = upper(?)', String(customer).trim());
  if (warehouse) add('upper(so.dispatch_warehouse_code) = upper(?)', String(warehouse).trim());
  if (createdFrom) add('so.so_creation_date >= ?', createdFrom);
  if (createdTo) add('so.so_creation_date <= ?', createdTo);
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const sql = `
    SELECT
      so.so_code, so.so_status, so.marketplace, so.customer_code, so.dispatch_warehouse_code,
      so.ship_to_city, so.so_value, so.so_creation_date, so.po_code,
      li.brands, li.total_units,
      ap.appointment_date, ap.appointment_id
    FROM "SalesOrder" so
    LEFT JOIN (
      SELECT so_code, string_agg(DISTINCT brand_name, ',') AS brands, sum(units) AS total_units
      FROM "SoLineItem" WHERE brand_name IS NOT NULL GROUP BY so_code
    ) li ON li.so_code = so.so_code
    LEFT JOIN LATERAL (
      SELECT appointment_date, appointment_id FROM "Appointment" a
      WHERE a.so_code = so.so_code ORDER BY a.created_at DESC LIMIT 1
    ) ap ON true
    WHERE ${where.join(' AND ')}
    ORDER BY so.so_creation_date DESC
    LIMIT $${params.length}
  `;
  return { sql, params };
}

export async function queryWaypointSOs(dbUrl, filters = {}) {
  const { sql, params } = buildWaypointSOQuery(filters);
  const { rows } = await pool_(dbUrl).query(sql, params);
  return rows.map(mapNeonRow);
}

/** @deprecated name kept for callers written when this was CREATED-only. */
export const fetchCreatedSOsFromNeon = fetchSOsFromNeon;

export async function closeWaypointDb() {
  if (pool) { await pool.end(); pool = null; }
}
