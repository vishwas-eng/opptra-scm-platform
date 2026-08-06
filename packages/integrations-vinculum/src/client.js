// Vinculum VIN eRetail (Home Centre seller portal), Node client.
// Proven 2026-06-22: RSA login (no OTP) + commonJsonSearch order pull.
// Portal: https://landmarkgroup.vinsupplier.com/eRetailWeb/
//
// Login POST is minimal: userName + RSA-encrypted password (PKCS1 v1.5).
// Extra fields (spUserId / userOrgId) are NOT required for the API login that worked in June.

import crypto from 'node:crypto';
import { URLSearchParams } from 'node:url';

const DEFAULT_BASE = 'https://landmarkgroup.vinsupplier.com/eRetailWeb';

function jarFromSetCookie(setCookie) {
  const jar = new Map();
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const raw of list) {
    const part = String(raw).split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}

function mergeJar(jar, setCookie) {
  for (const [k, v] of jarFromSetCookie(setCookie)) jar.set(k, v);
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Extract RSA public key PEM from Vinculum login HTML (JSEncrypt / key in page). */
export function extractPublicKeyPem(html) {
  const text = String(html || '');
  const match = text.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/);
  if (!match) throw new Error('Vinculum login page: RSA public key not found (page layout may have changed)');
  // Page embeds the key in a JS template literal with leading tabs/spaces per line, strip them.
  const body = match[1]
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

export function encryptPasswordRsaPkcs1(plaintext, publicKeyPem) {
  const buf = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(plaintext), 'utf8'),
  );
  return buf.toString('base64');
}

/**
 * Decide whether a Vinculum import actually succeeded.
 *
 * Struts apps answer HTTP 200 with an HTML error page, so "2xx and not a login page"
 * reported success for a rejected file, the inventory would look pushed and would not
 * be. An import we cannot positively confirm is reported as unconfirmed, not as done:
 * for a live stock write, a false success is far worse than a false alarm.
 *
 * @returns {{ ok: boolean, confirmed: boolean, reason: string, preview: string }}
 */
export function classifyImportResponse(status, body) {
  const raw = String(body || '');
  const preview = raw.slice(0, 400);

  if (status < 200 || status >= 400) {
    return { ok: false, confirmed: true, reason: `HTTP ${status}`, preview };
  }

  // Scan VISIBLE TEXT only. Vinculum returns the whole Update Price/Inventory page,
  // whose markup contains ids like `failedGridTab` for the Error tab and onclick
  // handlers mentioning errors. Matching raw HTML flagged a successful upload as
  // failed, so strip scripts, styles and every tag before looking for wording.
  const text = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/Invalid Login|Login Failed/i.test(text) || /sellerPanalLogin\.action/i.test(raw)) {
    return { ok: false, confirmed: true, reason: 'session expired, bounced to login', preview };
  }

  // Vinculum answers an accepted import with a batch number. That is the only
  // positive signal worth trusting, and it is what lets us verify the result later.
  const batch = raw.match(/(?:import\s*batch\s*(?:no|number)?|batchNo|importBatchNo)\D{0,20}(\d{3,})/i);
  if (batch) {
    return { ok: true, confirmed: true, batchNo: batch[1], reason: `import accepted, batch ${batch[1]}`, preview };
  }

  // A real error message is more useful than "not processed", so look for one first.
  // The pattern deliberately does NOT match a bare "Error": that is the page's own tab
  // label and appears on every normal render.
  const failure = text.match(/(?:error\s*[:\-]\s*|invalid\b|rejected\b|not\s+uploaded\b|failed\s+to\b|failure\s*[:\-])[^.]{0,120}/i);
  if (failure) {
    return { ok: false, confirmed: true, reason: `import reported: ${failure[0].trim().slice(0, 120)}`, preview };
  }

  // Check this BEFORE any generic wording scan. The page's own tab labels are
  // "Successful | Error | Pending", so "Error" appears as visible text on a perfectly
  // normal render and a keyword scan would call every response a failure.
  // Struts re-renders this page for a POST it did not act on; getting it back with no
  // batch number is a definite "not processed", not an ambiguous result.
  if (/failedGridTab|successGridTab|genricSearchGrid/i.test(raw)
    || /Update\s*Price\s*\/?\s*Inventory/i.test(text)) {
    return {
      ok: false,
      confirmed: true,
      notProcessed: true,
      reason: 'Vinculum returned the Update Price/Inventory page without creating an import batch, so the file was not processed. The upload request shape needs to be captured from a manual import.',
      preview,
    };
  }

  if (/(uploaded successfully|imported successfully|records? processed|success)/i.test(text)) {
    return { ok: true, confirmed: true, reason: 'import confirmed', preview };
  }

  return {
    ok: false,
    confirmed: false,
    reason: 'upload accepted but Vinculum did not confirm the import. Check Update Price/Inventory in the portal before trusting the stock levels.',
    preview,
  };
}

