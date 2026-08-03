/* Browser-side mirrors of @opptra/core validate helpers (no bundler — keep in sync). */
window.OpptraValidate = (() => {
  const SO_RE = /^[A-Za-z0-9/_-]{2,40}$/;
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;
  const BULK_RETURN_RE = /^BR-?\d{3,}$/i;

  const trim = (x) => (x == null ? '' : String(x).trim());

  function validateBulkReturnId(id) {
    const v = trim(id);
    if (!v || /[\s,;]/.test(v) || !BULK_RETURN_RE.test(v)) {
      return 'Enter one Bulk Return ID like BR0160 (not multiple, not random text)';
    }
    return null;
  }

  function validateSaleOrder(so, label = 'Sale Order') {
    const v = trim(so);
    if (!v) return `Enter a ${label}.`;
    if (!SO_RE.test(v)) return `"${v}" is not a valid ${label} (letters, digits, / _ - ; 2–40 chars)`;
    return null;
  }

  function validateSaleOrderList(list, label = 'Sale Order') {
    const ids = (list || []).map(trim).filter(Boolean);
    if (!ids.length) return `Enter at least one ${label}.`;
    for (const id of ids) {
      if (!SO_RE.test(id)) return `"${id}" is not a valid ${label}`;
    }
    return null;
  }

  function validateEwayRows(rows) {
    if (!rows?.length) return 'Add at least one row with an SO Number (or import the Excel template).';
    if (rows.length > 100) return 'Maximum 100 rows per batch.';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const n = i + 1;
      if (!trim(r.so)) return `Row ${n}: SO Number is required`;
      if (!SO_RE.test(trim(r.so))) return `Row ${n}: "${r.so}" is not a valid SO Number`;
      const gstin = trim(r.gstin);
      if (gstin && !GSTIN_RE.test(gstin)) {
        return `Row ${n} (${r.so}): Transporter GSTIN must be a valid 15-character Indian GSTIN (or leave blank)`;
      }
      const mode = trim(r.transMode || 'ROAD').toUpperCase();
      if (mode === 'ROAD' && !trim(r.vehicleNo)) {
        return `Row ${n} (${r.so}): Vehicle number is required for Road transport (GST error 4011)`;
      }
    }
    return null;
  }

  return {
    SO_RE, GSTIN_RE, BULK_RETURN_RE,
    validateBulkReturnId, validateSaleOrder, validateSaleOrderList, validateEwayRows,
  };
})();
