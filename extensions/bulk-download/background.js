// Background service worker, bulk download of INVOICE or E-WAY BILL PDFs, facility-aware.
//
// Proven on production (oppdoor.unicommerce.co.in):
//   GET  /data/user/facilities                          -> {currentFacilityCode, facilityDTOList[].code}
//   POST /data/user/switchfacility {currentUrl,facilityCode}   -> switches the session facility
//   POST /data/oms/saleorder/fetchShippingPackageDetails {saleOrderCode}
//        -> shippingPackages[].{invoiceCode, ewayBillPdfUrl}   (ONLY when on that order's facility)
//   GET  /oms/invoice/show?invoiceCodes=<urlencoded code>&legacy=1  -> application/pdf
//   ewayBillPdfUrl is a direct (S3) link to the e-way bill PDF.
//
// fetchShippingPackageDetails is facility-scoped, so for each SO we try the current
// facility then hop through the user's facilities until the order's packages are found.
// Runs in-browser, so the logged-in session cookie is sent automatically.

async function getFacilities(base) {
  const r = await fetch(base + '/data/user/facilities', { credentials: 'include', headers: { 'Accept': 'application/json' } });
  if ([401, 403, 302].includes(r.status)) throw new Error('not logged in, open & log into Unicommerce first');
  const d = await r.json();
  return { current: d.currentFacilityCode, all: (d.facilityDTOList || []).map(f => f.code) };
}

async function switchFacility(base, code) {
  await fetch(base + '/data/user/switchfacility', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    body: JSON.stringify({ currentUrl: '/b2b/orders', facilityCode: code })
  });
}

async function packagesForSo(base, so) {
  const r = await fetch(base + '/data/oms/saleorder/fetchShippingPackageDetails', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    body: JSON.stringify({ saleOrderCode: so })
  });
  if ([401, 403, 302].includes(r.status)) throw new Error('not logged in');
  const d = await r.json().catch(() => null);
  if (!d) throw new Error('unexpected response (HTTP ' + r.status + ')');
  return d.shippingPackages || [];
}

// "OPT-SO-12345" -> ["OPT-SO-12345"]; "so01562" -> ["so01562","SO01562"]; pulls embedded SO# too
function candidateCodes(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out = [s];
  const up = s.toUpperCase().replace(/\s+/g, '');
  if (!out.includes(up)) out.push(up);
  const m = s.match(/SO\s*\d+/i);
  if (m) { const so = m[0].replace(/\s+/g, '').toUpperCase(); if (!out.includes(so)) out.push(so); }
  return out;
}

// find the facility where this SO's packages live
async function resolveAcrossFacilities(base, raw, state) {
  for (const cand of candidateCodes(raw)) {
    let sps = await packagesForSo(base, cand);
    if (sps.length) return { sps, facility: state.cur, matched: cand };
    for (const fac of state.all) {
      if (fac === state.cur) continue;
      await switchFacility(base, fac); state.cur = fac;
      sps = await packagesForSo(base, cand);
      if (sps.length) return { sps, facility: fac, matched: cand };
    }
  }
  return { sps: [] };
}

// when nothing found, look up the order's status for a clear message
async function orderStatusAcrossFacilities(base, candidates, state) {
  for (const cand of candidates) {
    for (const fac of [state.cur].concat(state.all)) {
      if (fac !== state.cur) { await switchFacility(base, fac); state.cur = fac; }
      try {
        const r = await fetch(base + '/data/oms/saleorder/fetchSummary', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
          body: JSON.stringify({ code: cand })
        });
        const d = await r.json().catch(() => null);
        const s = d && d.saleOrderSummary;
        if (s && s.code) return { found: true, status: s.status };
      } catch (e) {}
    }
  }
  return { found: false };
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Invoice PDF: facility-scoped -> fetch WHILE on the found facility, save from memory.
async function downloadInvoicePdf(base, invoiceCode, filename) {
  const url = base + '/oms/invoice/show?invoiceCodes=' + encodeURIComponent(invoiceCode) + '&legacy=1';
  const r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/pdf' } });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !/pdf/i.test(ct)) throw new Error('invoice not available (HTTP ' + r.status + ')');
  const dataUrl = 'data:application/pdf;base64,' + bufToB64(await r.arrayBuffer());
  await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'overwrite' });
}

// E-way bill PDF: ewayBillPdfUrl is a self-contained (S3) link, download directly.
async function downloadEwayPdf(url, filename) {
  await chrome.downloads.download({ url, filename, conflictAction: 'overwrite' });
}

function progress(o) { try { chrome.runtime.sendMessage(Object.assign({ type: 'progress' }, o)); } catch (e) {} }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'downloadBatch') return;
  (async () => {
    const base = msg.base.replace(/\/+$/, '');
    const doc = msg.doc === 'eway' ? 'eway' : 'invoice';
    let done = 0, failSos = 0, origin = null;
    try {
      const facs = await getFacilities(base);
      origin = facs.current;
      const state = { cur: facs.current, all: facs.all };
      for (const so of msg.sos) {
        try {
          const { sps, facility, matched } = await resolveAcrossFacilities(base, so, state);
          if (!sps.length) {
            failSos++;
            const info = await orderStatusAcrossFacilities(base, candidateCodes(so), state);
            progress({ so, ok: false, error: info.found ? ('not invoiced yet, status ' + info.status) : 'order not found (check the id)' });
            continue;
          }
          const fnameBase = (matched && /^[A-Za-z0-9._-]+$/.test(matched)) ? matched : so.replace(/[^A-Za-z0-9._-]/g, '_');

          if (doc === 'eway') {
            const urls = [...new Set(sps.map(s => s.ewayBillPdfUrl).filter(Boolean))];
            if (!urls.length) { failSos++; progress({ so, ok: false, error: 'no e-way bill generated for this SO yet' }); continue; }
            for (let i = 0; i < urls.length; i++) {
              const sfx = urls.length > 1 ? ('-' + (i + 1)) : '';
              await downloadEwayPdf(urls[i], `opptra-so/${fnameBase}-eway-bill${sfx}.pdf`);
              done++;
            }
            progress({ so, ok: true, count: urls.length, facility, matched });
          } else {
            const codes = [...new Set(sps.map(s => s.invoiceCode).filter(Boolean))];
            if (!codes.length) { failSos++; progress({ so, ok: false, error: 'not invoiced yet (no invoice to download)' }); continue; }
            for (let i = 0; i < codes.length; i++) {
              const sfx = codes.length > 1 ? ('-' + (i + 1)) : '';
              await downloadInvoicePdf(base, codes[i], `opptra-so/${fnameBase}-invoice${sfx}.pdf`);
              done++;
            }
            progress({ so, ok: true, count: codes.length, facility, matched });
          }
        } catch (e) { failSos++; progress({ so, ok: false, error: e.message }); }
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message }); return;
    } finally {
      if (origin) { try { await switchFacility(base, origin); } catch (e) {} }  // restore user's facility
    }
    sendResponse({ ok: true, done, failSos });
  })();
  return true; // async
});
