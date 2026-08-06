/* Opptra Session Helper — reads Unicommerce JSESSIONID after YOU log in
 * and POSTs it to the platform ingest endpoint (per-instance vault). */

const UC_DOMAINS = [
  { url: 'https://oppdoor.unicommerce.co.in', label: 'india', instanceId: 'india' },
  { url: 'https://oppdoorstg.unicommerce.com', label: 'staging', instanceId: 'staging' },
  { url: 'https://opptrauae.unicommerce.com', label: 'uae', instanceId: 'uae' },
  { url: 'https://opptraksa.unicommerce.com', label: 'ksa', instanceId: 'ksa' },
];

const $ = (id) => document.getElementById(id);
const show = (text, ok) => {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'err');
};

chrome.storage.local.get(['platform', 'token', 'instanceId'], (s) => {
  if (s.platform) $('platform').value = s.platform;
  if (s.token) $('token').value = s.token;
  if (s.instanceId && $('instance')) $('instance').value = s.instanceId;
});

$('save').addEventListener('click', () => {
  const platform = $('platform').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  const instanceId = $('instance')?.value || 'india';
  chrome.storage.local.set({ platform, token, instanceId }, () => show('Settings saved.', true));
});

$('open-uc').addEventListener('click', () => {
  const instanceId = $('instance')?.value || 'india';
  const d = UC_DOMAINS.find((x) => x.instanceId === instanceId) || UC_DOMAINS[0];
  chrome.tabs.create({ url: d.url });
});

$('capture').addEventListener('click', async () => {
  const platform = $('platform').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  const preferred = $('instance')?.value || 'india';
  if (!platform || !token) {
    show('Enter platform URL and token, then Save.', false);
    return;
  }

  // Prefer the selected instance cookie; else first cookie found on any known host.
  let found = null;
  const ordered = [
    ...UC_DOMAINS.filter((d) => d.instanceId === preferred),
    ...UC_DOMAINS.filter((d) => d.instanceId !== preferred),
  ];
  for (const d of ordered) {
    const cookie = await chrome.cookies.get({ url: d.url, name: 'JSESSIONID' }).catch(() => null);
    if (cookie && cookie.value) {
      found = { value: cookie.value, label: d.label, instanceId: d.instanceId, baseUrl: d.url };
      break;
    }
  }
  if (!found) {
    show('No Unicommerce session found. Click Open Unicommerce, log in, then Capture.', false);
    return;
  }

  try {
    const res = await fetch(platform + '/api/ingest/uc-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsessionid: found.value,
        token,
        instanceId: found.instanceId,
        baseUrl: found.baseUrl,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      show('Rejected: ' + (data.error || res.status), false);
      return;
    }
    show(`✓ ${found.label} session captured (${data.instanceId || found.instanceId}).`, true);
  } catch (err) {
    show('Send failed: ' + err.message, false);
  }
});
