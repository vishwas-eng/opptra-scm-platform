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

test('new UC intents route to the specific tool, not the generic summary', () => {
  assert.equal(routeIntent('invoice details for SO02780').toolCalls[0].name, 'unicommerce_sale_order_get');
  assert.equal(routeIntent('packages for SO02780').toolCalls[0].name, 'unicommerce_shipping_packages');
  assert.equal(routeIntent('stock for sku OPT-123').toolCalls[0].name, 'unicommerce_inventory_snapshot');
  // The generic rule still wins when nothing more specific matched.
  assert.equal(routeIntent('so SO02780').toolCalls[0].name, 'unicommerce_sale_order_summary');
});

test('routed UC args carry the parsed identifier', () => {
  assert.deepEqual(routeIntent('packages for so02780').toolCalls[0].args, { saleOrder: 'SO02780' });
  assert.deepEqual(routeIntent('inventory for sku OPT-9').toolCalls[0].args, { skus: ['OPT-9'] });
});
