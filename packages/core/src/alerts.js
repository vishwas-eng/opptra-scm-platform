// Fail-loud alerting. Slack webhook if configured; always logged. Alerts must never
// themselves throw into business code — they swallow their own errors after logging.
import { config } from './config.js';
import { logger } from './logger.js';

const lastSent = new Map(); // key -> ts, simple dedup so a flapping check can't spam

export async function alert(key, message, detail = {}) {
  logger.error({ alertKey: key, detail }, `ALERT: ${message}`);
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < 10 * 60_000) return; // at most one Slack ping per key per 10 min
  lastSent.set(key, now);

  const { SLACK_WEBHOOK_URL, PUBLIC_URL } = config();
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:rotating_light: *${message}*\n${Object.entries(detail).map(([k, v]) => `• ${k}: ${String(v).slice(0, 200)}`).join('\n')}\n<${PUBLIC_URL}|open platform>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'slack alert non-200');
  } catch (err) {
    logger.warn({ err }, 'slack alert failed (alerting must not break the caller)');
  }
}
