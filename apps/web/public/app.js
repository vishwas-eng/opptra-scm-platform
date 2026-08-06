/* Opptra SCM Platform, sidebar SPA (plain ES2020, no build). */
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_TITLES = {
    dashboard: 'Workspace', return: 'Return Flow', ewaybill: 'E-way Bill', inventory: 'Inward / Outward',
    asn: 'ASN Compile', reversedc: 'Reverse DC', sheet: 'Sheet Update', packing: 'Packing Mail',
    homecentre: 'Home Centre Sync', schedules: 'Scheduled Jobs', extensions: 'Extensions', admin: 'Admin',
    agent: 'Agent · Beta',
    connectors: 'Connectors',
  };
  let me = null;
  let pollTimer = null;
  let ucLoginUrl = null;
  let kpiDays = 7;
  let kpiChartDaily = null;
  let kpiChartAutom = null;
  let agentThreadId = null;
  let agentBusy = false;

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
    if (!res.ok) {
      const details = Array.isArray(data.fieldErrors) && data.fieldErrors.length
        ? data.fieldErrors.map((f) => f.message || f).filter(Boolean)
        : [];
      // Prefer the summary error; append first field detail when it adds new info.
      let msg = data.error || `HTTP ${res.status}`;
      if (details.length && !details.includes(msg)) {
        const extra = details.filter((d) => d !== msg);
        if (extra.length === 1) msg = `${msg} — ${extra[0]}`;
        else if (extra.length > 1) msg = `${msg} (${extra.length} issues)`;
      }
      throw new Error(msg);
    }
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
      if (googleConnect === 'ok') {
        if (landTab === 'packing') toast('Your Gmail is connected for Packing Mail.', 'ok');
        else if (landTab === 'connectors' || landTab === 'agent') toast('Your Google account is connected for Sheets & Drive (Agent).', 'ok');
        else toast('Google Workspace connected.', 'ok');
        if (params.get('googleMismatch') === '1') {
          toast('Note: you authorized as ' + (params.get('googleAccount') || 'another account') + ' — different from your Opptra login.', 'bad', 9000);
        }
      }
      else toast('Google connection failed: ' + (googleConnect || 'unknown error'), 'bad', 8000);
      if (landTab) setTimeout(() => go(landTab), 0);
    }
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = me.name || me.email;
    $('user-role').textContent = me.role;
    $('user-pic').src = me.picture || '';
    if (me.role === 'admin') {
      $('admin-nav-btn').classList.remove('hidden');
      $('agent-nav-btn')?.classList.remove('hidden');
      $('connectors-nav-btn')?.classList.remove('hidden');
    }
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
    if (tab === 'agent' || tab === 'connectors') {
      if (me?.role !== 'admin') {
        toast('Agent & Connectors are admin-only (Beta).', 'bad');
        tab = 'dashboard';
      }
    }
    document.querySelectorAll('#side-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
    $('tab-' + tab).classList.remove('hidden');
    $('page-title').textContent = PAGE_TITLES[tab] || tab;
    if (tab === 'admin') loadAdmin();
    if (tab === 'sheet') loadSheetLink();
    if (tab === 'packing') loadPackingGmail();
    if (tab === 'reversedc') loadRdcFacilities();
    if (tab === 'agent') loadAgentTab();
    if (tab === 'connectors') loadConnectorsPage();
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
  async function openUcLogin(instanceId) {
    const id = instanceId || $('admin-uc-instance')?.value || 'india';
    let url = null;
    try {
      url = (await api('/api/admin/uc-login-url?instanceId=' + encodeURIComponent(id))).url;
    } catch {
      url = ucLoginUrl;
    }
    if (url) window.open(url, '_blank', 'noopener');
  }
  $('dash-relogin-btn').addEventListener('click', () => openUcLogin('india'));
  $('admin-relogin-btn')?.addEventListener('click', () => openUcLogin());

  /* ---------------- dashboard + KPIs ---------------- */
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
      if (me?.role === 'admin') await loadKpis(kpiDays);
    } catch { /* transient, next poll retries */ }
  }

  function destroyChart(ch) { try { ch?.destroy(); } catch { /* noop */ } return null; }

  function chartColors() {
    return {
      orange: '#FF5800',
      soft: 'rgba(255,88,0,.16)',
      ink: '#141414',
      /* OK / success — soft charcoal (no forest green) */
      ok: 'rgba(20,20,20,.48)',
      okLine: '#5c5c5c',
      /* Failed — muted rose / soft red-orange */
      failed: 'rgba(196,90,70,.72)',
      failedLine: '#C45A46',
      grid: 'rgba(20,20,20,.06)',
      muted: '#5c5c5c',
    };
  }

  async function loadKpis(days = 7) {
    if (me?.role !== 'admin') return;
    kpiDays = days;
    document.querySelectorAll('#kpi-window button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.days) === days);
    });
    const a = await api('/api/admin/kpi?days=' + days);
    const t = a.totals || {};
    const succeeded = t.succeeded || 0;
    const failed = t.failed || 0;
    $('week-count').textContent = a.week?.total ?? (succeeded + failed);
    $('week-breakdown').textContent = `${succeeded} ok · ${failed} failed · ${days}d`;
    $('kpi-success-rate').textContent = a.successRate != null ? `${a.successRate}%` : '—';
    $('kpi-success-meta').textContent = `${succeeded + failed} finished runs`;
    $('kpi-active-users').textContent = (a.byUser || []).length;
    $('kpi-users-meta').textContent = `${a.users?.active_logins || 0} logins · ${a.users?.registered || 0} registered`;
    $('kpi-failures').textContent = failed;

    const features = a.features || [];
    $('kpi-features').innerHTML = features.length
      ? features.map((f) => `
        <div class="agent-chip">
          <div class="name">${esc(f.label)}</div>
          <div class="stats">${f.total} runs · ${f.ok} ok · ${f.failed} failed</div>
          <div class="rate">${f.successRate != null ? f.successRate + '% success' : 'n/a'}${f.active ? ` · ${f.active} active` : ''}</div>
        </div>`).join('')
      : '<div class="meta">No automation runs in this window yet.</div>';

    const ut = $('kpi-users-table')?.querySelector('tbody');
    if (ut) {
      ut.innerHTML = (a.byUser || []).length
        ? a.byUser.map((r) => `<tr><td>${esc(r.user_email)}</td><td>${r.total}</td><td>${r.ok}</td><td>${r.failed}</td><td>${fmt(r.last_run_at)}</td></tr>`).join('')
        : emptyRow(5);
    }

    if (typeof Chart === 'undefined') return;
    const c = chartColors();
    const daysRows = a.byDay || [];
    const labels = daysRows.map((d) => String(d.day).slice(0, 10));
    kpiChartDaily = destroyChart(kpiChartDaily);
    const dailyEl = $('kpi-chart-daily');
    if (dailyEl) {
      kpiChartDaily = new Chart(dailyEl, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Total', data: daysRows.map((d) => d.total), borderColor: c.orange, backgroundColor: c.soft, fill: true, tension: 0.3, borderWidth: 2 },
            { label: 'Succeeded', data: daysRows.map((d) => d.ok), borderColor: c.okLine, backgroundColor: 'transparent', tension: 0.3, borderWidth: 2 },
            { label: 'Failed', data: daysRows.map((d) => d.failed), borderColor: c.failedLine, backgroundColor: 'transparent', tension: 0.3, borderWidth: 2 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: c.muted, boxWidth: 12 } } },
          scales: {
            x: { ticks: { color: c.muted, maxRotation: 0 }, grid: { color: c.grid } },
            y: { beginAtZero: true, ticks: { color: c.muted, precision: 0 }, grid: { color: c.grid } },
          },
        },
      });
    }

    kpiChartAutom = destroyChart(kpiChartAutom);
    const automEl = $('kpi-chart-autom');
    if (automEl) {
      const feats = features.slice(0, 8);
      kpiChartAutom = new Chart(automEl, {
        type: 'bar',
        data: {
          labels: feats.map((f) => f.label),
          datasets: [
            { label: 'OK', data: feats.map((f) => f.ok), backgroundColor: c.ok, borderRadius: 3 },
            { label: 'Failed', data: feats.map((f) => f.failed), backgroundColor: c.failed, borderRadius: 3 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: c.muted, boxWidth: 12 } } },
          scales: {
            x: { stacked: true, ticks: { color: c.muted }, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { color: c.muted, precision: 0 }, grid: { color: c.grid } },
          },
        },
      });
    }
  }

  document.querySelectorAll('#kpi-window button').forEach((b) => {
    b.addEventListener('click', () => loadKpis(Number(b.dataset.days) || 7).catch((err) => toast(err.message, 'bad')));
  });

  function renderSession(s) {
    const alive = s.status === 'alive';
    const needs = s.needs_relogin || s.status === 'dead' || !s.has_cookie;
    const ucLabel = alive ? 'UC synced' : needs ? 'UC offline' : 'UC checking…';
    const ucClass = alive ? 'ok' : needs ? 'bad' : 'warn';

    // Compact UC sync pill in the "system working" area — no source/timestamps.
    const pill = $('health-pill');
    pill.className = 'health-pill ' + ucClass;
    $('health-pill-text').textContent = ucLabel;
    $('side-session').innerHTML = `<span class="uc-chip ${ucClass}">${ucLabel}</span>`;

    // Hidden hooks for app.js / Admin — keep IDs wired; UI no longer shows the bulky card.
    const el = $('session-status');
    el.className = 'big ' + ucClass;
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
    if (err) {
      if (out) {
        out.classList.remove('hidden');
        out.innerHTML = `<div class="result-head"><span class="badge bad">invalid input</span><span class="title">${esc(err)}</span></div>`;
      }
      toast(err, 'bad');
      return;
    }
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
    const V = window.OpptraValidate;
    return runJob({
      btn: kind === 'status' ? $('ret-status-btn') : $('ret-run-btn'),
      out: $('ret-output'),
      working: kind === 'status' ? 'Checking SO status…' : 'Processing, the worker may take a few minutes…',
      validate: () => V?.validateSaleOrder(so) || (!so ? 'Enter a Sale Order code.' : null),
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

  /* ---------------- e-way bill tab (template + bulk upload like Apps Script) ---------------- */
  const EWB_COLS = [
    { key: 'so', ph: 'SO number' },
    { key: 'gstin', ph: 'GSTIN (15)' },
    { key: 'transporterName', ph: 'name' },
    { key: 'transMode', ph: 'ROAD' },
    { key: 'vehicleNo', ph: 'vehicle no' },
    { key: 'distance', ph: 'km' },
    { key: 'docNo', ph: 'doc no' },
    { key: 'docDate', ph: 'DD/MM/YYYY' },
    { key: 'vehicleType', ph: 'REGULAR' },
  ];
  const EWB_HEADERS = ['SO Number', 'Transporter GSTIN', 'Transporter Name', 'Transport Mode', 'Vehicle No', 'Distance (km)', 'Transport Doc No', 'Doc Date (DD/MM/YYYY)', 'Vehicle Type'];

  function ewbAddRow(data = {}) {
    const tbody = $('ewb-rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.innerHTML = EWB_COLS.map((c) => `<td><input data-k="${c.key}" placeholder="${c.ph}" /></td>`).join('')
      + '<td><button type="button" class="ewb-del" title="Remove row">✕</button></td>';
    tbody.appendChild(tr);
    EWB_COLS.forEach((c) => {
      if (data[c.key] != null && data[c.key] !== '') tr.querySelector(`input[data-k="${c.key}"]`).value = data[c.key];
    });
    if (!tr.querySelector('input[data-k="transMode"]').value) tr.querySelector('input[data-k="transMode"]').value = 'ROAD';
    if (!tr.querySelector('input[data-k="vehicleType"]').value) tr.querySelector('input[data-k="vehicleType"]').value = 'REGULAR';
    tr.querySelector('.ewb-del').addEventListener('click', () => tr.remove());
  }

  function ewbParseRows() {
    return [...document.querySelectorAll('#ewb-rows tr')].map((tr) => {
      const row = {};
      EWB_COLS.forEach((c) => { row[c.key] = (tr.querySelector(`input[data-k="${c.key}"]`)?.value || '').trim(); });
      return row;
    }).filter((r) => r.so);
  }

  function ewbCellStr(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) {
      const p = (n) => (n < 10 ? '0' : '') + n;
      return `${p(v.getDate())}/${p(v.getMonth() + 1)}/${v.getFullYear()}`;
    }
    if (typeof v === 'number') return String(Math.round(v) === v ? v : v);
    return String(v).trim();
  }

  // Prefer exact header matches, then startsWith, then includes (min length 4) to
  // avoid "vehicle" matching "Vehicle Type" when looking for vehicle number.
  function ewbPick(obj, keys) {
    const entries = Object.keys(obj).map((k) => ({
      k, kk: String(k).toLowerCase().replace(/[^a-z0-9]/g, ''),
    }));
    for (const want of keys) {
      const hit = entries.find((e) => e.kk === want);
      if (hit) return ewbCellStr(obj[hit.k]);
    }
    for (const want of keys) {
      const hit = entries.find((e) => e.kk.startsWith(want) || (want.length >= 4 && e.kk.includes(want)));
      if (hit) return ewbCellStr(obj[hit.k]);
    }
    return '';
  }

  function ewbToApiRows(rows) {
    return rows.map((r) => {
      const out = { so: r.so };
      for (const k of ['gstin', 'transporterName', 'vehicleNo', 'transMode', 'distance', 'docDate', 'docNo', 'vehicleType']) {
        if (r[k]) out[k] = r[k];
      }
      return out;
    });
  }

  function ewbEnsureSheetJs() {
    if (window.XLSX) return true;
    toast('Excel library still loading — wait a second and try again.', 'bad');
    return false;
  }

  $('ewb-template-btn')?.addEventListener('click', () => {
    if (!ewbEnsureSheetJs()) return;
    const ws = XLSX.utils.aoa_to_sheet([
      EWB_HEADERS,
      ['SO01562', '22AAAAA0000A1Z5', 'Opptra Logistics', 'ROAD', 'GJ01AB1234', '12', 'DOC123', '23/06/2026', 'REGULAR'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Eway');
    XLSX.writeFile(wb, 'opptra-eway-template.xlsx');
  });

  $('ewb-add-row')?.addEventListener('click', () => ewbAddRow());
  $('ewb-clear-rows')?.addEventListener('click', () => {
    if ($('ewb-rows')) { $('ewb-rows').innerHTML = ''; ewbAddRow(); ewbAddRow(); }
    if ($('ewb-imp-msg')) $('ewb-imp-msg').textContent = '';
  });

  $('ewb-file')?.addEventListener('change', (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    if (!ewbEnsureSheetJs()) { ev.target.value = ''; return; }
    const rd = new FileReader();
    rd.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
        if (!rows.length) { $('ewb-imp-msg').textContent = 'No rows found in the file.'; return; }
        $('ewb-rows').innerHTML = '';
        let imported = 0;
        rows.forEach((o) => {
          const so = ewbPick(o, ['sonumber', 'socode', 'saleorder', 'so']);
          if (!so) return;
          imported += 1;
          ewbAddRow({
            so,
            gstin: ewbPick(o, ['transportergstin', 'gstin', 'transporterid']),
            transporterName: ewbPick(o, ['transportername', 'transportname']),
            transMode: ewbPick(o, ['transportmode', 'transmode', 'mode']) || 'ROAD',
            vehicleNo: ewbPick(o, ['vehicleno', 'vehiclenumber']),
            distance: ewbPick(o, ['distancekm', 'distance']),
            docNo: ewbPick(o, ['transportdocno', 'docno', 'documentno']),
            docDate: ewbPick(o, ['docdateddmmyyyy', 'docdate']),
            vehicleType: ewbPick(o, ['vehicletype']) || 'REGULAR',
          });
        });
        if (!imported) { ewbAddRow(); ewbAddRow(); }
        $('ewb-imp-msg').textContent = imported ? `${imported} row(s) imported` : 'No SO rows found in the file.';
        toast(imported ? `${imported} row(s) imported from sheet` : 'No SO rows found in the file.', imported ? 'ok' : 'bad');
      } catch (err) {
        $('ewb-imp-msg').textContent = `Import failed: ${err.message}`;
        toast(`Import failed: ${err.message}`, 'bad');
      }
      ev.target.value = '';
    };
    rd.readAsArrayBuffer(f);
  });

  // Seed two empty rows when the tab is first opened
  if ($('ewb-rows') && !$('ewb-rows').children.length) { ewbAddRow(); ewbAddRow(); }

  $('ewb-run-btn')?.addEventListener('click', () => {
    const parsed = ewbParseRows();
    const rows = ewbToApiRows(parsed);
    const dryRun = $('ewb-dry').checked;
    const V = window.OpptraValidate;
    return runJob({
      btn: $('ewb-run-btn'), out: $('ewb-output'),
      working: dryRun ? 'Previewing (no e-way bills created)…' : 'Generating e-way bills…',
      validate: () => (V ? V.validateEwayRows(rows) : (!rows.length ? 'Add at least one row with an SO Number.' : null)),
      submit: () => api('/api/automations/ewaybill/generate', { body: { dryRun, rows } }),
      render: (r) => renderEwayBatch(r),
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
    const V = window.OpptraValidate;
    return runJob({
      btn: $('asn-run-btn'), out: $('asn-output'), working: `Compiling ASN for ${so} (detecting marketplace)`,
      validate: () => V?.validateSaleOrder(so) || (!so ? 'Enter a Sale Order code.' : null),
      submit: () => api('/api/automations/asn/compile', { body: { saleOrder: so } }),
      render: (r) => renderFileResult(r, r.ok ? `ASN ready, ${r.lineCount} line(s)` : (r.error || 'Failed'),
        [['SO', r.so], ['Channel', r.channel], ['Facility', r.facility], ['PO', r.po], ['Invoice', r.invoice]], 'asn'),
    });
  });

  /* ---------------- Home Centre (GCC) — staging orders / UAE inventory ---------------- */
  function renderHc(r) {
    const ok = r.ok !== false;
    const msg = r.message || (r.empty ? 'No orders — nothing to do' : (ok ? 'Done' : 'Failed'));
    const rows = [
      ['Status', ok ? (r.empty ? 'OK (empty)' : 'OK') : 'Failed'],
      ['Mode', r.mode || (r.dryRun ? 'dry-run' : 'live')],
      ['Dry run', r.dryRun ? 'yes' : 'no'],
      ['Orders UC', r.ucTarget || r.ordersTarget || '—'],
      ['UC base', r.ucBaseUrl || '—'],
      ['Fetched', r.fetched ?? '—'],
      ['Processed', r.processed ?? r.skuCount ?? 0],
      ['OK / failed', `${r.okCount ?? 0} / ${r.failed ?? 0}`],
      ['Created', r.created ?? '—'],
      ['Configured', r.configured === false ? 'missing creds' : 'yes'],
    ];
    return resultHead(ok, msg) + kv(rows);
  }

  async function loadHcStatus() {
    try {
      const s = await api('/api/automations/homecentre/status');
      const badge = $('hc-mode-badge');
      if (badge) {
        badge.textContent = s.modeLabel || 'Staging / Dry-run';
        badge.className = 'badge ' + (s.live ? 'badge-live' : 'badge-staging');
      }
      if ($('hc-owner-meta')) $('hc-owner-meta').textContent = s.ownerEmail ? `Owner: ${s.ownerEmail}` : '';
      if ($('hc-status-kv')) {
        $('hc-status-kv').innerHTML = kv([
          ['Schedule', s.syncMinutes ? `every ${s.syncMinutes} min` : 'manual / disabled'],
          ['Orders target', s.ordersTarget || 'staging'],
          ['Staging UC', s.staging?.configured ? (s.staging.baseUrl || 'configured') : 'creds missing — need HC_UC_STAGING_*'],
          ['UAE UC', s.uae?.configured ? (s.uae.baseUrl || 'configured') : 'creds missing — need HC_UC_UAE_*'],
          ['Vinculum', s.vinculumConfigured ? 'configured' : 'missing'],
          ['Seller UAE', s.sellerCodes?.uae || '75'],
        ]);
      }
      const tb = $('hc-runs-table')?.querySelector('tbody');
      if (tb) {
        const runs = s.recentRuns || [];
        tb.innerHTML = runs.length
          ? runs.map((r) => `<tr>
              <td>${esc(fmt(r.finished_at || r.created_at))}</td>
              <td>${esc(r.action)}</td>
              <td>${esc(r.mode || (r.dryRun ? 'dry-run' : '—'))}</td>
              <td>${esc(r.status)}</td>
              <td>${esc(r.okCount != null ? `${r.okCount}/${r.failed || 0}` : (r.summary || '—'))}</td>
            </tr>`).join('')
          : '<tr><td colspan="5" class="meta">No Home Centre runs yet</td></tr>';
      }
    } catch (err) {
      if ($('hc-status-kv')) $('hc-status-kv').textContent = String(err.message || err);
    }
  }

  $('hc-refresh-status')?.addEventListener('click', () => loadHcStatus());
  $('hc-sync-btn')?.addEventListener('click', () => {
    const dryRun = !!$('hc-dry')?.checked;
    const source = $('hc-source-archive')?.checked ? 'archive' : 'active';
    return runJob({
      btn: $('hc-sync-btn'), out: $('hc-output'),
      working: dryRun
        ? `Previewing Home Centre ${source} orders → staging UC…`
        : `Punching Home Centre ${source} orders → staging UC…`,
      submit: () => api('/api/automations/homecentre/sync', { body: { dryRun, limit: dryRun ? 50 : 1, source } }),
      render: (r) => { loadHcStatus(); return renderHc(r); },
    });
  });

  $('hc-inv-btn')?.addEventListener('click', () => {
    const dryRun = !!$('hc-dry')?.checked;
    return runJob({
      btn: $('hc-inv-btn'), out: $('hc-output'),
      working: 'Pulling UAE UC inventory preview…',
      submit: () => api('/api/automations/homecentre/inventory', { body: { dryRun } }),
      render: (r) => { loadHcStatus(); return renderHc(r); },
    });
  });

  $('hc-fulfill-btn')?.addEventListener('click', () => runJob({
    btn: $('hc-fulfill-btn'), out: $('hc-output'),
    working: 'Fulfill out-of-scope check…',
    submit: () => api('/api/automations/homecentre/fulfill', { body: { dryRun: true, limit: 20 } }),
    render: renderHc,
  }));

  // Load status when opening HC tab
  document.querySelector('[data-tab="homecentre"]')?.addEventListener('click', () => setTimeout(loadHcStatus, 50));

  async function loadSchedulesBoard() {
    const box = $('schedules-board');
    if (!box) return;
    try {
      const { jobs } = await api('/api/schedules');
      box.innerHTML = (jobs || []).map((j) => {
        const on = j.enabled ? 'On' : 'Off';
        const last = j.lastRun
          ? `${esc(j.lastRun.status)} · ${fmt(j.lastRun.finished_at || j.lastRun.created_at)}${j.lastRun.summary ? ' · ' + esc(j.lastRun.summary) : ''}`
          : 'No runs yet';
        return `<div class="panel schedule-card">
          <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
            <div>
              <h3 style="margin:0">${esc(j.name)} <span class="badge">${on}</span></h3>
              <p class="meta" style="margin:6px 0 0">${esc(j.description || '')}</p>
            </div>
            <div class="meta" style="text-align:right">
              ${j.everyMinutes ? `every ${j.everyMinutes}m` : 'manual'}<br/>
              ${j.ownerEmail ? esc(j.ownerEmail) : ''}
              ${j.dryRunDefault ? '<br/>dry-run default' : ''}
              ${j.awaitingHar ? '<br/>awaiting HAR' : ''}
            </div>
          </div>
          <p class="meta" style="margin-top:8px">Steps: ${(j.steps || []).map(esc).join(' · ')}</p>
          <p class="meta">Last: ${last}</p>
        </div>`;
      }).join('') || '<p class="meta">No scheduled jobs configured.</p>';
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  async function loadUcSessionsBoard() {
    const box = $('uc-sessions-board');
    if (!box) return;
    try {
      const payload = await api('/api/uc-session?all=1');
      const sessions = payload.sessions || [];
      box.innerHTML = sessions.length
        ? sessions.map((s) => {
          const id = s.instance_id || '?';
          const st = (s.status || '?').toUpperCase();
          return `<div><b>${esc(id)}</b>: ${st} · cookie ${s.has_cookie ? 'yes' : 'no'} · last OK ${fmt(s.last_ok_at)}</div>`;
        }).join('')
        : '<div class="meta">No sessions loaded yet.</div>';
    } catch {
      box.innerHTML = '<div class="meta">Sign in as ops/admin to see UC sessions.</div>';
    }
  }

  $('uc-connect-open')?.addEventListener('click', async () => {
    const instanceId = $('uc-connect-instance')?.value || 'india';
    try {
      const { url } = await api('/api/admin/uc-login-url?instanceId=' + encodeURIComponent(instanceId));
      window.open(url || 'https://oppdoor.unicommerce.co.in', '_blank', 'noopener');
      toast('Log into Unicommerce in the new tab, then Capture with Session Helper (or Paste session).', 'ok', 7000);
    } catch (e) {
      // Non-admin fallback: open known host
      const hosts = {
        india: 'https://oppdoor.unicommerce.co.in',
        staging: 'https://oppdoorstg.unicommerce.com',
        uae: 'https://opptrauae.unicommerce.com',
        ksa: 'https://opptraksa.unicommerce.com',
      };
      window.open(hosts[instanceId] || hosts.india, '_blank', 'noopener');
      toast(e.message || 'Opened Unicommerce — use Session Helper to capture.', 'ok', 6000);
    }
  });

  $('uc-connect-paste-toggle')?.addEventListener('click', () => {
    $('uc-connect-paste')?.classList.toggle('hidden');
  });

  $('uc-connect-save')?.addEventListener('click', async () => {
    const instanceId = $('uc-connect-instance')?.value || 'india';
    const jsessionid = ($('uc-connect-cookie')?.value || '').trim().replace(/^JSESSIONID=/i, '');
    if (!jsessionid || jsessionid.length < 8) {
      toast('Paste a valid JSESSIONID.', 'bad');
      return;
    }
    try {
      // Admin paste endpoint (same as Admin tab)
      const res = await api('/api/admin/uc-session', {
        method: 'POST',
        body: { jsessionid, instanceId },
      });
      toast(`Saved ${res.instanceId || instanceId} session` + (res.facility ? ` · ${res.facility}` : ''), 'ok');
      $('uc-connect-cookie').value = '';
      loadUcSessionsBoard();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  document.querySelector('[data-tab="schedules"]')?.addEventListener('click', () => {
    setTimeout(() => { loadSchedulesBoard(); loadUcSessionsBoard(); }, 50);
  });

  /* ---------------- India / GCC region toggle ---------------- */
  function setRegion(region) {
    const r = region === 'gcc' ? 'gcc' : 'india';
    localStorage.setItem('opptra_scm_region', r);
    document.body.classList.toggle('region-india', r === 'india');
    document.body.classList.toggle('region-gcc', r === 'gcc');
    $('region-india')?.classList.toggle('active', r === 'india');
    $('region-gcc')?.classList.toggle('active', r === 'gcc');
    // If HC tab hidden while on it, bounce to dashboard
    if (r === 'india' && !$('tab-homecentre')?.classList.contains('hidden')) go('dashboard');
  }
  $('region-india')?.addEventListener('click', () => setRegion('india'));
  $('region-gcc')?.addEventListener('click', () => setRegion('gcc'));
  setRegion(localStorage.getItem('opptra_scm_region') || 'india');

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
    const V = window.OpptraValidate;
    return runJob({
      btn: $('rdc-run-btn'),
      out: $('rdc-output'),
      working: 'Downloading credit note and building Delivery Challan…',
      validate: () => {
        if (!facility) return 'Select a warehouse / facility first.';
        return V?.validateBulkReturnId(bulkReturnId)
          || (!bulkReturnId ? 'Enter one Bulk Return ID like BR0160 (not multiple, not random text)' : null);
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
    const V = window.OpptraValidate;
    return runJob({
      btn: $('packing-preview-btn'), out: $('packing-output'), working: 'Looking up warehouses and email recipients',
      validate: () => V?.validateSaleOrderList(saleOrders) || (!saleOrders.length ? 'Enter at least one SO number.' : null),
      submit: () => api('/api/automations/packing/preview', { body: { saleOrders } }),
      render: (r) => {
        if (r.error) { renderPackingRecipients(null); return errHead(r.error); }
        renderPackingRecipients(r);
        const un = (r.unresolved || []).map((u) => `<li class="bad"><span class="so">${esc(u.so)}</span><span>${esc(u.reason)}</span></li>`).join('');
        return resultHead(!!r.groups?.length, `${r.groups?.length || 0} warehouse group(s) ready - tick recipients, then create drafts`)
          + (r.directoryCount != null ? kv([['Warehouses on email sheet', r.directoryCount]]) : '')
          + (un ? `<p class="result-note">Cannot process:</p><ul class="result-list">${un}</ul>` : '');
      },
    });
  });

  $('packing-btn')?.addEventListener('click', () => {
    const saleOrders = packingSaleOrders();
    const recipients = packingRecipientsFromUi();
    const V = window.OpptraValidate;
    return runJob({
      btn: $('packing-btn'), out: $('packing-output'), working: 'Composing per-warehouse drafts',
      validate: () => {
        const idErr = V?.validateSaleOrderList(saleOrders);
        if (idErr) return idErr;
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
    const V = window.OpptraValidate;
    return runJob({
      btn: $('packing-inveway-btn'), out: $('packing-output'), working: 'Downloading invoices and e-way bills from Unicommerce',
      validate: () => V?.validateSaleOrderList(saleOrders) || (!saleOrders.length ? 'Enter at least one SO number.' : null),
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

  const sheetRun = (action, btn, working, body = () => ({})) => () => {
    const V = window.OpptraValidate;
    return runJob({
      btn: $(btn), out: $('sheet-output'), working,
      validate: () => {
        if (action !== 'first-fill' && action !== 'second-fill') return null;
        const sos = (body()?.saleOrders) || [];
        if (!sos.length) return null; // optional list
        return V?.validateSaleOrderList(sos, 'SO / GP number') || null;
      },
      submit: () => api('/api/automations/sheet/' + action, { body: body() }),
      render: (r) => (!r.ok && r.error) ? errHead(r.error)
        : resultHead(r.ok, r.summary || 'Done') + kv(Object.entries(r.counts || {})) + sheetDetailTable(r.details),
    });
  };
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
    const instanceId = $('admin-uc-instance')?.value || 'india';
    const msg = $('admin-cookie-msg');
    const btn = $('admin-cookie-btn');
    if (!v) { msg.textContent = 'Paste a JSESSIONID first.'; msg.className = 'meta error'; return; }
    setLoading(btn, true);
    msg.className = 'meta';
    msg.textContent = `Testing this session against ${instanceId}…`;
    try {
      // api() throws on non-2xx, but the 400-with-reason body is what we want to show,
      // so read the raw response instead of letting a bad-session 400 look like a network error.
      const res = await fetch('/api/admin/uc-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsessionid: v, instanceId }), credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.alive) {
        msg.className = 'meta ok';
        msg.textContent = `Verified ALIVE on ${data.instanceId || instanceId}${data.facility ? ' / facility ' + data.facility : ''}.`;
        $('admin-cookie').value = '';
        toast(`${data.instanceId || instanceId} session verified ALIVE.`, 'ok');
      } else {
        msg.className = 'meta error';
        msg.textContent = data.error || 'Unicommerce rejected this session.';
        toast('That session did not work: ' + (data.error || 'rejected by Unicommerce'), 'bad');
      }
      refreshDashboard();
      loadAdmin();
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
    // multi-instance session vault (no cookies)
    try {
      const payload = await api('/api/uc-session?all=1');
      const sessions = payload.sessions || (payload.status ? [payload] : []);
      if (sessions.length) {
        $('admin-session-meta').innerHTML = sessions.map((s) => {
          const id = s.instance_id || 'india';
          const st = (s.status || '?').toUpperCase();
          const relogin = s.needs_relogin
            ? ` · <span class="error">re-login needed since ${fmt(s.relogin_since)}</span>`
            : '';
          return `<div><b>${esc(id)}</b>: ${st} · cookie ${s.has_cookie ? 'yes' : 'no'} · source ${esc(s.source || 'none')} · last OK ${fmt(s.last_ok_at)}${relogin}</div>`;
        }).join('');
      } else {
        const s = payload.session || payload;
        $('admin-session-meta').innerHTML = `Status: <b>${(s.status || '?').toUpperCase()}</b> · source: ${esc(s.source)} · last OK: ${fmt(s.last_ok_at)}` +
          (s.needs_relogin ? ` · <span class="error">re-login needed since ${fmt(s.relogin_since)}</span>` : '');
      }
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
      const a = await api('/api/admin/kpi?days=7');
      const t = a.totals || {};
      const inflight = a.inflight || {};
      $('analytics-cards').innerHTML = `
        ${statCard('Succeeded', t.succeeded || 0, 'ok')}
        ${statCard('Failed', t.failed || 0, 'bad')}
        ${statCard('Success rate', a.successRate != null ? a.successRate + '%' : '—', 'ok')}
        ${statCard('In flight', (inflight.queued + inflight.running + inflight.pending) || 0, 'warn')}
        ${statCard('Active users', (a.byUser || []).length, '')}
        ${statCard('Session', (a.session?.status || '?').toUpperCase(), a.session?.status === 'alive' ? 'ok' : 'bad')}`;
      $('autom-table').querySelector('tbody').innerHTML = (a.features || a.byAutomation || []).map((r) => `
        <tr><td>${esc(r.label || r.automation)}</td><td>${r.total}</td><td>${r.ok}</td><td>${r.failed}</td><td>${r.active || 0}</td></tr>`).join('') || emptyRow(5);
      $('user-usage-table').querySelector('tbody').innerHTML = (a.byUser || []).map((r) => `
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

  // E-way batch: same per-SO status list, plus a Download button whenever the worker
  // returned the PDF bytes (fresh generate or an SO that already had an EWB).
  function renderEwayBatch(r) {
    const items = r.results || [];
    const withPdf = items.filter((x) => x.file?.base64).length;
    const head = resultHead(r.failed === 0,
      `E-way bill: ${r.ok ?? 0} ok · ${r.failed ?? 0} failed`
      + (withPdf ? ` · ${withPdf} PDF${withPdf === 1 ? '' : 's'} ready` : ''));
    const list = items.map((x, i) => {
      const line = x.skipped ? `already had EWB ${x.ewb}`
        : x.dryRun ? `would generate · invoice ${x.invoiceCode}`
        : x.ewb ? `EWB ${x.ewb}` : (x.error || '-');
      const note = x.pdfError ? ` <span class="meta">(${esc(x.pdfError)})</span>` : '';
      const dl = x.file?.base64 ? ewayDownloadLink(x.file, `eway-${i}-${x.so}`) : '';
      return `<li class="${x.ok ? 'ok' : 'bad'}"><span class="so">${esc(x.so)}</span>`
        + `<span>${esc(line)}${note}${dl}</span></li>`;
    }).join('');
    const slim = {
      ...r,
      results: items.map(({ file, ...rest }) => (
        file ? { ...rest, file: { filename: file.filename, contentType: file.contentType, base64: '…' } } : rest
      )),
    };
    return head + `<ul class="result-list">${list}</ul>` + raw(slim);
  }

  function ewayDownloadLink(file, slot) {
    try {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType || 'application/pdf' }));
      trackBlobUrl(slot, url);
      return ` <a href="${url}" download="${esc(file.filename)}" class="dl-btn" style="display:inline-block;margin:4px 0 0 8px;padding:4px 10px;font-size:12px">⤓ Download PDF</a>`;
    } catch {
      return '';
    }
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
  const CONNECTOR_LOGOS = {
    'google-sheets': '/assets/connectors/google-sheets.svg',
    'google-drive': '/assets/connectors/google-drive.svg',
    unicommerce: '/assets/connectors/unicommerce.svg',
    waypoint: '/assets/connectors/waypoint.svg',
    homecentre: '/assets/connectors/homecentre.svg',
    amazon: '/assets/connectors/amazon.svg',
    flipkart: '/assets/connectors/flipkart.svg',
    myntra: '/assets/connectors/myntra.svg',
    zepto: '/assets/connectors/zepto.svg',
    blinkit: '/assets/connectors/blinkit.svg',
    instamart: '/assets/connectors/instamart.svg',
    nykaa: '/assets/connectors/nykaa.svg',
    meesho: '/assets/connectors/meesho.svg',
    '6thstreet': '/assets/connectors/6thstreet.svg',
  };
  function connectorIconHtml(c, lg = false) {
    const src = CONNECTOR_LOGOS[c.id];
    const cls = `conn-market-icon${lg ? ' lg' : ''}${src ? ' has-logo' : ''}`;
    if (src) {
      return `<div class="${cls}"><img src="${esc(src)}" alt="" width="20" height="20" decoding="async" /></div>`;
    }
    return `<div class="${cls}">${esc(c.icon || '?')}</div>`;
  }
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

  /* ---------------- Agent · Beta (admin only) ---------------- */
  async function loadAgentTab() {
    if (me?.role !== 'admin') return;
    await Promise.all([loadAgentToolsSummary(), loadAgentThreads(), loadAgentMeta(), loadAgentPlaybooks()]);
    if (agentThreadId) await loadAgentMessages(agentThreadId);
  }

  async function loadAgentMeta() {
    try {
      const m = await api('/api/agent/meta');
      $('agent-llm-mode').textContent = m.llmMode === 'tool-router' ? 'Mode: tool-router' : `Mode: ${m.llmMode}`;
    } catch { /* ignore */ }
  }

  async function loadAgentToolsSummary() {
    const box = $('agent-tools-summary');
    if (!box) return;
    try {
      const { connectors } = await api('/api/agent/connectors');
      const live = (connectors || []).filter((c) => c.live);
      const connected = live.filter((c) => c.connected);
      const sheetBound = (connectors.find((c) => c.id === 'google-sheets')?.resources || []).length;
      const driveBound = (connectors.find((c) => c.id === 'google-drive')?.resources || []).length;
      const chips = connected.map((c) => {
        let label = c.name;
        if (c.id === 'google-sheets') label = `Sheets(${sheetBound})`;
        else if (c.id === 'google-drive') label = `Drive(${driveBound})`;
        const src = CONNECTOR_LOGOS[c.id];
        const icon = src
          ? `<img class="tools-chip-logo" src="${esc(src)}" alt="" width="14" height="14" decoding="async" />`
          : '';
        return `<span class="tools-chip">${icon}${esc(label)}</span>`;
      }).join('') || '<span class="tools-summary-list">None</span>';
      box.innerHTML = `<span class="tools-summary-label">Tools</span>
        <span class="tools-summary-list">${chips}</span>
        <button type="button" class="linkish" id="agent-summary-manage">Manage</button>`;
      $('agent-summary-manage')?.addEventListener('click', () => go('connectors'));
    } catch {
      box.innerHTML = `<button type="button" class="linkish" id="agent-summary-manage">Manage connectors</button>`;
      $('agent-summary-manage')?.addEventListener('click', () => go('connectors'));
    }
  }

  async function loadConnectorsPage(reopenId = null) {
    if (me?.role !== 'admin') return;
    const liveBox = $('connectors-grid-live');
    const soonBox = $('connectors-grid-soon');
    const detail = $('connector-detail');
    if (!liveBox || !soonBox) return;
    try {
      const { connectors } = await api('/api/agent/connectors');
      const live = connectors.filter((c) => c.live);
      const soon = connectors.filter((c) => !c.live);
      const card = (c) => {
        const status = c.status || 'disconnected';
        const statusLabel = status === 'connected' ? 'On'
          : status === 'coming_soon' ? 'Soon'
          : status === 'needs_reconnect' ? 'Reconnect'
          : status === 'ready' ? 'Ready' : 'Off';
        const resCount = Array.isArray(c.resources) ? c.resources.length : 0;
        const blurb = (c.id === 'google-sheets' || c.id === 'google-drive')
          ? (resCount ? `${resCount} bound` : (c.connected ? 'Bind a resource' : (c.connectHint || c.blurb || '')))
          : (c.connectHint || c.blurb || '');
        return `<button type="button" class="conn-market-card ${c.live ? '' : 'soon'}" data-cid="${esc(c.id)}">
          ${connectorIconHtml(c)}
          <div class="conn-market-body">
            <div class="conn-market-name">${esc(c.name)}</div>
            <div class="conn-market-blurb">${esc(blurb)}</div>
          </div>
          <span class="status-pill ${status}">${statusLabel}</span>
        </button>`;
      };
      liveBox.innerHTML = live.map(card).join('');
      soonBox.innerHTML = soon.map(card).join('');

      const renderResourcesBlock = (c) => {
        if (c.id !== 'google-sheets' && c.id !== 'google-drive') return '';
        if (!c.systemReady) {
          return `<div class="conn-resources">
            <p class="meta">Connect Google first, then bind individual ${c.id === 'google-sheets' ? 'spreadsheets' : 'folders/files'} the Agent may use.</p>
          </div>`;
        }
        const resources = Array.isArray(c.resources) ? c.resources : [];
        const placeholder = c.id === 'google-sheets'
          ? 'Paste spreadsheet URL or ID'
          : 'Paste Drive folder/file URL or ID';
        const addLabel = c.id === 'google-sheets' ? 'Add spreadsheet' : 'Add folder / file';
        const list = resources.length
          ? `<ul class="conn-resource-list">${resources.map((r) => `
              <li>
                <div>
                  <strong>${esc(r.name || r.externalId)}</strong>
                  <span class="meta">${esc(r.kind)} · ${esc(String(r.externalId).slice(0, 18))}…</span>
                </div>
                <button type="button" class="secondary compact" data-rm-res="${esc(r.resourceUid)}" data-rm-conn="${esc(c.id)}">Remove</button>
              </li>`).join('')}</ul>`
          : `<p class="meta">No bound resources yet. Agent read/write only works on items you add here.</p>`;
        return `<div class="conn-resources">
          <h4>Bound resources</h4>
          ${list}
          <form class="conn-resource-form" data-add-res="${esc(c.id)}">
            <input type="text" name="name" placeholder="Optional name" maxlength="160" />
            <input type="text" name="url" placeholder="${esc(placeholder)}" required maxlength="500" />
            <button type="submit" class="primary compact">${esc(addLabel)}</button>
          </form>
        </div>`;
      };

      const openDetail = (id) => {
        const c = connectors.find((x) => x.id === id);
        if (!c || !detail) return;
        detail.classList.remove('hidden');
        let actions = '';
        if (!c.live) {
          actions = `<p class="meta">Reverse-engineering in progress. Connect will unlock after HAR/API access.</p>`;
        } else if (c.connectMode === 'google-user') {
          if (c.connected) {
            actions = `<button type="button" class="secondary" data-disc="${esc(c.id)}">Disconnect</button>
              <a class="dl-btn" href="/auth/google/connect?return=connectors">Re-authorize Google</a>`;
          } else {
            actions = `<a class="primary dl-btn" href="${esc(c.oauthUrl || '/auth/google/connect?return=connectors')}">Connect Google</a>`;
          }
        } else if (c.connected) {
          actions = `<button type="button" class="secondary" data-disc="${esc(c.id)}">Disconnect</button>`;
        } else if (c.systemReady) {
          actions = `<button type="button" class="primary" data-conn="${esc(c.id)}">Connect</button>`;
        } else if (c.id === 'unicommerce') {
          actions = `<p class="meta">${esc(c.connectHint || 'Open Scheduled Jobs → Connect Unicommerce (login + Session Helper).')}</p>
            <button type="button" class="primary" data-tab-jump="schedules">Connect Unicommerce</button>`;
        } else {
          actions = `<p class="meta">${esc(c.connectHint)}</p>`;
        }
        detail.innerHTML = `<div class="connector-detail-inner">
          ${connectorIconHtml(c, true)}
          <div>
            <h3>${esc(c.name)}</h3>
            <p>${esc(c.blurb || '')}</p>
            <p class="meta">${esc(c.connectHint || '')}${c.detail?.googleEmail ? ' · ' + esc(c.detail.googleEmail) : ''}</p>
            <div class="row mt-md">${actions}</div>
            ${renderResourcesBlock(c)}
          </div>
          <button type="button" class="secondary" id="connector-detail-close">Close</button>
        </div>`;
        $('connector-detail-close')?.addEventListener('click', () => detail.classList.add('hidden'));
        detail.querySelector('[data-tab-jump]')?.addEventListener('click', () => go('admin'));
        detail.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', () => agentConnect(b.dataset.conn).then(() => loadConnectorsPage(b.dataset.conn))));
        detail.querySelectorAll('[data-disc]').forEach((b) => b.addEventListener('click', () => agentDisconnect(b.dataset.disc).then(() => loadConnectorsPage(b.dataset.disc))));
        detail.querySelectorAll('[data-rm-res]').forEach((b) => b.addEventListener('click', async () => {
          try {
            await api(`/api/agent/connectors/${encodeURIComponent(b.dataset.rmConn)}/resources/${encodeURIComponent(b.dataset.rmRes)}`, { method: 'DELETE' });
            toast('Resource removed.', 'ok');
            await loadConnectorsPage(b.dataset.rmConn);
          } catch (e) { toast(e.message, 'bad'); }
        }));
        detail.querySelectorAll('form[data-add-res]').forEach((form) => {
          form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const fd = new FormData(form);
            const body = {
              name: String(fd.get('name') || '').trim() || undefined,
              url: String(fd.get('url') || '').trim(),
            };
            try {
              await api(`/api/agent/connectors/${encodeURIComponent(form.dataset.addRes)}/resources`, {
                method: 'POST', body,
              });
              toast('Resource bound.', 'ok');
              await loadConnectorsPage(form.dataset.addRes);
            } catch (e) {
              if (/oauth|Connect Google|Reconnect/i.test(e.message)) {
                location.href = '/auth/google/connect?return=connectors';
                return;
              }
              toast(e.message, 'bad');
            }
          });
        });
      };
      [...liveBox.querySelectorAll('[data-cid]'), ...soonBox.querySelectorAll('[data-cid]')].forEach((b) => {
        b.addEventListener('click', () => openDetail(b.dataset.cid));
      });
      if (reopenId) openDetail(reopenId);
    } catch (e) {
      liveBox.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  async function agentConnect(id) {
    try {
      await api('/api/agent/connectors/' + encodeURIComponent(id) + '/connect', { method: 'POST', body: {} });
      toast(id + ' connected.', 'ok');
      await loadAgentToolsSummary();
    } catch (e) {
      if (/oauth|Google account|Reconnect|Missing Google/i.test(e.message)) {
        location.href = '/auth/google/connect?return=connectors';
        return;
      }
      toast(e.message, 'bad');
    }
  }
  async function agentDisconnect(id) {
    try {
      await api('/api/agent/connectors/' + encodeURIComponent(id) + '/disconnect', { method: 'POST', body: {} });
      toast(id + ' disconnected.', 'ok');
      await loadAgentToolsSummary();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function loadAgentThreads() {
    const box = $('agent-threads');
    if (!box) return;
    try {
      const { threads } = await api('/api/agent/threads');
      box.innerHTML = (threads || []).map((t) =>
        `<button type="button" class="agent-thread-chip ${t.thread_uid === agentThreadId ? 'active' : ''}" data-tid="${esc(t.thread_uid)}">${esc(t.title || 'Chat')}</button>`
      ).join('');
      box.querySelectorAll('[data-tid]').forEach((b) => b.addEventListener('click', () => selectAgentThread(b.dataset.tid)));
    } catch { box.innerHTML = ''; }
  }

  async function selectAgentThread(uid) {
    agentThreadId = uid;
    await loadAgentThreads();
    await loadAgentMessages(uid);
  }

  async function loadAgentMessages(uid) {
    const box = $('agent-messages');
    if (!box || !uid) return;
    try {
      const { messages } = await api('/api/agent/threads/' + encodeURIComponent(uid) + '/messages');
      renderAgentMessages(messages || []);
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function renderAgentMessages(messages) {
    const box = $('agent-messages');
    if (!messages.length) {
      box.innerHTML = `<div class="agent-empty" id="agent-empty">
        <h3>Automate your daily ops</h3>
        <p>Connect <b>Sheets</b> &amp; <b>Drive</b>, then describe the work — sheet→sheet, Drive→sheet, UC into Master.</p>
        <p class="agent-empty-hints">Try: <code>list my recent spreadsheets</code> · <code>/uc health</code></p>
      </div>`;
      return;
    }
    box.innerHTML = messages.map((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return '';
      const tools = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const toolHtml = tools.length ? `<div class="agent-tools">${tools.map((t) => {
        const ok = t.status !== 'error';
        const body = esc(JSON.stringify(t.result ?? t.error ?? {}, null, 2));
        return `<details class="agent-tool"><summary><span class="${ok ? 'tool-ok' : 'tool-err'}">${ok ? '●' : '●'}</span> ${esc(t.name || 'tool')}</summary><pre>${body}</pre></details>`;
      }).join('')}</div>` : '';
      return `<div class="agent-msg ${m.role}"><div class="agent-bubble">${esc(m.content || '')}</div>${toolHtml}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  $('agent-manage-connectors')?.addEventListener('click', () => go('connectors'));
  $('agent-empty-connectors')?.addEventListener('click', () => go('connectors'));
  $('connectors-open-agent')?.addEventListener('click', () => go('agent'));

  $('agent-new-chat')?.addEventListener('click', async () => {
    agentThreadId = null;
    $('agent-messages').innerHTML = `<div class="agent-empty"><h3>Build a daily workflow</h3><p>Connect Sheets, bind a spreadsheet, run tools — then Automate daily.</p><p class="agent-empty-hints"><button type="button" class="linkish" id="agent-empty-connectors">Connectors</button></p></div>`;
    $('agent-empty-connectors')?.addEventListener('click', () => go('connectors'));
    await loadAgentThreads();
  });

  // Ops think in IST wall-clock ("9 am"), and the scheduler now stores hour + minute +
  // IANA zone, so offer the real times rather than the UTC hours that could only ever
  // land on :30 IST.
  const SCHEDULE_TZ = 'Asia/Kolkata';

  function fillScheduleHourSelect() {
    const sel = $('agent-schedule-hour');
    if (!sel || sel.options.length) return;
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const opt = document.createElement('option');
        opt.value = `${h}:${m}`;
        opt.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
        if (h === 9 && m === 0) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  }

  function showScheduleBar(show) {
    const bar = $('agent-schedule-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', !show);
    if (show) {
      fillScheduleHourSelect();
      const title = $('agent-schedule-title');
      if (title && !title.value) title.value = 'Daily sheet sync';
      title?.focus();
    }
  }

  async function loadAgentPlaybooks() {
    const box = $('agent-playbooks');
    const label = $('agent-playbooks-label');
    if (!box) return;
    try {
      const { playbooks } = await api('/api/agent/playbooks');
      if (!playbooks?.length) {
        box.innerHTML = '';
        if (label) label.hidden = true;
        return;
      }
      if (label) label.hidden = false;
      box.innerHTML = playbooks.slice(0, 10).map((p) => {
        const daily = p.schedule_kind === 'daily' && p.status === 'active';
        const zone = (p.timezone || 'UTC').split('/').pop().replace('Kolkata', 'IST');
        const when = daily
          ? `${String(p.hour_utc).padStart(2, '0')}:${String(p.schedule_minute ?? 0).padStart(2, '0')} ${zone}`
          : p.status;
        const last = p.last_run_status
          ? ` · last ${p.last_run_status === 'succeeded' ? 'ok' : 'fail'}`
          : '';
        return `<span class="agent-playbook-chip ${daily ? 'active-daily' : ''}">
          ${esc(p.title)}
          <span class="pb-meta">${esc(when)}${esc(last)}</span>
          <button type="button" data-run-pb="${esc(p.playbook_uid)}">Run</button>
          ${p.status === 'active'
            ? `<button type="button" data-pause-pb="${esc(p.playbook_uid)}">Pause</button>`
            : `<button type="button" data-act-pb="${esc(p.playbook_uid)}">Activate</button>`}
        </span>`;
      }).join('');
      box.querySelectorAll('[data-run-pb]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api('/api/agent/playbooks/' + b.dataset.runPb + '/run', { method: 'POST', body: {} });
          toast('Playbook queued on worker.', 'ok');
        } catch (e) { toast(e.message, 'bad'); }
      }));
      box.querySelectorAll('[data-pause-pb]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api('/api/agent/playbooks/' + b.dataset.pausePb + '/pause', { method: 'POST', body: {} });
          toast('Schedule paused (BullMQ scheduler removed).', 'ok');
          await loadAgentPlaybooks();
        } catch (e) { toast(e.message, 'bad'); }
      }));
      box.querySelectorAll('[data-act-pb]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api('/api/agent/playbooks/' + b.dataset.actPb + '/activate', { method: 'POST', body: {} });
          toast('Daily BullMQ schedule activated.', 'ok');
          await loadAgentPlaybooks();
        } catch (e) { toast(e.message, 'bad'); }
      }));
    } catch { box.innerHTML = ''; if (label) label.hidden = true; }
  }

  $('agent-save-daily')?.addEventListener('click', () => {
    if (me?.role !== 'admin') return;
    if (!agentThreadId) {
      toast('Run tools in a chat first, then schedule those steps.', 'bad', 5000);
      return;
    }
    showScheduleBar(true);
  });
  $('agent-schedule-cancel')?.addEventListener('click', () => showScheduleBar(false));
  $('agent-schedule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (me?.role !== 'admin') return;
    const title = ($('agent-schedule-title')?.value || '').trim();
    const [pickedHour, pickedMinute] = String($('agent-schedule-hour')?.value ?? '9:0').split(':');
    if (!title) return;
    try {
      const res = await api('/api/agent/playbooks', {
        body: {
          title,
          threadId: agentThreadId || undefined,
          scheduleKind: 'daily',
          hourUtc: Number(pickedHour) || 0,
          scheduleMinute: Number(pickedMinute) || 0,
          timezone: SCHEDULE_TZ,
          activate: true,
          instruction: title,
        },
      });
      toast(res.note || 'Daily automation scheduled on BullMQ.', 'ok', 6000);
      showScheduleBar(false);
      await loadAgentPlaybooks();
    } catch (err) { toast(err.message, 'bad', 8000); }
  });

  $('agent-composer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (agentBusy || me?.role !== 'admin') return;
    const input = $('agent-input');
    const message = (input?.value || '').trim();
    if (!message) return;
    agentBusy = true;
    $('agent-send').disabled = true;
    input.value = '';
    // Optimistic user bubble
    const empty = $('agent-empty');
    if (empty) empty.remove();
    $('agent-messages').insertAdjacentHTML('beforeend',
      `<div class="agent-msg user"><div class="agent-bubble">${esc(message)}</div></div>
       <div class="agent-msg assistant" id="agent-pending"><div class="agent-bubble">Thinking…</div></div>`);
    $('agent-messages').scrollTop = $('agent-messages').scrollHeight;
    try {
      const res = await api('/api/agent/chat', {
        body: { message, threadId: agentThreadId || undefined },
      });
      agentThreadId = res.threadId;
      await loadAgentThreads();
      await loadAgentMessages(agentThreadId);
    } catch (err) {
      const pending = $('agent-pending');
      if (pending) pending.innerHTML = `<div class="agent-bubble">${esc(err.message)}</div>`;
      toast(err.message, 'bad');
    } finally {
      agentBusy = false;
      $('agent-send').disabled = false;
      input.focus();
    }
  });

  $('agent-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('agent-composer')?.requestSubmit();
    }
  });

  /* ---------------- request an automation ---------------- */
  $('request-automation-btn')?.addEventListener('click', () => $('request-modal').classList.remove('hidden'));
  $('request-close')?.addEventListener('click', () => $('request-modal').classList.add('hidden'));
  $('request-modal')?.addEventListener('click', (e) => { if (e.target === $('request-modal')) $('request-modal').classList.add('hidden'); });

  boot();
})();
