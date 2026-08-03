// Pre-flight input validators for SCM automations.
// Reject bad input BEFORE createRun / enqueue so the worker never starts on garbage.
//
// Shape: { ok: true, ...normalized } | { ok: false, error, fieldErrors: [{ field, message, row? }] }

const SO_RE = /^[A-Za-z0-9/_-]{2,40}$/;
/** Indian GSTIN: 2 digit state + 10 PAN + entity + Z + check digit. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;
/** Bulk Return IDs look like BR0160 / BR-0052 (never free text or multi-ID paste). */
const BULK_RETURN_RE = /^BR-?\d{3,}$/i;

function fail(error, fieldErrors = []) {
  return { ok: false, error, fieldErrors };
}

function trim(x) {
  return x == null ? '' : String(x).trim();
}

/** Build the standard 400 JSON body. */
export function validationFailBody(result) {
  return {
    ok: false,
    error: result.error || 'invalid input',
    fieldErrors: result.fieldErrors || [],
  };
}

export function isValidSaleOrder(code) {
  return SO_RE.test(trim(code));
}

export function isValidGstin(gstin) {
  const g = trim(gstin);
  return !g || GSTIN_RE.test(g);
}

export function isValidBulkReturnId(id) {
  return BULK_RETURN_RE.test(trim(id));
}

/**
 * Normalize + validate a list of SO / GP-style identifiers.
 * @param {unknown} list
 * @param {{ required?: boolean, max?: number, field?: string, label?: string }} [opts]
 */
export function validateIdList(list, opts = {}) {
  const {
    required = true,
    max = 200,
    field = 'saleOrders',
    label = 'Sale Order',
  } = opts;
  const raw = Array.isArray(list) ? list : [];
  const fieldErrors = [];
  const cleaned = [];

  for (let i = 0; i < raw.length; i++) {
    const id = trim(raw[i]);
    if (!id) {
      fieldErrors.push({ field: `${field}[${i}]`, message: `${label} cannot be empty`, row: i + 1 });
      continue;
    }
    if (!SO_RE.test(id)) {
      fieldErrors.push({
        field: `${field}[${i}]`,
        message: `"${id}" is not a valid ${label} (use letters, digits, / _ - ; 2–40 chars)`,
        row: i + 1,
      });
      continue;
    }
    cleaned.push(id);
  }

  if (required && !cleaned.length && !fieldErrors.length) {
    return fail(`Enter at least one ${label}.`, [{ field, message: `Enter at least one ${label}.` }]);
  }
  if (cleaned.length > max) {
    return fail(`Maximum ${max} ${label}(s) per request.`, [{ field, message: `Maximum ${max} per request` }]);
  }
  if (fieldErrors.length) {
    const first = fieldErrors[0];
    return fail(first.message, fieldErrors);
  }
  return { ok: true, ids: cleaned };
}

/** Single required ID (order lookup, ASN SO, return SO, etc.). */
export function validateRequiredId(value, { field = 'saleOrder', label = 'Sale Order' } = {}) {
  const id = trim(value);
  if (!id) {
    return fail(`Enter a ${label}.`, [{ field, message: `Enter a ${label}.` }]);
  }
  if (!SO_RE.test(id)) {
    return fail(
      `"${id}" is not a valid ${label} (use letters, digits, / _ - ; 2–40 chars)`,
      [{ field, message: `"${id}" is not a valid ${label}` }],
    );
  }
  return { ok: true, id };
}

/**
 * Reverse DC: one Bulk Return ID + facility.
 * Rejects typos like "vugj", multi-IDs, commas/spaces.
 */
export function validateReverseDcInput({ bulkReturnId, facility } = {}) {
  const fieldErrors = [];
  const fac = trim(facility);
  const id = trim(bulkReturnId);

  if (!fac) {
    fieldErrors.push({ field: 'facility', message: 'Select a warehouse / facility first.' });
  }
  if (!id) {
    fieldErrors.push({
      field: 'bulkReturnId',
      message: 'Enter one Bulk Return ID like BR0160 (not multiple, not random text)',
    });
  } else if (/[\s,;]+/.test(id) || id.includes(',')) {
    fieldErrors.push({
      field: 'bulkReturnId',
      message: 'Enter one Bulk Return ID like BR0160 (not multiple, not random text)',
    });
  } else if (!BULK_RETURN_RE.test(id)) {
    fieldErrors.push({
      field: 'bulkReturnId',
      message: 'Enter one Bulk Return ID like BR0160 (not multiple, not random text)',
    });
  }

  if (fieldErrors.length) {
    return fail(fieldErrors[0].message, fieldErrors);
  }
  return { ok: true, bulkReturnId: id.toUpperCase(), facility: fac };
}

/**
 * E-way bill: validate every row before queueing (dry-run included).
 * Road transport requires a vehicle number (GST 4011).
 */
