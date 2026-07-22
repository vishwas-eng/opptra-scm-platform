/* Opptra SCM Platform — sidebar SPA (plain ES2020, no build). */
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_TITLES = { dashboard: 'Dashboard', return: 'Return Flow', ewaybill: 'E-way Bill', inventory: 'Inward / Outward', extensions: 'Extensions', admin: 'Admin' };
  let me = null;
  let pollTimer = null;
  let ucLoginUrl = null;

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401) { showLogin(); throw new Error('signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ---------------- auth ---------------- */
  async function showLogin() {
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const { googleClientId } = await api('/api/config');
    const mount = () => {
      window.google.accounts.id.initialize({ client_id: googleClientId, callback: onCredential });
      window.google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_black', size: 'large', width: 300 });
    };
    if (window.google?.accounts?.id) mount();
    else window.addEventListener('load', mount, { once: true });
  }

  async function onCredential(resp) {
    try {
      const { user } = await api('/auth/google', { body: { credential: resp.credential } });
      me = user;
      showApp();
    } catch (err) {
      const el = $('login-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  }

  async function boot() {
    try {
      const { user } = await api('/api/me');
      me = user;
      showApp();
    } catch { /* 401 already routed to login */ }
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = me.name || me.email;
    $('user-role').textContent = me.role;
    $('user-pic').src = me.picture || '';
    if (me.role === 'admin') $('admin-nav-btn').classList.remove('hidden');
    go('dashboard');
    refreshDashboard();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshDashboard, 10_000);
  }

  $('logout-btn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  });

  /* ---------------- sidebar routing ---------------- */
  function go(tab) {
    document.querySelectorAll('#side-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
    $('tab-' + tab).classList.remove('hidden');
    $('page-title').textContent = PAGE_TITLES[tab] || tab;
    if (tab === 'admin') loadAdmin();
  }
  document.querySelectorAll('#side-nav button').forEach((btn) => {
    btn.addEventListener('click', () => { if (!btn.disabled) go(btn.dataset.tab); });
  });

  /* ---------------- re-login flow ---------------- */
  async function openUcLogin() {
    if (!ucLoginUrl) {
      try { ucLoginUrl = (await api('/api/admin/uc-login-url')).url; } catch { ucLoginUrl = null; }
    }
    if (ucLoginUrl) window.open(ucLoginUrl, '_blank', 'noopener');
  }
  $('dash-relogin-btn').addEventListener('click', openUcLogin);
  $('admin-relogin-btn')?.addEventListener('click', openUcLogin);

  /* ---------------- dashboard ---------------- */
  async function refreshDashboard() {
    try {
      const s = await api('/api/uc-session');
      renderSession(s);
      const { runs } = await api('/api/runs?limit=30');
      $('runs-table').querySelector('tbody').innerHTML = runs.map(runRow).join('');
    } catch { /* transient */ }
  }

  function renderSession(s) {
    const cls = s.status === 'alive' ? 'ok' : s.status === 'dead' ? 'bad' : 'warn';
    const el = $('session-status');
    el.className = 'big ' + cls;
    el.textContent = (s.status || 'unknown').toUpperCase();
    $('session-meta').textContent =
      `source: ${s.source} · last OK: ${fmt(s.last_ok_at)}` + (s.fail_count ? ` · fails: ${s.fail_count}` : '');
    $('side-session').innerHTML = `session <b>${(s.status || '?').toUpperCase()}</b>`;

    const needs = s.needs_relogin || s.status === 'dead' || !s.has_cookie;
    $('dash-relogin-btn').classList.toggle('hidden', !needs);
    const banner = $('relogin-banner');
    if (needs) {
      banner.innerHTML = `⚠ Unicommerce session needs a re-login — automations are paused.
        ${me.role === 'admin' ? '<button id="banner-relogin">Re-login now</button>' : 'Ask an admin to re-login.'}`;
      banner.classList.remove('hidden');
      $('banner-relogin')?.addEventListener('click', openUcLogin);
    } else {
      banner.classList.add('hidden');
    }
  }

  const runRow = (r) => `
    <tr>
      <td>${fmt(r.created_at)}</td>
      <td>${esc(r.user_email)}</td>
      <td>${esc(r.automation)}</td>
      <td>${esc(r.action)}</td>
      <td><code>${esc(shortInput(r.input))}</code></td>
      <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
    </tr>`;

  /* ----------------------------------------------------------------------
   * runJob — the ONE async-action flow every automation tab shares:
   *   validate → enqueue → poll → render result. Handles the button spinner,
   *   the live "working…" state, errors (toast), and final rendering.
   * Callers supply: { btn, out, validate, submit, render }.
   * -------------------------------------------------------------------- */
  async function runJob({ btn, out, validate, submit, render, working = 'Working…' }) {
    const err = validate?.();
    if (err) { toast(err, 'bad'); return; }
    setLoading(btn, true);
    out.classList.remove('hidden');
    out.innerHTML = `<div class="result-head"><span class="badge info">running</span><span class="title">${esc(working)}</span></div>`;
    try {
      const { runUid, ...immediate } = await submit();
      const run = runUid ? await pollRun(runUid, out) : { status: 'succeeded', result: immediate };
      out.innerHTML = render(run.result ?? run, run);
      wireRaw(out);
      if (run.status === 'failed') toast('Job failed — see the result panel.', 'bad');
    } catch (e) {
      out.innerHTML = `<div class="result-head"><span class="badge bad">error</span><span class="title">${esc(e.message)}</span></div>`;
      toast(e.message, 'bad');
    } finally {
      setLoading(btn, false);
    }
  }

  async function pollRun(runUid, out, timeoutMs = 10 * 60_000) {
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      const run = await api('/api/runs/' + runUid);
      if (['succeeded', 'failed'].includes(run.status)) return run;
      if (run.status === 'pending_retry') {
        out.innerHTML = `<div class="result-head"><span class="badge warn">retrying</span>
          <span class="title">Unicommerce async step — auto-retrying…</span></div>
          ${run.result ? stepChips(run.result.steps) : ''}`;
      }
      if (Date.now() - t0 > timeoutMs) return run;
    }
  }

  /* ---------------- return tab ---------------- */
  $('ret-status-btn').addEventListener('click', () => runReturn('status'));
  $('ret-run-btn').addEventListener('click', () => runReturn('process'));

  function runReturn(kind) {
    const so = $('ret-so').value.trim();
    return runJob({
      btn: kind === 'status' ? $('ret-status-btn') : $('ret-run-btn'),
      out: $('ret-output'),
      working: kind === 'status' ? 'Checking SO status…' : 'Processing — the worker may take a few minutes…',
      validate: () => (!so ? 'Enter a Sale Order code.' : null),
      submit: () => kind === 'status'
        ? api('/api/automations/uc/so-status', { body: { saleOrder: so } })
        : api('/api/automations/return/process', {
            body: { saleOrder: so, cancelSO: $('ret-cancel').value.trim() || null, returnIn: $('ret-return-in').checked, deliver: $('ret-deliver').checked },
          }),
      render: (r) => renderReturn(r, kind),
    });
  }

  /* ---------------- e-way bill tab ---------------- */
  $('ewb-run-btn')?.addEventListener('click', () => {
    const sos = $('ewb-sos').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const gstin = $('ewb-gstin').value.trim();
    const dryRun = $('ewb-dry').checked;
    const rows = sos.map((so) => ({
      so, gstin, transporterName: $('ewb-tname').value.trim(), transMode: $('ewb-mode').value.trim(),
      vehicleType: $('ewb-vtype').value.trim(), vehicleNo: $('ewb-vno').value.trim(), distance: $('ewb-dist').value.trim(),
    }));
    return runJob({
      btn: $('ewb-run-btn'), out: $('ewb-output'),
      working: dryRun ? 'Previewing (no e-way bills created)…' : 'Generating e-way bills…',
      validate: () => (!sos.length ? 'Enter at least one SO number.'
        : gstin && gstin.length !== 15 ? 'GSTIN must be exactly 15 characters (or leave it blank).' : null),
      submit: () => api('/api/automations/ewaybill/generate', { body: { dryRun, rows } }),
      render: (r) => renderBatch(r, 'E-way bill'),
    });
  });

  /* ---------------- inward/outward/full-cycle tab ---------------- */
  document.querySelectorAll('input[name="inv-op"]').forEach((r) => r.addEventListener('change', () => {
    const op = document.querySelector('input[name="inv-op"]:checked').value;
    $('inv-outward-fields').classList.toggle('hidden', op === 'inward');
  }));

  function parseItems(text) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [sku, qty, unitPrice, sellingPrice] = l.split(/[,\t]/).map((x) => x.trim());
      const item = { sku, quantity: Number(qty || 1) };
      if (unitPrice) item.unitPrice = Number(unitPrice);
      if (sellingPrice) item.sellingPrice = Number(sellingPrice);
      return item;
    });
  }

  $('inv-run-btn')?.addEventListener('click', () => {
    const op = document.querySelector('input[name="inv-op"]:checked').value;
    const items = parseItems($('inv-items').value);
    const body = { items };
    if (op !== 'inward') {
      if ($('inv-order').value.trim()) body.orderCode = $('inv-order').value.trim();
      if ($('inv-cust').value.trim()) body.customerName = $('inv-cust').value.trim();
    }
    return runJob({
      btn: $('inv-run-btn'), out: $('inv-output'), working: `Running ${op}…`,
      validate: () => (!items.length || items.some((i) => !i.sku) ? 'Enter at least one line: SKU, qty, unitPrice[, sellingPrice]' : null),
      submit: () => api('/api/automations/' + op, { body }),
      render: (r) => renderInventory(r, op),
    });
  });

  /* ---------------- admin ---------------- */
  $('admin-cookie-btn')?.addEventListener('click', async () => {
    const v = $('admin-cookie').value.trim();
    const msg = $('admin-cookie-msg');
    if (!v) { msg.textContent = 'Paste a JSESSIONID first.'; return; }
    try {
      await api('/api/admin/uc-session', { body: { jsessionid: v } });
      msg.textContent = '';
      $('admin-cookie').value = '';
      toast('Session saved — next call uses it.', 'ok');
      refreshDashboard();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('token-create-btn')?.addEventListener('click', async () => {
    try {
      const { token } = await api('/api/admin/ingest-tokens', { body: { label: 'helper' } });
      const out = $('token-out');
      out.classList.remove('hidden');
      out.textContent = 'Copy this token into the Session Helper extension now (shown once):\n\n' + token;
      toast('Token created — copy it now, it won\'t be shown again.', 'ok', 8000);
      loadTokens();
    } catch (err) { toast(err.message, 'bad'); }
  });

  async function loadTokens() {
    try {
      const { tokens } = await api('/api/admin/ingest-tokens');
      $('tokens-table').querySelector('tbody').innerHTML = tokens.map((t) => `
        <tr>
          <td>${esc(t.label)}</td><td>${esc(t.owner_email)}</td>
          <td>${fmt(t.created_at)}</td><td>${fmt(t.last_used)}</td>
          <td>${t.revoked ? '<span class="meta">revoked</span>' : `<button class="link-btn" data-revoke="${t.id}">revoke</button>`}</td>
        </tr>`).join('');
      document.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
        await api('/api/admin/ingest-tokens/' + b.dataset.revoke, { method: 'DELETE' });
        loadTokens();
      }));
    } catch { /* non-admin */ }
  }

  async function loadAdmin() {
    if (me.role !== 'admin') return;
    loadTokens();
    // session detail
    try {
      const s = await api('/api/uc-session');
      $('admin-session-meta').innerHTML = `Status: <b>${(s.status || '?').toUpperCase()}</b> · source: ${esc(s.source)} · last OK: ${fmt(s.last_ok_at)}` +
        (s.needs_relogin ? ` · <span class="error">re-login needed since ${fmt(s.relogin_since)}</span>` : '');
    } catch {}
    // analytics
    try {
      const a = await api('/api/admin/analytics');
      const t = a.totals || {};
      $('analytics-cards').innerHTML = `
        ${statCard('Succeeded', t.succeeded || 0, 'ok')}
        ${statCard('Failed', t.failed || 0, 'bad')}
        ${statCard('In flight', (a.inflight.queued + a.inflight.running + a.inflight.pending) || 0, 'warn')}
        ${statCard('Session', (a.session.status || '?').toUpperCase(), a.session.status === 'alive' ? 'ok' : 'bad')}`;
      $('autom-table').querySelector('tbody').innerHTML = a.byAutomation.map((r) => `
        <tr><td>${esc(r.automation)}</td><td>${r.total}</td><td>${r.ok}</td><td>${r.failed}</td><td>${r.active}</td></tr>`).join('') || emptyRow(5);
      $('user-usage-table').querySelector('tbody').innerHTML = a.byUser.map((r) => `
        <tr><td>${esc(r.user_email)}</td><td>${r.total}</td><td>${r.ok}</td><td>${r.failed}</td></tr>`).join('') || emptyRow(4);
      $('errors-table').querySelector('tbody').innerHTML = a.recentErrors.map((r) => `
        <tr><td>${fmt(r.finished_at)}</td><td>${esc(r.user_email)}</td><td>${esc(r.automation)}</td>
        <td><code>${esc(shortInput(r.input))}</code></td><td>${esc((r.error || '').slice(0, 120))}</td></tr>`).join('') || emptyRow(5);
    } catch {}
    // users
    try {
      const { users } = await api('/api/admin/users');
      $('users-table').querySelector('tbody').innerHTML = users.map((u) => `
        <tr>
          <td>${esc(u.email)}</td><td>${esc(u.name)}</td>
          <td><select data-email="${esc(u.email)}" class="role-select">
            ${['admin', 'ops', 'viewer'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select></td>
          <td>${u.is_active ? '✓' : '✗'}</td><td>${fmt(u.last_login)}</td>
        </tr>`).join('');
      document.querySelectorAll('.role-select').forEach((sel) => sel.addEventListener('change', async () => {
        try { await api('/api/admin/users/' + encodeURIComponent(sel.dataset.email), { body: { role: sel.value } }); toast(`Role updated for ${sel.dataset.email}.`, 'ok'); }
        catch (err) { toast(err.message, 'bad'); loadAdmin(); }
      }));
    } catch {}
  }

  /* ---------------- result renderers ---------------- */
  // A run's outcome → clean HTML. Each automation shows the fields that matter,
  // a step timeline, and a collapsible raw view — never a bare JSON dump.
  function resultHead(ok, title, extra = '') {
    const badge = ok === true ? '<span class="badge ok">success</span>'
      : ok === false ? '<span class="badge bad">failed</span>'
      : '<span class="badge info">done</span>';
    return `<div class="result-head">${badge}<span class="title">${esc(title)}</span>${extra}</div>`;
  }
  const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>`;
  function stepChips(steps) {
    if (!steps || typeof steps !== 'object') return '';
    const chips = Object.entries(steps).map(([k, v]) =>
      `<span class="step-chip done"><b>${esc(k)}</b>${v && v !== 'ok' ? ' · ' + esc(String(v).slice(0, 28)) : ''}</span>`).join('');
    return chips ? `<div class="steps-flow">${chips}</div>` : '';
  }
  const raw = (obj) => `<details class="raw"><summary>Raw response</summary><pre class="output">${esc(JSON.stringify(obj, null, 2))}</pre></details>`;

  function renderReturn(r, kind) {
    if (kind === 'status') {
      return resultHead(null, 'SO status')
        + kv([['Status', r.status], ['Package', r.pkg], ['Package status', r.pkgStatus], ['Invoice', r.invoice], ['Tracking', r.tracking]])
        + raw(r);
    }
    const ok = r.ok === true;
    return resultHead(ok, ok ? `Processed ${r.saleOrder}` : (r.error || 'Did not complete'))
      + kv([['Sale order', r.saleOrder], ['Package', r.shippingPackage], ['Invoice', r.invoiceCode], ['Tracking', r.tracking], ['Package status', r.pkgStatus]])
      + stepChips(r.steps)
      + (r.pending ? `<p class="result-note">Still working through an async step — this may finish on a later retry.</p>` : '')
      + raw(r);
  }

  function renderBatch(r, label) {
    const items = r.results || [];
    const head = resultHead(r.failed === 0, `${label}: ${r.ok ?? 0} ok · ${r.failed ?? 0} failed`);
    const list = items.map((x) => {
      const line = x.skipped ? `already had EWB ${x.ewb}`
        : x.dryRun ? `would generate · invoice ${x.invoiceCode}`
        : x.ewb ? `EWB ${x.ewb}` : (x.error || '—');
      return `<li class="${x.ok ? 'ok' : 'bad'}"><span class="so">${esc(x.so)}</span><span>${esc(line)}</span></li>`;
    }).join('');
    return head + `<ul class="result-list">${list}</ul>` + raw(r);
  }

  function renderInventory(r, op) {
    if (op === 'fullcycle') {
      const ok = r.status === 'FULLCYCLE_DONE';
      return resultHead(ok, ok ? 'Full cycle complete' : 'Outward failed after inward')
        + `<div class="steps-flow"><span class="step-chip done"><b>inward</b> · ${esc(r.inward?.status || '—')}</span>
           <span class="step-chip ${r.outward ? 'done' : ''}"><b>outward</b> · ${esc(r.outward?.status || r.outwardError || 'failed')}</span></div>`
        + kv([['PO', r.inward?.poCode], ['GRN', r.inward?.grnCode], ['Put-away', r.inward?.putawayCode],
              ['Sale order', r.outward?.soCode], ['Invoices', (r.outward?.invoices || []).map((i) => i.invoiceCode).join(', ')]])
        + raw(r);
    }
    const ok = r.status === 'INWARD_DONE' || r.status === 'OUTWARD_DONE';
    const pairs = op === 'inward'
      ? [['Mode', r.mode], ['PO', r.poCode], ['GRN', r.grnCode], ['Put-away', r.putawayCode]]
      : [['Sale order', r.soCode], ['Packages', (r.shippingPackages || []).join(', ')], ['Invoices', (r.invoices || []).map((i) => i.invoiceCode).join(', ')]];
    const inv = r.inventory ? kv(Object.entries(r.inventory).map(([sku, q]) => [sku, q])) : '';
    return resultHead(ok, ok ? `${op[0].toUpperCase() + op.slice(1)} complete` : (r.status || 'Incomplete'))
      + kv(pairs) + (inv ? `<p class="result-note">Inventory now:</p>${inv}` : '') + raw(r);
  }

  /* ---------------- UI primitives ---------------- */
  function setLoading(btn, on) { if (btn) { btn.classList.toggle('loading', on); btn.disabled = on; } }
  function wireRaw() { /* <details> is native; hook kept for future interactivity */ }

  let toastSeq = 0;
  function toast(message, type = 'info', ms = 5000) {
    const id = 'toast-' + (++toastSeq);
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.id = id;
    el.innerHTML = `<span>${esc(message)}</span><span class="x">×</span>`;
    el.querySelector('.x').addEventListener('click', () => el.remove());
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /* ---------------- helpers ---------------- */
  const statCard = (label, val, cls) => `<div class="card"><h3>${label}</h3><div class="big ${cls}">${esc(String(val))}</div></div>`;
  const emptyRow = (cols) => `<tr><td colspan="${cols}" class="empty">No data yet.</td></tr>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const shortInput = (input) => {
    if (!input) return '';
    try { const o = typeof input === 'string' ? JSON.parse(input) : input; return o.saleOrder || o.code || JSON.stringify(o).slice(0, 40); }
    catch { return ''; }
  };

  boot();
})();
