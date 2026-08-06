/* Opptra Connector Capture — popup.
 * Two jobs: start/stop a portal recording (background.js does the work), and the
 * legacy one-click Unicommerce JSESSIONID capture. */

const UC_DOMAINS = [
  { url: 'https://oppdoor.unicommerce.co.in', label: 'india', instanceId: 'india' },
  { url: 'https://oppdoorstg.unicommerce.com', label: 'staging', instanceId: 'staging' },
  { url: 'https://opptrauae.unicommerce.com', label: 'uae', instanceId: 'uae' },
  { url: 'https://opptraksa.unicommerce.com', label: 'ksa', instanceId: 'ksa' },
];

/* Portals we can record. `hosts` are the domains whose traffic is recorded — keep them
 * tight so a capture never sweeps up unrelated browsing. */
const CHANNELS = [
  { id: 'amazon', name: 'Amazon Seller Central', open: 'https://sellercentral.amazon.in', hosts: ['amazon.in', 'amazon.ae', 'amazon.sa', 'sellercentral.amazon.com'] },
  { id: 'flipkart', name: 'Flipkart Seller Hub', open: 'https://seller.flipkart.com', hosts: ['flipkart.com', 'flipkart.net'] },
  { id: 'myntra', name: 'Myntra Partner', open: 'https://partners.myntra.com', hosts: ['myntra.com'] },
  { id: 'nykaa', name: 'Nykaa Seller', open: 'https://seller.nykaa.com', hosts: ['nykaa.com'] },
  { id: 'ajio', name: 'Ajio Seller', open: 'https://ajio.com', hosts: ['ajio.com', 'ril.com', 'reliancedigital.in'] },
  { id: 'noon', name: 'noon Seller Lab', open: 'https://sellerlab.noon.com', hosts: ['noon.com', 'noon.partners'] },
  { id: 'namshi', name: 'Namshi Seller', open: 'https://namshi.com', hosts: ['namshi.com', 'noon.com'] },
  { id: '6thstreet', name: '6th Street', open: 'https://sellerportal.6thstreet.com', hosts: ['6thstreet.com', 'ibmcloud.com'] },
  { id: 'meesho', name: 'Meesho Supplier', open: 'https://supplier.meesho.com', hosts: ['meesho.com'] },
  { id: 'zepto', name: 'Zepto Vendor', open: 'https://brands.zepto.co.in', hosts: ['zepto.co.in', 'zeptonow.com'] },
  { id: 'blinkit', name: 'Blinkit Seller', open: 'https://sellerhub.blinkit.com', hosts: ['blinkit.com', 'grofers.com'] },
  { id: 'instamart', name: 'Swiggy Instamart', open: 'https://partner.swiggy.com', hosts: ['swiggy.com'] },
  { id: 'homecentre', name: 'Home Centre (Vinculum)', open: 'https://landmarkgroup.vinsupplier.com/eRetailWeb/', hosts: ['vinsupplier.com'] },
];

const $ = (id) => document.getElementById(id);
const show = (text, ok) => {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'err');
};

/* ------------------------------- settings ------------------------------- */

const sel = $('connector');
for (const c of CHANNELS) {
  const o = document.createElement('option');
  o.value = c.id;
  o.textContent = c.name;
  sel.appendChild(o);
}

chrome.storage.local.get(['platform', 'token', 'instanceId', 'connectorId'], (s) => {
  if (s.platform) $('platform').value = s.platform;
  if (s.token) $('token').value = s.token;
  if (s.instanceId) $('instance').value = s.instanceId;
  if (s.connectorId) sel.value = s.connectorId;
});

$('save').addEventListener('click', () => {
  chrome.storage.local.set({
    platform: $('platform').value.trim().replace(/\/+$/, ''),
    token: $('token').value.trim(),
    instanceId: $('instance').value,
    connectorId: sel.value,
  }, () => show('Settings saved.', true));
});

/* --------------------------------- tabs --------------------------------- */

