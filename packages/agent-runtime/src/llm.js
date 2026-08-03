// LLM provider abstraction. Prefer real LLM when AGENT_LLM_* / OPENAI_ / ANTHROPIC_ key exists.
// Cost-aware: short system prompt, truncated tool results, low max_tokens.

const DEFAULT_SYSTEM = `You are Opptra SCM Agent — an ops automation helper (Beta).
Opptra's daily work runs on Google Sheets, Drive, and email, plus Unicommerce / Waypoint / Home Centre.
Help users: read/write sheets, copy sheet→sheet, find Drive files, pull UC/Waypoint data into sheets.
Use only connected tools. If Sheets/Drive aren't connected, tell them to Connect first.
Prefer concrete tool calls over vague advice. Be concise. Never invent credentials or secrets.
When the user describes a recurring daily task, outline the steps and suggest "Save as daily automation".`;

function resolveProvider(cfg) {
  const key = cfg.agentLlmApiKey || '';
  if (!key || cfg.AGENT_LLM_PROVIDER === 'none') return { provider: 'none', key: '' };
  let provider = cfg.AGENT_LLM_PROVIDER || 'auto';
  if (provider === 'auto') {
    if (cfg.ANTHROPIC_API_KEY && !cfg.AGENT_LLM_API_KEY && !cfg.OPENAI_API_KEY) provider = 'anthropic';
    else if (String(cfg.AGENT_LLM_BASE_URL || '').includes('anthropic')) provider = 'anthropic';
    else if (key.startsWith('sk-ant-')) provider = 'anthropic';
    else provider = 'openai';
  }
  return { provider, key };
}

function truncJson(val, max = 3500) {
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated]`;
}

/** OpenAI-compatible chat completions with optional tools. */
async function openaiChat({ key, baseUrl, model, messages, tools }) {
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: model || 'gpt-4o-mini',
    messages,
    temperature: 0.2,
    max_tokens: 1024,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
    body.tool_choice = 'auto';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    args: safeParse(tc.function?.arguments),
  }));
  return { content: msg.content || '', toolCalls, raw: msg };
}

/** Anthropic Messages API with tools. */
async function anthropicChat({ key, baseUrl, model, messages, tools, system }) {
  const url = `${(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  const anthTools = (tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
  // Convert OpenAI-ish history → Anthropic messages (skip system).
  const anthMsgs = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      anthMsgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: truncJson(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      anthMsgs.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.tool_calls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name || tc.function?.name,
            input: tc.args || safeParse(tc.function?.arguments) || {},
          })),
        ],
      });
      continue;
    }
    anthMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
  }
  const body = {
    model: model || 'claude-3-5-haiku-latest',
    max_tokens: 1024,
    system: system || DEFAULT_SYSTEM,
    messages: anthMsgs,
  };
  if (anthTools.length) body.tools = anthTools;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const blocks = data.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
    id: b.id,
    name: b.name,
    args: b.input || {},
  }));
  return { content: text, toolCalls, raw: data };
}

function safeParse(s) {
  if (s == null || s === '') return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * One LLM turn. Returns { mode, content, toolCalls }.
 * mode: 'llm' | 'none'
 */
export async function llmTurn({ cfg, messages, tools, system = DEFAULT_SYSTEM }) {
  const { provider, key } = resolveProvider(cfg);
  if (provider === 'none' || !key) {
    return { mode: 'none', content: '', toolCalls: [] };
  }
  const model = cfg.AGENT_LLM_MODEL || '';
  const baseUrl = cfg.AGENT_LLM_BASE_URL || '';
  if (provider === 'anthropic') {
    return {
      mode: 'llm',
      provider: 'anthropic',
      ...(await anthropicChat({ key, baseUrl, model, messages, tools, system })),
    };
  }
  // openai-compatible: prepend system into messages
  const withSys = messages[0]?.role === 'system'
    ? messages
    : [{ role: 'system', content: system }, ...messages];
  return {
    mode: 'llm',
    provider: 'openai',
    ...(await openaiChat({ key, baseUrl, model, messages: withSys, tools })),
  };
}

export function llmModeLabel(cfg) {
  const { provider, key } = resolveProvider(cfg);
  if (!key || provider === 'none') return 'tool-router';
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

export { DEFAULT_SYSTEM, truncJson, resolveProvider };
