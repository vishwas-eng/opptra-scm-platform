// RFC 2822 MIME builder for Gmail (draft/send). Pure + testable — no googleapis here.
// Produces a base64url raw message with optional file attachments.

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {object} m
 * @param {string|string[]} m.to
 * @param {string}  [m.from]     display From (delegated sender)
 * @param {string}  m.subject
 * @param {string}  m.htmlBody
 * @param {Array<{filename:string, contentType:string, buffer:Buffer}>} [m.attachments]
 * @returns {string} base64url raw message for gmail.users.messages/drafts
 */
export function buildRawMessage({ to, from, subject, htmlBody, attachments = [] }) {
  const toHeader = Array.isArray(to) ? to.join(', ') : to;
  const boundary = 'opptra_' + Buffer.from(subject + toHeader).toString('hex').slice(0, 16);
  const headers = [
    `To: ${toHeader}`,
    from ? `From: ${from}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');

  const parts = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
  ];
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      Buffer.from(att.buffer).toString('base64').replace(/(.{76})/g, '$1\r\n'),
    );
  }
  parts.push(`--${boundary}--`, '');

  return b64url(`${headers}\r\n\r\n${parts.join('\r\n')}`);
}

// Encode non-ASCII subjects per RFC 2047 (so unicode subjects don't break).
function encodeHeader(s) {
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s;
}
