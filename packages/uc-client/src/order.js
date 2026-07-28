// Resolve a sale order from Unicommerce by SO NUMBER ALONE - no Waypoint row, no sheet
// row, no operator-supplied warehouse.
//
// Two properties of the UC data API make this possible. Both were verified against live
// oppdoor, and the difference between them is the whole trick:
//
//   /data/oms/saleorder/fetchSummary  is facility-AGNOSTIC. It answers for any SO no
//        matter which facility the session sits at, and carries status, channel,
//        destination address, order value, unit count and the PO custom field. Passing a
//        Facility to it is pointless - it returns the same order either way.
//
//   /data/oms/saleorder/fetch  is facility-SCOPED. It returns a saleOrderDTO at the ONE
//        facility that owns the order, and successful:false at every other. That makes it
//        the only reliable way to learn an order's pickup warehouse: an order that has
//        not been invoiced or packed yet exposes its facility nowhere else (there is no
//        invoice and no shipping package to read it from, and fetchSummary omits it).
//
// So: summary for the fields, a facility hop for the warehouse.
//
// The hop is the expensive half (one call per facility until it hits), so it is ordered
// by likelihood and memoised per lookup instance. Orders in one operator batch almost
// always share a warehouse, so the last hit is tried first and a batch of 20 SOs from the
// same warehouse costs ~20 calls instead of ~20x24.

/** SO code variants worth trying against UC (SO-02780 / so 02780 -> SO02780). */
export function soVariants(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out = [s];
  const up = s.toUpperCase().replace(/\s+/g, '');
  if (!out.includes(up)) out.push(up);
  const m = s.match(/SO\s*-?\s*\d+/i);
  if (m) {
    const so = m[0].replace(/\s+/g, '').replace(/SO-/i, 'SO').toUpperCase();
    if (!out.includes(so)) out.push(so);
  }
  return out;
}

const numOr = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** RELIANCE_AJIO_SOR_B2B -> "Reliance Ajio". Readable in an operator-facing table without
 *  a channel->brand lookup table to keep in sync; the B2B sheet keeps its own canonical
 *  marketplace dropdown mapping for the columns it owns. */
export function prettyChannel(channel) {
  return String(channel || '')
    .replace(/_(B2B|SOR|SOR_B2B)$/gi, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The PO / appointment values UC keeps as sale-order custom fields. */
function customField(list, re) {
  for (const f of list || []) {
    const name = String(f.fieldName || f.displayName || '');
    if (!re.test(name)) continue;
    const v = String(f.fieldValue ?? '').trim();
    if (v && v !== 'null' && v !== 'None') return v;
  }
  return '';
}

export function makeUcOrderLookup(uc, { preferFacilities = [] } = {}) {
  let oppCache = null;
  const foundAt = new Map(); // SO -> facility, so a repeated lookup never re-hops
  let lastFound = null; // batch locality: consecutive SOs usually share a warehouse

  const key = (so) => String(so || '').trim().toUpperCase().replace(/[\s_-]/g, '');

  /** Our own pickup warehouses, live. The 90-odd AMAZON_FBA_* facilities in the account
   *  are channel drop points, never the seller facility an order is fulfilled from, so
   *  hopping them would triple the cost for nothing. */
  async function oppFacilities() {
    if (oppCache) return oppCache;
    const { all } = await uc.listFacilities();
    const opp = (all || []).filter((f) => /^Opp/i.test(f));
    oppCache = opp.length ? opp : (all || []);
    return oppCache;
  }

  const softly = async (p) => p.catch((e) => {
    if (e?.name === 'SessionError') throw e; // real session death must surface
    return null;
  });

  /** Facility-agnostic field set. Null when UC has no such order at all. */
  async function summary(so) {
    for (const code of soVariants(so)) {
      const d = await softly(uc.data('/data/oms/saleorder/fetchSummary', { code }, {}));
      const s = d?.saleOrderSummary;
      if (!s || !(s.code || s.status)) continue;
      const addr = s.shippingAddress || s.billingAddress || {};
      const cf = s.customFieldValues || [];
      const ms = numOr(s.displayOrderDateTime) || numOr(s.created);
      return {
        so: s.code || code,
        displayCode: s.displayOrderCode || '',
        status: s.status || s.statusCode || '',
        channel: s.channel || s.channelCode || '',
        city: addr.city || '',
        state: addr.stateName || addr.state || '',
        pincode: addr.pincode || addr.pinCode || '',
        value: numOr(s.totalPrice) || '',
        units: numOr(s.saleOrderItemCount) || numOr(s.itemStatus?.totalItems) || '',
        gstin: s.customerGSTIN || '',
        po: customField(cf, /^PO$|PURCHASE/i),
        appointmentId: customField(cf, /APPOINTMENT.*(REF|ID)|^APPT/i),
        orderedAt: ms ? new Date(ms) : null,
        invoiceCount: numOr(s.invoiceCount),
      };
    }
    return null;
  }

  /** The facility that owns this order, '' when no facility claims it. */
  async function locateFacility(so, { prefer = null } = {}) {
    const k = key(so);
    if (foundAt.has(k)) return foundAt.get(k);

    const all = await oppFacilities();
    const order = [...new Set([prefer, lastFound, ...preferFacilities, ...all].filter(Boolean))];
    const variants = soVariants(so);

    for (const facility of order) {
      for (const code of variants) {
        const d = await softly(uc.data('/data/oms/saleorder/fetch', { code }, { facility }));
        const dto = d?.saleOrderDTO;
        if (d?.successful === false || !dto?.code) continue;
        // The items name the facility themselves; trust that over the one we asked as.
        const owner = dto.saleOrderItems?.[0]?.facilityCode || facility;
        foundAt.set(k, owner);
        lastFound = owner;
        return owner;
      }
    }
    foundAt.set(k, '');
    return '';
  }

  /** Everything we can know about an SO from UC: fields + pickup warehouse. */
  async function resolveOrder(so, { prefer = null, needFacility = true } = {}) {
    const s = await summary(so);
    if (!s) return null;
    const facility = needFacility ? await locateFacility(s.so || so, { prefer }) : '';
    return { ...s, facility };
  }

  return { summary, locateFacility, resolveOrder };
}
