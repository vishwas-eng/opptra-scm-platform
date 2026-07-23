// BullMQ wiring (API side): the API only ENQUEUES - all Unicommerce traffic runs in
// the worker so exactly one process owns the session. waitForResult lets synchronous
// UI actions (e.g. "process this SO") block briefly for the outcome.
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '@opptra/core';

let _conn = null;
let _queue = null;

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

// Producer backpressure: with a concurrency-1 worker, an unbounded queue against a
// noeviction Redis is an outage waiting to happen. Reject new work past this depth.
const MAX_QUEUE_DEPTH = 2000;

export async function enqueue(name, payload, opts = {}) {
  const q = automationQueue();
  const depth = (await q.getWaitingCount()) + (await q.getDelayedCount());
  if (depth >= MAX_QUEUE_DEPTH) {
    const err = new Error(`queue is full (${depth} jobs waiting). Try again shortly.`);
    err.statusCode = 503;
    throw err;
  }
  return q.add(name, payload, opts);
}

export async function closeQueues() {
  await Promise.allSettled([_queue?.close(), _conn?.quit()]);
  _queue = null; _conn = null;
}
