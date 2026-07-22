// Popup: collect SO numbers, hand the batch to the background worker, show live progress.
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['base', 'doctype'], (s) => { if (s.base) $('base').value = s.base; if (s.doctype) $('doctype').value = s.doctype; });

function logLine(cls, text) {
  const d = document.createElement('div');
  d.className = 'r ' + (cls || '');
  d.textContent = text;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}

// live progress from the background worker
chrome.runtime.onMessage.addListener((m) => {
  if (m.type !== 'progress') return;
  if (m.ok) logLine('ok', `${m.so} → ${m.count} file(s)` + (m.matched && m.matched !== m.so ? ` (as ${m.matched})` : '') + (m.facility ? ` [${m.facility}]` : ''));
  else logLine('err', `${m.so} → ${m.error || 'failed'}`);
});

$('go').addEventListener('click', async () => {
  const base = $('base').value.trim().replace(/\/+$/, '');
  const doc = $('doctype').value;
  const sos = $('sos').value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  chrome.storage.local.set({ base, doctype: doc });

  if (!sos.length) { logLine('err', 'Enter at least one SO number.'); return; }
  $('log').innerHTML = '';
  $('go').disabled = true;
  $('count').textContent = `working… (${sos.length} SO)`;
  logLine('muted', `Downloading ${doc === 'eway' ? 'e-way bills' : 'invoices'} for ${sos.length} order(s)…`);

  try {
    const res = await chrome.runtime.sendMessage({ type: 'downloadBatch', base, sos, doc });
    if (res && res.ok) $('count').textContent = `done: ${res.done} file(s), ${res.failSos} SO failed`;
    else $('count').textContent = `error: ${res && res.error ? res.error : 'failed'}`;
  } catch (e) {
    $('count').textContent = `error: ${e.message}`;
  }
  $('go').disabled = false;
});