export function mapOrderRow(row) {
  const p = (n) => row?.[`param${n}`] ?? row?.[`PARAM${n}`] ?? '';
  const webOrderNo = String(p(1) || '').trim();
  const qty = Number(p(8) || p(25) || p(26) || 1) || 1;
  const price = Number(p(9) || p(10) || 0) || 0;
  const payment = String(p(6) || '').toUpperCase();
  return {
    webOrderNo,
    orderDate: String(p(2) || '').trim(),
    productName: String(p(5) || '').trim(),
    payment,
    cashOnDelivery: payment.includes('COD'),
    qty,
    price,
    status: String(p(11) || p(22) || '').trim(),
    hcSku: String(p(12) || '').trim(),
    seller: String(p(13) || '').trim(),
    channel: String(p(21) || '').trim(),
    raw: row,
  };
}

export function makeVinculumClient(cfg = {}) {
  const baseUrl = String(cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const userName = String(cfg.userName || cfg.user || '');
  const password = String(cfg.password || cfg.pass || '');
  const jar = new Map();
  let loggedIn = false;

  async function raw(path, { method = 'GET', body, headers = {}, form } = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}/${path.replace(/^\//, '')}`;
    const h = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/149 Safari/537.36',
      ...headers,
    };
    if (jar.size) h.Cookie = cookieHeader(jar);
    let payload = body;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString();
    }
    const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
    mergeJar(jar, res.headers.getSetCookie?.() || res.headers.get('set-cookie'));
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        const next = loc.startsWith('http') ? loc : `${baseUrl}/${loc.replace(/^\//, '')}`;
        return raw(next, { method: 'GET', headers });
      }
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url: res.url || url };
  }

  async function login() {
    if (!userName || !password) throw new Error('VINCULUM_USER / VINCULUM_PASS required');
    jar.clear();
    const loginPage = await raw('sellerPanalLogin.action');
    const pem = extractPublicKeyPem(loginPage.text);
    const enc = encryptPasswordRsaPkcs1(password, pem);
    const jsid = jar.get('JSESSIONID');
    const actionPath = jsid
      ? `sellerPanalHomeAction.action;jsessionid=${jsid}`
      : 'sellerPanalHomeAction.action';
    // Minimal payload, matches the June 2026 proven curl (userName + encrypted password only).
    const home = await raw(actionPath, {
      method: 'POST',
      headers: { Referer: `${baseUrl}/sellerPanalLogin.action` },
      form: { userName, password: enc },
    });
    if (/Invalid Login Credentials/i.test(home.text) || /Login Failed/i.test(home.text)) {
      throw new Error('Vinculum login failed: Invalid Login Credentials (check user/password in browser first)');
    }
    if (!/Welcome to Vin Seller Panel/i.test(home.text)) {
      throw new Error(`Vinculum login failed: expected Welcome page, got title "${(/<title>([^<]+)/i.exec(home.text)?.[1] || '').trim()}"`);
    }
    loggedIn = true;
    return { ok: true };
  }

  async function ensureLogin() {
    if (!loggedIn) await login();
  }

  async function commonJsonSearch({ key = 'SPACTIVEODRPKIT', page = 1, rows = 100, vnfDataString = '{}' } = {}) {
    await ensureLogin();
    const form = {
      key,
      REQ_SEARCH_FLAG: 'true',
      vnfDataString: typeof vnfDataString === 'string' ? vnfDataString : JSON.stringify(vnfDataString),
      _search: 'false',
      rows: String(rows),
      page: String(page),
      sidx: '',
      sord: 'asc',
    };
    const r = await raw('commonJsonSearch.action', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${baseUrl}/sellerPanelActiveOrderDisplayBS.action`,
      },
      form,
    });
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      loggedIn = false;
      await login();
      const r2 = await raw('commonJsonSearch.action', {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        form,
      });
      json = JSON.parse(r2.text);
    }
    if (json?.jsonMessage && /invalid session/i.test(json.jsonMessage)) {
      loggedIn = false;
      throw new Error(`Vinculum session invalid: ${json.jsonMessage}`);
    }
    // Active/empty searches return null; some grids return an object map instead of Array.
    const rawList = json.commonSearchDTOList ?? json.rows ?? [];
    const list = Array.isArray(rawList)
      ? rawList
      : (rawList && typeof rawList === 'object' ? Object.values(rawList) : []);
    return {
      records: json.records ?? list.length,
      total: json.total ?? 1,
      page: json.page ?? page,
      orders: list.map(mapOrderRow).filter((o) => o.webOrderNo),
      raw: json,
    };
  }

  /** Download Update Pricing & Inventory import template (xlsx). */
  async function downloadInventoryTemplate() {
    return getBinary('sellerSkuImportDisplayDownloadImportTemplateBS.action', {});
  }

  /**
   * List seller SKUs from Vinculum SKU Enquiry grid (sellerSkuListBS → jsonSellerSkuEnqBS).
   * Filter with vendorCode (= #seller / vinf:param4). For OppDoor UAE this is the
   * Vinculum login user id (e.g. 2424675), NOT HC_SELLER_CODE_UAE=75 and NOT archive LAND*.
   */
  async function listSellerSkus({
    vendorCode = userName,
    page = 1,
    rows = 100,
    mSku = '',
    skuCode = '',
    upc = '',
    skuName = '',
  } = {}) {
    await ensureLogin();
    const form = {
      rows: String(rows),
      page: String(page),
      _search: 'false',
      sidx: '',
      sord: 'asc',
      REQ_SEARCH_FLAG: 'true',
      skuName: skuName || '',
      upc: upc || '',
      brands: '',
      status: '',
      hCode: '',
      mSku: mSku || '',
      skuCode: skuCode || '',
      stkStatus: '',
      webStatus1: '',
      vendorCode: String(vendorCode || userName || ''),
      selectLoc: '',
      edit: 'false',
    };
    const r = await raw('jsonSellerSkuEnqBS.action', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${baseUrl}/sellerSkuListBS.action`,
      },
      form,
    });
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      throw new Error(`Vinculum jsonSellerSkuEnqBS: non-JSON (${r.status})`);
    }
    const gm = json.gridModel;
    const list = Array.isArray(gm) ? gm : (gm && typeof gm === 'object' ? Object.values(gm) : []);
    return {
      records: Number(json.records) || list.length,
      total: Number(json.total) || 1,
      page: Number(json.page) || page,
      skus: list.map((row) => ({
        mrktSku: String(row.mrktSku || '').trim(),
        skuCode: String(row.skuCode || '').trim(),
        mfgSku: String(row.mfgSku || '').trim(),
        isbn: String(row.ISBN || row.isbn || '').trim(),
        udf1: String(row.udf1 || '').trim(),
        qty: Number(row.qty || 0) || 0,
        whQty: Number(row.whQTY || row.whQty || 0) || 0,
        mrp: row.mrp ?? '',
        salePrice: row.salePrice ?? '',
        sellerCode: String(row.sellerCode || '').trim(),
        sellerName: String(row.sellerName || '').trim(),
        skuShortName: String(row.skuShortName || '').trim(),
        status: String(row.status || '').trim(),
        webStatus: String(row.webStatus || '').trim(),
        skuSize: String(row.skuSize || '').trim(),
        skuColor: String(row.skuColor || '').trim(),
        raw: row,
      })),
    };
  }

  /** Paginate listSellerSkus until all records fetched (deduped by mrktSku|skuCode). */
  async function listAllSellerSkus(opts = {}) {
    const rows = Number(opts.rows) || 100;
    const first = await listSellerSkus({ ...opts, page: 1, rows });
    const pages = Math.max(1, Math.ceil((first.records || 0) / rows));
    const out = [...first.skus];
    for (let p = 2; p <= pages; p++) {
      const page = await listSellerSkus({ ...opts, page: p, rows });
      out.push(...page.skus);
    }
    const seen = new Set();
    const skus = out.filter((s) => {
      const k = `${s.mrktSku}|${s.skuCode}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { records: first.records, skus, vendorCode: String(opts.vendorCode || userName || '') };
  }

  /**
   * Upload inventory/price xlsx to Vinculum (LIVE write, caller must gate).
   * Form field name from sellerPriceUpdateBS: importFileName.
   */
  /**
   * Upload the filled inventory xlsx.
   *
   * The shape here is copied from the page's own Import handler, not guessed:
   *
   *   $("#importFileNameTemp").val($('#importFileName').val().split('\\').pop());
   *   document.sellerSkuImportForm.action = "sellerSkuImportBS?importFlag=I";
   *   document.sellerSkuImportForm.submit();
   *
   * Two details matter and both were wrong before. The URL has NO `.action` suffix
   * (Struts maps the bare name), and `importFileNameTemp` carries the bare filename
   * alongside the file itself. Posting to `sellerSkuImportBS.action?importFlag=I`
   * returned the page with a 200 and silently imported nothing.
   */
  async function uploadInventoryWorkbook(buffer, filename = 'hc-inventory.xlsx') {
    await ensureLogin();
    const url = `${baseUrl}/sellerSkuImportBS?importFlag=I`;
    const form = new FormData();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    form.append('importFileName', blob, filename);
    // The page sends the basename it stripped off the fake C:\\fakepath\\ prefix.
    form.append('importFileNameTemp', filename);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(jar),
        'User-Agent': 'Mozilla/5.0 Chrome/149',
        Referer: `${baseUrl}/sellerSkuImportBS.action`,
      },
      body: form,
      redirect: 'follow',
    });
    mergeJar(jar, res.headers.getSetCookie?.() || res.headers.get('set-cookie'));
    const text = await res.text();
    return { ...classifyImportResponse(res.status, text), status: res.status };
  }

  /**
   * Read back what an import actually did. This is the request behind the
   * Successful / Error / Pending tabs (`jsonSkuImportResultBS`), so it is the portal's
   * own record rather than our inference from an HTML page.
   *
   * @param {string} batchId empty string asks for the most recent batch, which is what
   *   the page itself sends on load.
   */
  async function getImportResult(batchId = '') {
    await ensureLogin();
    const r = await raw('jsonSkuImportResultBS', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${baseUrl}/sellerSkuImportBS.action`,
      },
      form: { batchId: String(batchId || '') },
    });
    let json = null;
    try { json = JSON.parse(r.text); } catch { /* not json */ }
    if (!json) {
      return { ok: false, status: r.status, error: 'import result was not JSON', preview: r.text.slice(0, 300) };
    }
    const pick = (...keys) => keys.map((k) => json[k]).find((v) => Array.isArray(v)) || [];
    const success = pick('successList', 'successRecords', 'success');
    const failed = pick('failedList', 'errorList', 'failedRecords', 'failed');
    const pending = pick('pendingList', 'pendingRecords', 'pending');
    return {
      ok: true,
      batchId: json.batchId || batchId || null,
      counts: { success: success.length, failed: failed.length, pending: pending.length },
      failed: failed.slice(0, 25),
      raw: json,
    };
  }

  async function listActiveOrders(opts = {}) {
    return commonJsonSearch({ key: 'SPACTIVEODRPKIT', ...opts });
  }

  async function listArchiveOrders(opts = {}) {
    return commonJsonSearch({ key: 'SPARCHIVEODRLST', ...opts });
  }

  async function postAction(actionPath, form) {
    await ensureLogin();
    return raw(actionPath, { method: 'POST', form });
  }

  async function getBinary(actionPath, form) {
    await ensureLogin();
    const url = `${baseUrl}/${actionPath.replace(/^\//, '')}`;
    const h = {
      Cookie: cookieHeader(jar),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 Chrome/149',
    };
    const res = await fetch(url, {
      method: form ? 'POST' : 'GET',
      headers: h,
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    mergeJar(jar, res.headers.getSetCookie?.() || res.headers.get('set-cookie'));
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: buf };
  }

  return {
    login,
    listActiveOrders,
    listArchiveOrders,
    commonJsonSearch,
    postAction,
    getBinary,
    downloadInventoryTemplate,
    listSellerSkus,
    listAllSellerSkus,
    uploadInventoryWorkbook,
    getImportResult,
    mapOrderRow,
    get cookieJar() { return cookieHeader(jar); },
    get isLoggedIn() { return loggedIn; },
  };
}
