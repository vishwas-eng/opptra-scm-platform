// BullMQ wiring (API side): the API only ENQUEUES — all Unicommerce traffic runs in
// the worker so exactly one process owns the session. waitForResult lets synchronous
// UI actions (e.g. "process this SO") block briefly for the outcome.
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '@opptra/core';

let _conn = null;
let _queue = null;
let _events = null;

export function redis() {
  if (!_conn) {
    _conn = new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }
  return _conn;
}

export function automationQueue() {
  if (!_queue) {
    _queue = new Queue('automations', {
      connection: redis(),
      defaultJobOptions: {
        removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
        removeOnFail: { age: 30 * 24 * 3600 },
        attempts: 1, // business-level retries are handled per-automation, not blindly
      },
    });
  }
  return _queue;
}

export function queueEvents() {
  if (!_events) {
    _events = new QueueEvents('automations', { connection: new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null }) });
  }
  return _events;
}

export async function enqueue(name, payload, opts = {}) {
  return automationQueue().add(name, payload, opts);
}

/** Enqueue and wait up to timeoutMs for the worker's result (UI-synchronous actions). */
export async function enqueueAndWait(name, payload, timeoutMs = 120_000) {
  const job = await enqueue(name, payload);
  return job.waitUntilFinished(queueEvents(), timeoutMs);
}

export async function closeQueues() {
  await Promise.allSettled([_queue?.close(), _events?.close(), _conn?.quit()]);
  _queue = null; _events = null; _conn = null;
}