function switchTab(which) {
  $('tab-capture').classList.toggle('on', which === 'capture');
  $('tab-uc').classList.toggle('on', which === 'uc');
  $('tab-capture-btn').classList.toggle('on', which === 'capture');
  $('tab-uc-btn').classList.toggle('on', which === 'uc');
}
$('tab-capture-btn').addEventListener('click', () => switchTab('capture'));
$('tab-uc-btn').addEventListener('click', () => switchTab('uc'));

/* ------------------------------- recording ------------------------------- */

function renderStatus(st) {
  const recording = !!st?.recording;
  $('start').disabled = recording;
  $('stop').disabled = !recording;
  sel.disabled = recording;
  $('stats').innerHTML = recording
    ? `<span class="rec"></span>recording ${st.connectorId} — ${st.seen} requests seen, ${st.sent} uploaded${st.dropped ? `, ${st.dropped} dropped` : ''}${st.lastError ? `<br>⚠ ${st.lastError}` : ''}`
    : '';
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'status' }, renderStatus);
}
refreshStatus();
setInterval(refreshStatus, 1500);

$('start').addEventListener('click', () => {
  const platform = $('platform').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!platform || !token) return show('Enter platform URL and access token, then Save.', false);

  const channel = CHANNELS.find((c) => c.id === sel.value);
  show(`Starting capture for ${channel.name}…`, true);
  chrome.runtime.sendMessage({
    type: 'start',
    platform, token,
    connectorId: channel.id,
    hosts: channel.hosts,
    openUrl: channel.open,
    label: `${channel.name} capture`,
  }, (r) => {
    if (!r?.ok) return show(`Could not start: ${r?.error || 'unknown error'}`, false);
    show('Recording. Log in, then visit Orders / Inventory / a shipment once each.', true);
    refreshStatus();
  });
});

$('stop').addEventListener('click', () => {
  show('Finishing and analyzing…', true);
  chrome.runtime.sendMessage({ type: 'stop' }, (r) => {
    if (!r?.ok) return show(`Stopped, but analysis failed: ${r?.error || 'unknown error'}`, false);
    const s = r.capture?.analysis?.summary || {};
    show(
      `✓ Capture complete.\n${s.entries || 0} requests → ${s.endpoints || 0} endpoints on ${s.primaryHost || 'unknown host'}.\n`
      + `${r.capture?.session_saved ? 'Session sealed into the vault.' : 'No session found — check you were logged in.'}\n`
      + 'Open the Connectors page to review the blueprint.',
      true,
    );
    refreshStatus();
  });
});

/* --------------------------- Unicommerce (legacy) --------------------------- */

$('open-uc').addEventListener('click', () => {
  const d = UC_DOMAINS.find((x) => x.instanceId === $('instance').value) || UC_DOMAINS[0];
  chrome.tabs.create({ url: d.url });
});

$('uc-capture').addEventListener('click', async () => {
  const platform = $('platform').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  const preferred = $('instance').value;
  if (!platform || !token) return show('Enter platform URL and token, then Save.', false);

  const ordered = [
    ...UC_DOMAINS.filter((d) => d.instanceId === preferred),
    ...UC_DOMAINS.filter((d) => d.instanceId !== preferred),
  ];
  let found = null;
  for (const d of ordered) {
    const cookie = await chrome.cookies.get({ url: d.url, name: 'JSESSIONID' }).catch(() => null);
    if (cookie?.value) {
      found = { value: cookie.value, label: d.label, instanceId: d.instanceId, baseUrl: d.url };
      break;
    }
  }
  if (!found) return show('No Unicommerce session found. Open UC, log in, then Capture.', false);

  try {
    const res = await fetch(platform + '/api/ingest/uc-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsessionid: found.value, token, instanceId: found.instanceId, baseUrl: found.baseUrl,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return show('Rejected: ' + (data.error || res.status), false);
    show(`✓ ${found.label} session captured (${data.instanceId || found.instanceId}).`, true);
  } catch (err) {
    show('Send failed: ' + err.message, false);
  }
});
