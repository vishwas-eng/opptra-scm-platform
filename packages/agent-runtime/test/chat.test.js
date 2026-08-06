import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../src/chat.js';

// No LLM key → tool-router mode, which is deterministic and needs no network.
const CFG = {};

function collect() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

test('a tool-router turn emits tool_start before tool_end, then the message', async () => {
  const { events, onEvent } = collect();
  const result = await runAgentTurn({
    cfg: CFG,
    message: '/uc health',
    tools: [],
    connectedIds: ['unicommerce'],
    executeTool: async () => ({ ok: true, alive: true }),
    onEvent,
  });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['tool_start', 'tool_end', 'message']);
  assert.equal(events[0].name, events[1].name, 'start and end describe the same call');
  assert.equal(events[1].status, 'ok');
  assert.equal(events[2].content, result.content, 'the streamed message is the final answer');
});

test('a failing tool is reported as an error step, not a thrown turn', async () => {
  const { events, onEvent } = collect();
  const result = await runAgentTurn({
    cfg: CFG,
    message: '/uc health',
    tools: [],
    connectedIds: ['unicommerce'],
    executeTool: async () => { throw new Error('portal down'); },
    onEvent,
  });
  const end = events.find((e) => e.type === 'tool_end');
  assert.equal(end.status, 'error');
  assert.match(end.error, /portal down/);
  assert.equal(result.toolCalls[0].status, 'error');
});

test('tool results reaching the UI are sanitized', async () => {
  const { events, onEvent } = collect();
  await runAgentTurn({
    cfg: CFG,
    message: '/uc health',
    tools: [],
    connectedIds: ['unicommerce'],
    executeTool: async () => ({ ok: true, cookie: 'JSESSIONID=SUPERSECRET', note: 'JSESSIONID=ALSOSECRET' }),
    onEvent,
  });
  const end = events.find((e) => e.type === 'tool_end');
  const json = JSON.stringify(end);
  assert.ok(!json.includes('SUPERSECRET'), 'secret keys must be redacted in streamed events');
  assert.ok(!json.includes('ALSOSECRET'), 'secret VALUES must be redacted too');
});

test('a help-only turn still emits its message, so the stream never ends silently', async () => {
  const { events, onEvent } = collect();
  await runAgentTurn({
    cfg: CFG, message: '/help', tools: [], connectedIds: [],
    executeTool: async () => ({ ok: true }), onEvent,
  });
  assert.deepEqual(events.map((e) => e.type), ['message']);
  assert.ok(events[0].content.length);
});

test('a listener that throws cannot break the turn', async () => {
  const result = await runAgentTurn({
    cfg: CFG,
    message: '/uc health',
    tools: [],
    connectedIds: ['unicommerce'],
    executeTool: async () => ({ ok: true }),
    onEvent: () => { throw new Error('browser went away'); },
  });
  assert.ok(result.content, 'the turn completes and still returns its answer');
});

test('omitting onEvent yields exactly the same result (events are additive)', async () => {
  const args = {
    cfg: CFG, message: '/uc health', tools: [], connectedIds: ['unicommerce'],
    executeTool: async () => ({ ok: true, alive: true }),
  };
  const withoutEvents = await runAgentTurn(args);
  const withEvents = await runAgentTurn({ ...args, onEvent: () => {} });
  assert.deepEqual(withoutEvents, withEvents);
});
