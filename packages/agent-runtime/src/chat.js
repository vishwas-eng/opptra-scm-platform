import { llmTurn, llmModeLabel, DEFAULT_SYSTEM, truncJson } from './llm.js';
import { routeIntent } from './router.js';
import { sanitizeResult } from '@opptra/connectors-sdk';

export { llmTurn, llmModeLabel, routeIntent, DEFAULT_SYSTEM, truncJson };

/**
 * Run one agent turn: LLM tool-use loop (max 3 rounds) or tool-router fallback.
 * @param {{
 *   cfg: object,
 *   message: string,
 *   history?: Array<{role,content}>,
 *   tools: Array<{name,description,parameters}>,
 *   executeTool: (name, args) => Promise<object>,
 *   connectedIds: string[],
 * }} opts
 */
export async function runAgentTurn({
  cfg,
  message,
  history = [],
  tools = [],
  executeTool,
  connectedIds = [],
}) {
  const mode = llmModeLabel(cfg);
  const toolTrace = [];
  const sysExtra = connectedIds.length
    ? `\nConnected connectors: ${connectedIds.join(', ')}.`
    : '\nNo connectors connected — tell user to Connect in the panel.';

  // --- Tool-router path (no LLM key) ---
  if (mode === 'tool-router') {
    const routed = routeIntent(message);
    if (routed?.help && !routed.toolCalls?.length) {
      return {
        mode,
        content: routed.help,
        toolCalls: [],
      };
    }
    for (const tc of routed?.toolCalls || []) {
      const result = await safeExec(executeTool, tc.name, tc.args || {});
      toolTrace.push({
        id: tc.id,
        name: tc.name,
        args: tc.args || {},
        status: result.ok === false ? 'error' : 'ok',
        result: sanitizeResult(result),
        error: result.ok === false ? (result.error || null) : null,
      });
    }
    const content = toolTrace.length
      ? summarizeTools(toolTrace)
      : (routed?.help || 'No matching command. Type /help.');
    return { mode, content, toolCalls: toolTrace };
  }

  // --- LLM path ---
  const messages = [
    ...history.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' })),
    { role: 'user', content: message },
  ];

  let finalContent = '';
  for (let round = 0; round < 3; round++) {
    const turn = await llmTurn({
      cfg,
      messages,
      tools,
      system: DEFAULT_SYSTEM + sysExtra,
    });
    if (turn.toolCalls?.length) {
      // Record assistant tool call message for openai-style follow-up
      messages.push({
        role: 'assistant',
        content: turn.content || '',
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
          name: tc.name,
          args: tc.args || {},
        })),
      });
      for (const tc of turn.toolCalls) {
        const result = await safeExec(executeTool, tc.name, tc.args || {});
        const scrubbed = sanitizeResult(result);
        toolTrace.push({
          id: tc.id,
          name: tc.name,
          args: tc.args || {},
          status: result.ok === false ? 'error' : 'ok',
          result: scrubbed,
          error: result.ok === false ? (result.error || null) : null,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: truncJson(scrubbed, 3000),
        });
      }
      continue;
    }
    finalContent = turn.content || '';
    break;
  }

  if (!finalContent && toolTrace.length) finalContent = summarizeTools(toolTrace);
  if (!finalContent) finalContent = 'Done.';
  return { mode, content: finalContent, toolCalls: toolTrace };
}

async function safeExec(executeTool, name, args) {
  try {
    return await executeTool(name, args);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function summarizeTools(trace) {
  return trace.map((t) => {
    if (t.status === 'error') return `**${t.name}** failed: ${t.error || 'error'}`;
    const preview = truncJson(t.result, 600);
    return `**${t.name}** → ${preview}`;
  }).join('\n\n');
}
