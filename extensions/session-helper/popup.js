/* Opptra Session Helper — reads the Unicommerce JSESSIONID cookie (with the user's
 * cookies permission, after THEY logged in) and POSTs it to the platform ingest
 * endpoint. No password handling, no login automation. */

const UC_DOMAINS = [
  { url: 'https://oppdoor.unicommerce.co.in', label: 'production' },
  { url: 'https://oppdoorstg.unicommerce.com', label: 'staging' },
];

const $ = (id) => document.getElementById(id);
const show = (text, ok) => { const m = $('msg'); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); };

// Load saved settings.
chrome.storage.local.get(['platform', 'token'], (s) => {
  if (s.platform) $('platform').value = s.platform;
  if (s.token) $('token').value = s.token;
});

$('save').addEventListener('click', () => {
  const platform = $('platform').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  chrome.storage.local.set({ platform, token }, () => show('Settings saved.', true));
});

$('capture').addEventListener('click', async () => {
  const platform = $('platform').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!platform || !token) { show('Enter platform URL and token, then Save.', false); return; }

  // Find the JSESSIONID cookie on whichever UC domain the user is logged into.
  let found = null;
  for (const d of UC_DOMAINS) {
    const cookie = await chrome.cookies.get({ url: d.url, name: 'JSESSIONID' }).catch(() => null);
    if (cookie && cookie.value) { found = { value: cookie.value, label: d.label }; break; }
  }
  if (!found) { show('No Unicommerce session found. Log into Unicommerce first, then retry.', false); return; }

  try {
    const res = await fetch(platform + '/api/ingest/uc-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsessionid: found.value, token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { show('Rejected: ' + (data.error || res.status), false); return; }
    show(`✓ ${found.label} session captured & sent. You can close this.`, true);
  } catch (err) {
    show('Send failed: ' + err.message, false);
  }
});
