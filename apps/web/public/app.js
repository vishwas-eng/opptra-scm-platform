/* Opptra SCM Platform — web shell (no build step; plain ES2020). */
(() => {
  const $ = (id) => document.getElementById(id);
  let me = null;
  let pollTimer = null;

  /* ---------------- api helper ---------------- */
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
    const { googleClientId } = await api('/api/config');
    const mount = () => {
      window.google.accounts.id.initialize({ client_id: googleClientId, callback: onCredential });
      window.google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_black', size: 'large', width: 280 });
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
    } catch { /* showLogin already triggered on 401 */ }
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = me.name || me.email;
    $('user-pic').src = me.picture || '';
    if (me.role === 'admin') $('admin-tab-btn').classList.remove('hidden');
    refreshDashboard();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshDashboard, 10_000);
  }

  $('logout-btn')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  });

  /* ---------------- tabs ---------------- */
  document.querySelectorAll('#tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
      $('tab-' + btn.dataset.tab).classList.remove('hidden');
      if (btn.dataset.tab === 'admin') loadAdmin();
    });
  });

  /* ---------------- dashboard ---------------- */
  async function refreshDashboard() {
    try {
      const s = await api('/api/uc-session');
      const el = $('session-status');
      const cls = s.status === 'alive' ? 'ok' : s.status === 'dead' ? 'bad' : 'warn';
      el.className = 'big ' + cls;
      el.textContent = s.status.toUpperCase();
      $('session-meta').textContent =
        `source: ${s.source} · last OK: ${fmt(s.last_ok_at)} · checked: ${fmt(s.last_check_at)}` +
        (s.fail_count ? ` · fails: ${s.fail_count}` : '');
      const banner = $('session-banner');
      if (s.status === 'dead' || !s.has_cookie) {
        banner.textContent = '⚠ Unicommerce session is not alive — automations are paused. ' +
          (me.role === 'admin' ? 'Paste a fresh JSESSIONID in the Admin tab.' : 'Ask an admin to refresh it.');
        banner.classList.remove('hidden');
      } else banner.classList.add('hidden');

      const { runs } = await api('/api/runs?limit=30');
      $('runs-table').querySelector('tbody').innerHTML = runs.map((r) => `
        <tr>
          <td>${fmt(r.created_at)}</td>
          <td>${esc(r.user_email)}</td>
          <td>${esc(r.automation)}</td>
          <td>${esc(r.action)}</td>
          <td><code>${esc(shortInput(r.input))}</code></td>
          <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
        </tr>`).join('');
    } catch { /* transient — next poll retries */ }
  }

  /* ---------------- return tab ---------------- */
  $('ret-status-btn')?.addEventListener('click', () => runReturn('status'));
  $('ret-run-btn')?.addEventListener('click', () => runReturn('process'));

  async function runReturn(kind) {
    const so = $('ret-so').value.trim();
    const out = $('ret-output');
    if (!so) { out.textContent = 'Enter a Sale Order code.'; out.classList.remove('hidden'); return; }
    const btn = kind === 'status' ? $('ret-status-btn') : $('ret-run-btn');
    btn.disabled = true;
    out.classList.remove('hidden');
    out.textContent = kind === 'status' ? 'Checking status…' : 'Queued — the worker is processing (this can take a few minutes)…';
    try {
      const body = kind === 'status'
        ? await api('/api/automations/uc/so-status', { body: { saleOrder: so } })
        : await api('/api/automations/return/process', {
            body: {
              saleOrder: so,
              cancelSO: $('ret-cancel').value.trim() || null,
              returnIn: $('ret-return-in').checked,
              deliver: $('ret-deliver').checked,
            },
          });
      const final = await pollRun(body.runUid, out);
      out.textContent = JSON.stringify(final, null, 2);
    } catch (err) {
      out.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function pollRun(runUid, out, timeoutMs = 10 * 60_000) {
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      const run = await api('/api/runs/' + runUid);
      if (['succeeded', 'failed'].includes(run.status)) return run;
      if (run.status === 'pending_retry') out.textContent = 'Pending (UC async step) — auto-retrying…\n' + JSON.stringify(run.result || {}, null, 2);
      if (Date.now() - t0 > timeoutMs) return run;
    }
  }

  /* ---------------- admin tab ---------------- */
  $('admin-cookie-btn')?.addEventListener('click', async () => {
    const v = $('admin-cookie').value.trim();
    const msg = $('admin-cookie-msg');
    if (!v) { msg.textContent = 'Paste a JSESSIONID first.'; return; }
    try {
      await api('/api/admin/uc-session', { body: { jsessionid: v } });
      msg.textContent = '✓ Saved. The next keep-alive/automation call will use it.';
      $('admin-cookie').value = '';
      refreshDashboard();
    } catch (err) { msg.textContent = 'Error: ' + err.message; }
  });

  async function loadAdmin() {
    try {
      const { users } = await api('/api/admin/users');
      $('users-table').querySelector('tbody').innerHTML = users.map((u) => `
        <tr>
          <td>${esc(u.email)}</td>
          <td>${esc(u.name)}</td>
          <td>
            <select data-email="${esc(u.email)}" class="role-select">
              ${['admin', 'ops', 'viewer'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </td>
          <td>${u.is_active ? '✓' : '✗'}</td>
          <td>${fmt(u.last_login)}</td>
        </tr>`).join('');
      document.querySelectorAll('.role-select').forEach((sel) => {
        sel.addEventListener('change', async () => {
          await api('/api/admin/users/' + encodeURIComponent(sel.dataset.email), { body: { role: sel.value } });
        });
      });
    } catch { /* non-admin or transient */ }
  }

  /* ---------------- utils ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const shortInput = (input) => {
    if (!input) return '';
    const o = typeof input === 'string' ? JSON.parse(input) : input;
    return o.saleOrder || o.code || JSON.stringify(o).slice(0, 40);
  };

  boot();
})();