export function validateEwaybillInput({ rows, dryRun } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return fail('Add at least one row with an SO Number.', [{ field: 'rows', message: 'Add at least one row with an SO Number.' }]);
  }
  if (rows.length > 100) {
    return fail('Maximum 100 rows per batch.', [{ field: 'rows', message: 'Maximum 100 rows per batch.' }]);
  }

  const fieldErrors = [];
  const cleaned = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const rowNum = i + 1;
    const so = trim(row.so);
    const gstin = trim(row.gstin);
    const transporterName = trim(row.transporterName);
    const transMode = trim(row.transMode || 'ROAD').toUpperCase();
    const vehicleNo = trim(row.vehicleNo);
    const distance = trim(row.distance);
    const docNo = trim(row.docNo);
    const docDate = trim(row.docDate);
    const vehicleType = trim(row.vehicleType);

    if (!so) {
      fieldErrors.push({ field: `rows[${i}].so`, message: `Row ${rowNum}: SO Number is required`, row: rowNum });
      continue;
    }
    if (!SO_RE.test(so)) {
      fieldErrors.push({
        field: `rows[${i}].so`,
        message: `Row ${rowNum}: "${so}" is not a valid SO Number`,
        row: rowNum,
      });
      continue;
    }
    if (gstin && !GSTIN_RE.test(gstin)) {
      fieldErrors.push({
        field: `rows[${i}].gstin`,
        message: `Row ${rowNum} (${so}): Transporter GSTIN must be a valid 15-character Indian GSTIN (or leave blank)`,
        row: rowNum,
      });
    }
    if (transporterName && transporterName.length < 2) {
      fieldErrors.push({
        field: `rows[${i}].transporterName`,
        message: `Row ${rowNum} (${so}): Transporter name looks too short`,
        row: rowNum,
      });
    }
    if (/^ROAD$/i.test(transMode) && !vehicleNo) {
      fieldErrors.push({
        field: `rows[${i}].vehicleNo`,
        message: `Row ${rowNum} (${so}): Vehicle number is required for Road transport (GST error 4011)`,
        row: rowNum,
      });
    }
    if (distance && (Number.isNaN(Number(distance)) || Number(distance) < 0)) {
      fieldErrors.push({
        field: `rows[${i}].distance`,
        message: `Row ${rowNum} (${so}): Distance must be a number (km)`,
        row: rowNum,
      });
    }

    cleaned.push({
      so,
      gstin: gstin || undefined,
      transporterName: transporterName || undefined,
      transMode: transMode || undefined,
      vehicleNo: vehicleNo || undefined,
      distance: distance || undefined,
      docNo: docNo || undefined,
      docDate: docDate || undefined,
      vehicleType: vehicleType || undefined,
    });
  }

  if (fieldErrors.length) {
    const n = fieldErrors.length;
    const summary = n === 1
      ? fieldErrors[0].message
      : `${n} row(s) have invalid input — ${fieldErrors[0].message}`;
    return fail(summary, fieldErrors);
  }
  return { ok: true, rows: cleaned, dryRun: !!dryRun };
}

/**
 * Packing mail: SO list must be present and well-formed.
 * Warehouse-email directory check needs Google Sheets (worker) — not hard-blocked here.
 */
export function validatePackingInput({ saleOrders } = {}) {
  return validateIdList(saleOrders, {
    required: true,
    max: 200,
    field: 'saleOrders',
    label: 'Sale Order',
  });
}

/**
 * Sheet update fills: optional SO list, but every entry must be sane when provided.
 */
export function validateSheetSaleOrders(saleOrders) {
  if (saleOrders == null || (Array.isArray(saleOrders) && !saleOrders.length)) {
    return { ok: true, ids: [] };
  }
  return validateIdList(saleOrders, {
    required: false,
    max: 200,
    field: 'saleOrders',
    label: 'SO / GP number',
  });
}

/**
 * ASN: SO required. Channel override (if any) must be Flipkart/Myntra/Zepto.
 * Amazon / other channels are rejected after UC lookup in the pipeline (needs live UC).
 */
const ASN_CHANNELS = new Set(['flipkart', 'myntra', 'zepto']);

export function validateAsnInput({ saleOrder, channel } = {}) {
  const so = validateRequiredId(saleOrder, { field: 'saleOrder', label: 'Sale Order' });
  if (!so.ok) return so;

  const ch = trim(channel).toLowerCase();
  if (ch && !ASN_CHANNELS.has(ch)) {
    return fail(
      'ASN supports Flipkart/Myntra/Zepto only',
      [{ field: 'channel', message: 'ASN supports Flipkart/Myntra/Zepto only' }],
    );
  }
  return { ok: true, saleOrder: so.id, channel: ch || undefined };
}

/** Human-readable ASN channel error used after UC detect (Amazon B2B etc.). */
export function asnUnsupportedChannelMessage(ucChannel) {
  const ch = trim(ucChannel);
  const isAmazon = /AMAZON|COCOBLU/i.test(ch);
  let msg = 'ASN supports Flipkart/Myntra/Zepto only';
  if (ch) msg += ` (this SO is ${ch})`;
  if (isAmazon) msg += '. Amazon orders use the Packing Mail flow instead (labels + appointment letters).';
  return msg;
}

export {
  SO_RE,
  GSTIN_RE,
  BULK_RETURN_RE,
};
