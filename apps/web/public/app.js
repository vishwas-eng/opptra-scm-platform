/* Opptra SCM Platform, sidebar SPA (plain ES2020, no build). */
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_TITLES = { dashboard: 'Dashboard', return: 'Return Flow', ewaybill: 'E-way Bill', inventory: 'Inward / Outward', asn: 'ASN Compile', reversedc: 'Reverse DC', sheet: 'Sheet Update', packing: 'Packing Mail', extensions: 'Extensions', admin: 'Admin' };
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
    const { googleClientId, devLogin } = await api('/api/config');
    if (devLogin) {
      const btn = $('dev-login-btn');
      btn.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        try { const { user } = await api('/auth/dev-login', { method: 'POST', body: {} }); me = user; showApp(); }
        catch (err) { const el = $('login-error'); el.textContent = err.message; el.classList.remove('hidden'); }
      }, { once: true });
    }
    const showGsiError = (msg) => { const el = $('login-error'); el.textContent = msg; el.classList.remove('hidden'); };
    const mount = () => {
      if (!googleClientId) return;
      if (!window.google?.accounts?.id) { showGsiError('Google Sign-In failed to load (blocked by an ad blocker, extension, or network policy?). Try disabling blockers for this site, or use a different browser.'); return; }
      try {
        // use_fedcm_for_prompt: current Chrome increasingly requires FedCM for GIS: without
        // it the button can silently fail (a blank popup, or nothing happening at all) once
        // third-party cookies are blocked - which is now Chrome's default.
        window.google.accounts.id.initialize({ client_id: googleClientId, callback: onCredential, use_fedcm_for_prompt: true, itp_support: true });
        window.google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_black', size: 'large', width: 300 });
      } catch (err) {
        showGsiError('Google Sign-In failed to initialize: ' + err.message);
      }
    };
    if (window.google?.accounts?.id) mount();
    else {
      window.addEventListener('load', mount, { once: true });
      // The gsi/client <script> can fail outright (network block) with no 'load' event ever
      // firing for our listener above - don't leave the button silently non-functional.
      setTimeout(() => { if (!window.google?.accounts?.id) showGsiError('Google Sign-In is taking too long to load. Check your connection, or try a different network/browser.'); }, 6000);
    }
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
    // Landing back from /auth/google/callback (Connect Gmail / shared Workspace).
    const params = new URLSearchParams(location.search);
    const googleConnect = params.get('googleConnect');
    const landTab = params.get('tab');
    if (googleConnect !== null) {
      history.replaceState(null, '', location.pathname);
      if (googleConnect === 'ok') toast(landTab === 'packing' ? 'Your Gmail is connected for Packing Mail.' : 'Google Workspace connected.', 'ok');
      else toast('Google Workspace connection failed: ' + (googleConnect || 'unknown error'), 'bad', 8000);
      if (landTab) setTimeout(() => go(landTab), 0);
    }
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = me.name || me.email;
    $('user-role').textContent = me.role;
    $('user-pic').src = me.picture || '';
    if (me.role === 'admin') $('admin-nav-btn').classList.remove('hidden');
    // Role-aware chrome: admin-only surfaces (technical cards, raw details, the everyone
    // feed) show only for admins; users get their own activity in plain words.
    document.body.classList.toggle('is-admin', me.role === 'admin');
    $('runs-table').classList.toggle('mine', me.role !== 'admin');
    $('runs-lead').textContent = me.role === 'admin' ? 'Latest runs across all users · refreshes automatically.' : 'Your latest runs · refreshes automatically.';
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
    if (tab === 'sheet') loadSheetLink();
    if (tab === 'packing') loadPackingGmail();
    if (tab === 'reversedc') loadRdcFacilities();
  }

  let sheetLinkLoaded = false;
  async function loadSheetLink() {
    if (sheetLinkLoaded) return;
    try {
      const { masterSheetUrl, masterSheetPreviewUrl } = await api('/api/integrations');
      if (!masterSheetUrl) return;
      sheetLinkLoaded = true;
      $('sheet-open-link').href = masterSheetUrl;
      $('sheet-preview-frame').src = masterSheetPreviewUrl;
      $('sheet-link').classList.remove('hidden');
    } catch { /* not configured yet - leave the panel hidden */ }
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
      const [s, stats, { runs }] = await Promise.all([
        api('/api/uc-session'), api('/api/dashboard'), api('/api/runs?limit=30'),
      ]);
      renderSession(s);
      $('inflight-count').textContent = stats.inflight;
      $('week-count').textContent = stats.week.total;
      $('week-breakdown').textContent = `${stats.week.succeeded} ok · ${stats.week.failed} failed`;
      const tbody = $('runs-table').querySelector('tbody');
      tbody.innerHTML = runs.length ? runs.map(runRow).join('') : emptyRow(6);
    } catch { /* transient, next poll retries */ }
  }

  function renderSession(s) {
    const alive = s.status === 'alive';
    const needs = s.needs_relogin || s.status === 'dead' || !s.has_cookie;

    // Topbar pill - the ONE status surface everyone sees. Plain words, no jargon.
    const pill = $('health-pill');
    pill.className = 'health-pill ' + (alive ? 'ok' : needs ? 'bad' : 'warn');
    $('health-pill-text').textContent = alive ? 'All systems working' : needs ? 'Needs attention' : 'Checking…';
    $('side-session').innerHTML = alive ? 'All systems working' : needs ? 'Needs attention' : '…';

    // Technical connection card - admins only (hidden by CSS for everyone else).
    const el = $('session-status');
    el.className = 'big ' + (alive ? 'ok' : needs ? 'bad' : 'warn');
    el.textContent = alive ? 'CONNECTED' : needs ? 'DISCONNECTED' : 'CHECKING';
    $('session-meta').textContent =
      `source: ${s.source} · last OK: ${fmt(s.last_ok_at)}` + (s.fail_count ? ` · fails: ${s.fail_count}` : '');
    $('dash-relogin-btn').classList.toggle('hidden', !needs);

    const banner = $('relogin-banner');
    if (needs) {
      banner.innerHTML = me.role === 'admin'
        ? `⚠ The Unicommerce connection is down - automations are paused. <button id="banner-relogin">Re-login now</button>`
        : `⚠ Automations are paused for a moment while we reconnect. The admin team is on it - no action needed from you.`;
      banner.classList.remove('hidden');
      $('banner-relogin')?.addEventListener('click', openUcLogin);
    } else {
      banner.classList.add('hidden');
    }
  }

  // Human words for run states - users are not engineers.
  const STATUS_LABEL = { queued: 'Waiting', running: 'Working…', pending_retry: 'Retrying…', succeeded: 'Done', failed: 'Failed' };
  const AUTOMATION_LABEL = { asn: 'ASN Compile', reversedc: 'Reverse DC', packing: 'Packing Mail', sheet: 'Sheet Update', ewaybill: 'E-way Bill', return: 'Return Flow', inventory: 'Inward/Outward', inward: 'Inward', outward: 'Outward', uc: 'Order Lookup' };

  const runRow = (r) => `
    <tr>
      <td>${fmt(r.created_at)}</td>
      <td>${esc(r.user_email)}</td>
      <td>${esc(AUTOMATION_LABEL[r.automation] || r.automation)}</td>
      <td>${esc(r.action)}</td>
      <td>${esc(shortInput(r.input))}</td>
      <td><span class="pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
    </tr>`;

  /* ----------------------------------------------------------------------
   * runJob, the ONE async-action flow every automation tab shares:
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
      if (run.status === 'failed') toast('Job failed, see the result panel.', 'bad');
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
        out.innerHTML = `<div class="result-head"><span class="badge warn">still working</span>
          <span class="title">Taking a little longer than usual - retrying automatically, no action needed.</span></div>
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
      working: kind === 'status' ? 'Checking SO status…' : 'Processing, the worker may take a few minutes…',
      validate: () => (!so ? 'Enter a Sale Order code.' : null),
      submit: () => kind === 'status'
        ? api('/api/automations/uc/so-status', { body: { saleOrder: so } })
        : api('/api/automations/return/process', {
            body: { saleOrder: so, cancelSO: $('ret-cancel').value.trim() || null, returnIn: $('ret-return-in').checked, deliver: $('ret-deliver').checked },
          }),
      render: (r) => renderReturn(r, kind),
    });
  }

  // Batch: queue a sheet of original→correct SO pairs. Returns immediately with the
  // queued run list (each pair runs on the worker, sequentially).
  $('ret-batch-btn')?.addEventListener('click', () => {
    const pairs = $('ret-batch').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [a, b] = l.split(/[,\t]/).map((x) => x.trim());
      return b ? { originalSO: a, correctSO: b } : { correctSO: a };
    });
    return runJob({
      btn: $('ret-batch-btn'), out: $('ret-batch-output'), working: `Queueing ${pairs.length} pair(s)…`,
      validate: () => (!pairs.length || pairs.some((p) => !p.correctSO) ? 'Enter pairs: originalSO, correctSO (one per line).' : null),
      submit: () => api('/api/automations/return/batch', { body: { pairs, returnIn: $('ret-batch-return-in').checked } }),
      render: (r) => resultHead(true, `Queued ${r.queued} order(s)`)
        + `<ul class="result-list">${(r.runs || []).map((x) => `<li class="ok"><span class="so">${esc(x.saleOrder)}</span><span>queued · ${esc(x.runUid.slice(0, 8))}</span></li>`).join('')}</ul>`
        + `<p class="result-note">Track progress in the Dashboard → Recent Activity.</p>`,
    });
  });

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

  /* ---------------- ASN tab ---------------- */
  $('asn-run-btn')?.addEventListener('click', () => {
    const so = $('asn-so').value.trim();
    return runJob({
      btn: $('asn-run-btn'), out: $('asn-output'), working: `Compiling ASN for ${so} (detecting marketplace)`,
      validate: () => (!so ? 'Enter a Sale Order code.' : null),
      submit: () => api('/api/automations/asn/compile', { body: { saleOrder: so } }),
      render: (r) => renderFileResult(r, r.ok ? `ASN ready, ${r.lineCount} line(s)` : (r.error || 'Failed'),
        [['SO', r.so], ['Channel', r.channel], ['Facility', r.facility], ['PO', r.po], ['Invoice', r.invoice]], 'asn'),
    });
  });

  /* ---------------- Reverse DC: facility + Bulk Return ID → clean DC PDF ---------------- */
  // Hybrid modes: "rebuild" = parsed data reconciled against CN totals and a fresh DC
  // was rendered; "edit-fallback" = numbers didn't reconcile, so the ORIGINAL PDF was
  // edited in place (zero data loss, guaranteed).
  function rdcModeLabel(r) {
    if (r.mode === 'rebuild') return 'Rebuilt (verified against CN totals)';
    if (r.mode === 'edit-fallback') return 'Original preserved (layout not fully parseable)';
    return '—';
  }
  let rdcFacilitiesLoaded = false;

  async function loadRdcFacilities({ force = false } = {}) {
    const sel = $('rdc-facility');
    if (!sel) return;
    if (rdcFacilitiesLoaded && !force) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Loading facilities…</option>';
    sel.disabled = true;
    try {
      const { runUid } = await api('/api/automations/uc/facilities', { body: {} });
      // Don't poll into the result panel — facilities load is a quiet dropdown fill.
      const run = await pollRun(runUid, document.createElement('div'));
      const r = run.result || {};
      const all = r.all || [];
      if (run.status === 'failed' || !all.length) {
        sel.innerHTML = `<option value="">${esc(r.error || run.error || 'Could not load warehouses')}</option>`;
        toast(r.error || run.error || 'Could not load warehouses from Unicommerce.', 'bad');
        return;
      }
      const current = r.current || '';
      sel.innerHTML = '<option value="">Select warehouse…</option>'
        + all.map((code) => `<option value="${esc(code)}">${esc(code)}</option>`).join('');
      sel.value = (prev && all.includes(prev)) ? prev : (all.includes(current) ? current : '');
      rdcFacilitiesLoaded = true;
    } catch (err) {
      sel.innerHTML = `<option value="">${esc(err.message || 'Failed to load')}</option>`;
      toast(err.message || 'Failed to load warehouses', 'bad');
    } finally {
      sel.disabled = false;
    }
  }

  $('rdc-refresh-facilities')?.addEventListener('click', () => loadRdcFacilities({ force: true }));

  $('rdc-run-btn')?.addEventListener('click', () => {
    const facility = $('rdc-facility')?.value?.trim() || '';
    const bulkReturnId = $('rdc-bulk-id')?.value?.trim() || '';
    return runJob({
      btn: $('rdc-run-btn'),
      out: $('rdc-output'),
      working: 'Downloading credit note and building Delivery Challan…',
      validate: () => {
        if (!facility) return 'Select a warehouse / facility first.';
        if (!bulkReturnId) return 'Enter the Bulk Return ID.';
        return null;
      },
      submit: () => api('/api/automations/reversedc/from-bulk-return', { body: { facility, bulkReturnId } }),
      render: (r) => renderFileResult(
        r,
        r.ok === false ? (r.error || 'Failed') : 'Delivery Challan ready',
        [
          ['Bulk Return', r.bulkReturnId || bulkReturnId],
          ['Warehouse', r.facility || facility],
          ['Credit Note', r.creditNoteNo || '—'],
          ['Line items', r.lineCount ?? '—'],
          ['Method', rdcModeLabel(r)],
        ],
        'reversedc',
      ),
    });
  });

  $('rdc-upload-btn')?.addEventListener('click', async () => {
    const file = $('rdc-file')?.files?.[0];
    const out = $('rdc-upload-output');
    out.classList.remove('hidden');
    if (!file) { out.innerHTML = errHead('Choose a credit note PDF to upload.'); toast('Choose a credit note PDF first.', 'bad'); return; }
    const btn = $('rdc-upload-btn');
    setLoading(btn, true);
    out.innerHTML = `<div class="result-head"><span class="badge info">working</span><span class="title">Parsing credit note into a Delivery Challan</span></div>`;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/automations/reversedc/build', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      out.innerHTML = renderFileResult(data, 'Delivery Challan ready', [['Source', file.name], ['Credit Note', data.creditNoteNo || '—'], ['Line items', data.lineCount ?? '—'], ['Method', rdcModeLabel(data)]], 'reversedc');
      wireRaw(out);
      toast('Delivery Challan ready to download.', 'ok');
    } catch (err) {
      out.innerHTML = errHead(err.message);
      toast(err.message, 'bad');
    } finally {
      setLoading(btn, false);
    }
  });

  /* ---------------- Packing Mail tab ---------------- */
  let packingPreview = null; // last previewGroups result - drives recipient checkboxes

  async function loadPackingGmail() {
    const meta = $('packing-gmail-meta');
    const disconnect = $('packing-gmail-disconnect');
    const connect = $('packing-gmail-connect');
    if (!meta) return;
    try {
      const g = await api('/api/me/google/status');
      if (g.connected) {
        meta.innerHTML = `<span class="ok">Connected</span> as <b>${esc(g.grantedBy || me.email)}</b> — drafts will be created in this mailbox.`;
        disconnect?.classList.remove('hidden');
        if (connect) connect.textContent = 'Reconnect my Gmail';
      } else {
        meta.innerHTML = `<span class="error">Not connected</span> — connect your Gmail before creating drafts.`;
        disconnect?.classList.add('hidden');
        if (connect) connect.textContent = 'Connect my Gmail';
      }
    } catch (err) {
      meta.textContent = 'Could not check Gmail connection: ' + (err.message || err);
    }
  }

  $('packing-gmail-disconnect')?.addEventListener('click', async () => {
    try {
      await api('/api/me/google/disconnect', { method: 'POST', body: {} });
      toast('Gmail disconnected for Packing Mail.', 'ok');
      loadPackingGmail();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  function packingSaleOrders() {
    return $('packing-sos').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  function packingRecipientsFromUi() {
    const box = $('packing-recipients');
    if (!box || !packingPreview?.groups?.length) return {};
    const out = {};
    for (const g of packingPreview.groups) {
      const root = box.querySelector(`[data-wh="${CSS.escape(g.warehouse)}"]`);
      if (!root) continue;
      const checked = (sel) => [...root.querySelectorAll(sel)].filter((el) => el.checked).map((el) => el.value);
      out[g.warehouse] = {
        to: checked('input[data-role="to"]'),
        // Finance ticks are just more CC recipients the operator opted into.
        cc: [...checked('input[data-role="cc"]'), ...checked('input[data-role="finance"]')],
      };
    }
    return out;
  }

  function renderPackingRecipients(preview) {
    const box = $('packing-recipients');
    packingPreview = preview;
    if (!box) return;
    if (!preview?.groups?.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      $('packing-btn').disabled = true;
      $('packing-inveway-btn').disabled = true;
      return;
    }
    const cards = preview.groups.map((g) => {
      const opt = g.options || { to: [], cc: [], finance: [] };
      const selTo = new Set(g.selectedTo || opt.to || []);
      const selCc = new Set(g.selectedCc || opt.cc || []);
      const tick = (email, role, on) => `<label class="check"><input type="checkbox" data-role="${role}" value="${esc(email)}" ${on ? 'checked' : ''}> ${esc(email)}</label>`;
      const toBox = (opt.to || []).map((e) => tick(e, 'to', selTo.has(e))).join('') || '<span class="meta">No To addresses on the sheet</span>';
      const ccBox = (opt.cc || []).map((e) => tick(e, 'cc', selCc.has(e))).join('') || '<span class="meta">No CC on the sheet</span>';
      const finBox = (opt.finance || []).map((e) => tick(e, 'finance', false)).join('');
      return `<div class="wh-card" data-wh="${esc(g.warehouse)}">
        <div class="wh-card-head"><b>${esc(g.warehouse)}</b> <span class="meta">${g.sos.length} SO(s): ${esc(g.sos.join(', '))}</span></div>
        <div class="wh-card-sec"><span class="wh-label">To</span><div class="wh-emails">${toBox}</div></div>
        <div class="wh-card-sec"><span class="wh-label">CC</span><div class="wh-emails">${ccBox}</div></div>
        ${finBox ? `<div class="wh-card-sec"><span class="wh-label">Finance</span><div class="wh-emails">${finBox}</div></div>` : ''}
      </div>`;
    }).join('');
    const un = (preview.unresolved || []).map((u) => `<li class="bad"><span class="so">${esc(u.so)}</span><span>${esc(u.reason)}</span></li>`).join('');
    box.innerHTML = `<h3 class="wh-title">Recipients (from warehouse-email sheet)</h3>${cards}`
      + (un ? `<p class="result-note">Skipped:</p><ul class="result-list">${un}</ul>` : '');
    box.classList.remove('hidden');
    $('packing-btn').disabled = false;
    $('packing-inveway-btn').disabled = false;
  }

  $('packing-preview-btn')?.addEventListener('click', () => {
    const saleOrders = packingSaleOrders();
    return runJob({
      btn: $('packing-preview-btn'), out: $('packing-output'), working: 'Looking up warehouses and email recipients',
      validate: () => (!saleOrders.length ? 'Enter at least one SO number.' : null),
      submit: () => api('/api/automations/packing/preview', { body: { saleOrders } }),
      render: (r) => {
        if (r.error) { renderPackingRecipients(null); return errHead(r.error); }
        renderPackingRecipients(r);
        return resultHead(!!r.groups?.length, `${r.groups?.length || 0} warehouse group(s) ready - tick recipients, then create drafts`)
          + (r.directoryCount != null ? kv([['Warehouses on email sheet', r.directoryCount]]) : '');
      },
    });
  });

  $('packing-btn')?.addEventListener('click', () => {
    const saleOrders = packingSaleOrders();
    const recipients = packingRecipientsFromUi();
    return runJob({
      btn: $('packing-btn'), out: $('packing-output'), working: 'Composing per-warehouse drafts',
      validate: () => {
        if (!saleOrders.length) return 'Enter at least one SO number.';
        if (!packingPreview?.groups?.length) return 'Resolve warehouses first so you can pick recipients.';
        const missing = Object.values(recipients).some((x) => !(x.to || []).length);
        if (missing) return 'Each warehouse needs at least one To recipient ticked.';
        return null;
      },
      submit: () => api('/api/automations/packing/drafts', { body: { saleOrders, recipients } }),
      render: (r) => {
        if (!r.ok && r.error) return errHead(r.error);
        const head = resultHead(r.ok, `${r.draftCount || 0} draft(s) created - nothing has been SENT yet`);
        const list = (r.drafts || []).map((d) => `<li class="ok">
          <span class="so">${esc(d.warehouse)}</span>
          <span>${esc(d.to)}${d.cc ? ` · cc ${esc(d.cc)}` : ''} · ${d.sos.length} order(s) · ${d.attachmentCount} attachment(s)</span>
          <span class="draft-actions">
            ${d.viewUrl ? `<a href="${esc(d.viewUrl)}" target="_blank" rel="noopener" class="link-btn">view in Gmail</a>` : ''}
            ${d.draftId ? `<button class="link-btn" data-send-draft="${esc(d.draftId)}">send now</button>` : ''}
          </span>
        </li>`).join('');
        const un = (r.unresolved || []).map((u) => `<li class="bad"><span class="so">${esc(u.so)}</span><span>${esc(u.reason)}</span></li>`).join('');
        return head + (list ? `<ul class="result-list">${list}</ul>` : '')
          + `<p class="result-note">The email goes out only when you press <b>send now</b> here, or open the draft in Gmail and press Send there.</p>`
          + (un ? `<p class="result-note">Skipped:</p><ul class="result-list">${un}</ul>` : '');
      },
    });
  });

  /* ---------------- Packing follow-up: invoice + e-way bill ---------------- */
  $('packing-inveway-btn')?.addEventListener('click', () => {
    const saleOrders = packingSaleOrders();
    const recipients = packingRecipientsFromUi();
    return runJob({
      btn: $('packing-inveway-btn'), out: $('packing-output'), working: 'Downloading invoices and e-way bills from Unicommerce',
      validate: () => (!saleOrders.length ? 'Enter at least one SO number.' : null),
      submit: () => api('/api/automations/packing/invoice-eway', { body: { saleOrders, recipients } }),
      render: (r) => {
        if (!r.ok && r.error) return errHead(r.error);
        const head = resultHead(r.ok, `${r.draftCount || 0} follow-up draft(s) created`);
        const list = (r.drafts || []).map((d) => `<li class="ok">
          <span class="so">${esc(d.warehouse)}</span>
          <span>${esc(d.to)}${d.cc ? ` · cc ${esc(d.cc)}` : ''} · ${d.sos.length} order(s) · ${d.attachmentCount} file(s)${d.threaded ? ' · same thread' : ' · new thread'}</span>
          <span class="draft-actions">
            ${d.viewUrl ? `<a href="${esc(d.viewUrl)}" target="_blank" rel="noopener" class="link-btn">view in Gmail</a>` : ''}
            ${d.draftId ? `<button class="link-btn" data-send-draft="${esc(d.draftId)}">send now</button>` : ''}
          </span>
        </li>`).join('');
        const un = (r.unresolved || []).map((u) => `<li class="bad"><span class="so">${esc(u.so)}</span><span>${esc(u.reason)}</span></li>`).join('');
        return head + (list ? `<ul class="result-list">${list}</ul>` : '') + (un ? `<p class="result-note">Not ready yet:</p><ul class="result-list">${un}</ul>` : '');
      },
    });
  });

  // Wire "send now" on any packing draft rendered into #packing-output (event delegation,
  // since the list is re-rendered on every run).
  $('packing-output')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-send-draft]');
    if (!btn) return;
    const draftId = btn.dataset.sendDraft;
    btn.disabled = true;
    btn.textContent = 'sending…';
    try {
      const { runUid } = await api('/api/automations/packing/send-draft', { body: { draftId } });
      const run = await pollRun(runUid, $('packing-output'));
      if (run.status === 'succeeded' && run.result?.ok !== false) {
        btn.textContent = 'sent';
        toast('Draft sent.', 'ok');
      } else {
        throw new Error(run.result?.error || 'send failed');
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'send now';
      toast(err.message, 'bad');
    }
  });

  /* ---------------- Sheet Update tab ---------------- */
  // One line per SO, so ops can see what landed without opening the sheet. Both fills
  // report details but with different fields present - the first fill shows what
  // Unicommerce resolved (the warehouse above all), the second shows the join between the
  // first-fill row and the invoice data - so the columns follow the data.
  function sheetDetailTable(details) {
    if (!details?.length) return '';
    const cols = [
      ['so', 'SO'], ['tab', 'Tab'], ['warehouse', 'Warehouse'], ['marketplace', 'Marketplace'],
      ['brand', 'Brand'], ['po', 'PO'], ['qty', 'Qty'], ['destCity', 'Destination'],
      ['invoice', 'Invoice'], ['invoiceQty', 'Inv Qty'], ['tracking', 'Tracking'],
      ['ewayBill', 'E-Way'], ['status', 'Status'],
    ].filter(([k]) => details.some((d) => String(d[k] ?? '').trim() !== ''));
    const head = cols.map(([, h]) => `<th>${h}</th>`).join('');
    const rows = details.map((d) => '<tr>'
      + cols.map(([k]) => `<td>${esc(d[k] ?? '')}</td>`).join('') + '</tr>').join('');
    return `<div style="margin-top:10px"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const sheetRun = (action, btn, working, body = () => ({})) => () => runJob({
    btn: $(btn), out: $('sheet-output'), working,
    submit: () => api('/api/automations/sheet/' + action, { body: body() }),
    render: (r) => (!r.ok && r.error) ? errHead(r.error)
      : resultHead(r.ok, r.summary || 'Done') + kv(Object.entries(r.counts || {})) + sheetDetailTable(r.details),
  });
  // One SO box, read by both fills: on the first it adds orders Waypoint has not
  // published, on the second it picks which rows to enrich.
  const sheetSos = () => {
    const sos = ($('sheet-sos')?.value || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    return sos.length ? { saleOrders: sos } : {};
  };
  $('sheet-first-btn')?.addEventListener('click', sheetRun(
    'first-fill', 'sheet-first-btn', 'Pulling Waypoint and Unicommerce orders into the date tab', sheetSos,
  ));
  $('sheet-second-btn')?.addEventListener('click', sheetRun(
    'second-fill', 'sheet-second-btn', 'Enriching rows with UC invoice and tracking', sheetSos,
  ));
  $('sheet-push-btn')?.addEventListener('click', sheetRun('push', 'sheet-push-btn', 'Pushing the date tab into Master'));
  $('sheet-sync-btn')?.addEventListener('click', sheetRun('sync-source', 'sheet-sync-btn', 'Pulling missing orders from the source sheet'));

  /* ---------------- admin ---------------- */
  $('admin-cookie-btn')?.addEventListener('click', async () => {
    const v = $('admin-cookie').value.trim();
    const msg = $('admin-cookie-msg');
    const btn = $('admin-cookie-btn');
    if (!v) { msg.textContent = 'Paste a JSESSIONID first.'; msg.className = 'meta error'; return; }
    setLoading(btn, true);
    msg.className = 'meta';
    msg.textContent = 'Testing this session against Unicommerce…';
    try {
      // api() throws on non-2xx, but the 400-with-reason body is what we want to show,
      // so read the raw response instead of letting a bad-session 400 look like a network error.
      const res = await fetch('/api/admin/uc-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsessionid: v }), credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.alive) {
        msg.className = 'meta ok';
        msg.textContent = `Verified ALIVE${data.facility ? ' on facility ' + data.facility : ''}. Automations are unblocked.`;
        $('admin-cookie').value = '';
        toast('Session verified and saved. It is ALIVE.', 'ok');
      } else {
        msg.className = 'meta error';
        msg.textContent = data.error || 'Unicommerce rejected this session.';
        toast('That session did not work: ' + (data.error || 'rejected by Unicommerce'), 'bad');
      }
      refreshDashboard();
    } catch (err) {
      msg.className = 'meta error';
      msg.textContent = 'Could not reach the platform to test the session: ' + err.message;
      toast(err.message, 'bad');
    } finally {
      setLoading(btn, false);
    }
  });

  $('token-create-btn')?.addEventListener('click', async () => {
    try {
      const { token } = await api('/api/admin/ingest-tokens', { body: { label: 'helper' } });
      const out = $('token-out');
      out.classList.remove('hidden');
      out.textContent = 'Copy this token into the Session Helper extension now (shown once):\n\n' + token;
      toast('Token created, copy it now, it won\'t be shown again.', 'ok', 8000);
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
    // google workspace connection
    try {
      const g = await api('/api/admin/google/status');
      $('admin-google-meta').innerHTML = g.connected
        ? `<span class="ok">Connected</span> as <b>${esc(g.grantedBy)}</b> · since ${fmt(g.updatedAt)}`
        : `<span class="error">Not connected</span> - Sheet Update writes stay disabled until this is done.`;
      $('admin-google-connect').textContent = g.connected ? 'Reconnect shared Workspace' : 'Connect shared Workspace';
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
    // audit log
    try {
      const { audit } = await api('/api/admin/audit');
      $('audit-table').querySelector('tbody').innerHTML = audit.map((a) => `
        <tr><td>${fmt(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.event)}</td>
        <td><code>${esc(JSON.stringify(a.detail))}</code></td></tr>`).join('') || emptyRow(4);
    } catch {}
  }

  /* ---------------- result renderers ---------------- */
  // A run's outcome → clean HTML. Each automation shows the fields that matter,
  // a step timeline, and a collapsible raw view, never a bare JSON dump.
  function resultHead(ok, title, extra = '') {
    const badge = ok === true ? '<span class="badge ok">success</span>'
      : ok === false ? '<span class="badge bad">failed</span>'
      : '<span class="badge info">done</span>';
    return `<div class="result-head">${badge}<span class="title">${esc(title)}</span>${extra}</div>`;
  }
  const errHead = (msg) => `<div class="result-head"><span class="badge bad">error</span><span class="title">${esc(msg)}</span></div>`;
  const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>`;
  function stepChips(steps) {
    if (!steps || typeof steps !== 'object') return '';
    const chips = Object.entries(steps).map(([k, v]) =>
      `<span class="step-chip done"><b>${esc(k)}</b>${v && v !== 'ok' ? ' · ' + esc(String(v).slice(0, 28)) : ''}</span>`).join('');
    return chips ? `<div class="steps-flow">${chips}</div>` : '';
  }
  // Technical response details are for admins debugging - regular users never see JSON.
  const raw = (obj) => (me?.role === 'admin'
    ? `<details class="raw"><summary>Technical details (admin)</summary><pre class="output">${esc(JSON.stringify(obj, null, 2))}</pre></details>`
    : '');

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
      + (r.pending ? `<p class="result-note">Still working through an async step, this may finish on a later retry.</p>` : '')
      + raw(r);
  }

  function renderBatch(r, label) {
    const items = r.results || [];
    const head = resultHead(r.failed === 0, `${label}: ${r.ok ?? 0} ok · ${r.failed ?? 0} failed`);
    const list = items.map((x) => {
      const line = x.skipped ? `already had EWB ${x.ewb}`
        : x.dryRun ? `would generate · invoice ${x.invoiceCode}`
        : x.ewb ? `EWB ${x.ewb}` : (x.error || '-');
      return `<li class="${x.ok ? 'ok' : 'bad'}"><span class="so">${esc(x.so)}</span><span>${esc(line)}</span></li>`;
    }).join('');
    return head + `<ul class="result-list">${list}</ul>` + raw(r);
  }

  function renderInventory(r, op) {
    if (op === 'fullcycle') {
      const ok = r.status === 'FULLCYCLE_DONE';
      return resultHead(ok, ok ? 'Full cycle complete' : 'Outward failed after inward')
        + `<div class="steps-flow"><span class="step-chip done"><b>inward</b> · ${esc(r.inward?.status || '-')}</span>
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

  // Result with a generated file (ASN / Reverse DC): a real download link (not just a
  // JS-click button, so right-click "save as" / open-in-new-tab work) plus an inline
  // preview for anything a browser can render natively (PDFs, images).
  function renderFileResult(r, title, pairs, slot) {
    const head = resultHead(r.ok, title);
    if (!r.ok) return head + raw(r);
    const { filename, contentType, base64 } = r.file;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    trackBlobUrl(slot, url);
    const previewable = /^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType);
    const preview = previewable
      ? (contentType === 'application/pdf'
        ? `<iframe class="file-preview" src="${url}" title="${esc(filename)} preview"></iframe>`
        : `<img class="file-preview" src="${url}" alt="${esc(filename)} preview" style="object-fit:contain">`)
      : '';
    return head + kv(pairs) + preview
      + `<a href="${url}" download="${esc(filename)}" class="dl-btn mt-sm">⤓ Download ${esc(filename)}</a>`
      + raw({ ...r, file: { filename, contentType, base64: '…' } });
  }

  // One live blob URL per output slot (asn / reversedc) - a fresh result replaces the
  // previous preview in the same panel, so the old blob is safe to revoke right then
  // rather than leaking for the rest of the session.
  const liveBlobUrls = {};
  function trackBlobUrl(slot, url) {
    if (liveBlobUrls[slot]) URL.revokeObjectURL(liveBlobUrls[slot]);
    liveBlobUrls[slot] = url;
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
  const fmt = (t) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
  // Plain-words summary of a run's input - users never see raw JSON.
  const shortInput = (input) => {
    if (!input) return '';
    try {
      const o = typeof input === 'string' ? JSON.parse(input) : input;
      if (typeof o !== 'object' || o === null) return String(o);
      if (o.saleOrder || o.code || o.so) return o.saleOrder || o.code || o.so;
      if (o.saleOrders?.length) return `${o.saleOrders.length} order(s)`;
      if (o.rows?.length) return `${o.rows.length} order(s)`;
      if (o.items?.length) return `${o.items.length} item(s)`;
      if (o.count) return `${o.count} order(s)`;
      if (o.file) return 'uploaded file';
      if (o.action) return String(o.action);
      const firstString = Object.values(o).find((v) => typeof v === 'string' && v);
      return firstString ? String(firstString).slice(0, 30) : '';
    } catch { return ''; }
  };

  /* ---------------- request an automation ---------------- */
  $('request-automation-btn')?.addEventListener('click', () => $('request-modal').classList.remove('hidden'));
  $('request-close')?.addEventListener('click', () => $('request-modal').classList.add('hidden'));
  $('request-modal')?.addEventListener('click', (e) => { if (e.target === $('request-modal')) $('request-modal').classList.add('hidden'); });

  boot();
})();
