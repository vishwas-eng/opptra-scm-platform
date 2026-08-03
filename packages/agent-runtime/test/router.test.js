import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from '../src/router.js';
import { llmModeLabel } from '../src/llm.js';

test('tool-router matches /uc health', () => {
  const r = routeIntent('/uc health');
  assert.equal(r.toolCalls[0].name, 'unicommerce_health_ping');
});

test('tool-router help', () => {
  const r = routeIntent('/help');
  assert.ok(r.help.includes('Tool-router'));
});

test('llmModeLabel falls back to tool-router without key', () => {
  assert.equal(llmModeLabel({ AGENT_LLM_PROVIDER: 'auto', agentLlmApiKey: '' }), 'tool-router');
});
