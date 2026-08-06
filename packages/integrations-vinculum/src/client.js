// Vinculum VIN eRetail (Home Centre seller portal) — Node client.
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
  // Page embeds the key in a JS template literal with leading tabs/spaces per line — strip them.
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
    // Minimal payload — matches the June 2026 proven curl (userName + encrypted password only).
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
   * Upload inventory/price xlsx to Vinculum (LIVE write — caller must gate).
   * Form field name from sellerPriceUpdateBS: importFileName.
   */
  async function uploadInventoryWorkbook(buffer, filename = 'hc-inventory.xlsx') {
    await ensureLogin();
    const url = `${baseUrl}/sellerSkuImportBS.action?importFlag=I`;
    const form = new FormData();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    form.append('importFileName', blob, filename);
    const h = {
      Cookie: cookieHeader(jar),
      'User-Agent': 'Mozilla/5.0 Chrome/149',
      Referer: `${baseUrl}/sellerPriceUpdateBS.action`,
    };
    const res = await fetch(url, { method: 'POST', headers: h, body: form });
    mergeJar(jar, res.headers.getSetCookie?.() || res.headers.get('set-cookie'));
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 400 && !/Invalid Login|Login Failed/i.test(text);
    return { ok, status: res.status, preview: text.slice(0, 400) };
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
    mapOrderRow,
    get cookieJar() { return cookieHeader(jar); },
    get isLoggedIn() { return loggedIn; },
  };
}
