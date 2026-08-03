// Deterministic tool-router when no LLM key is configured.
// Matches slash commands and natural-ish intents to connector tools.

const RULES = [
  {
    re: /^\/(?:uc\s+)?health\b|^\/ping\b/i,
    tool: 'unicommerce_health_ping',
    args: () => ({}),
  },
  {
    re: /^\/(?:uc\s+)?facilities\b|list\s+facilit/i,
    tool: 'unicommerce_facilities_list',
    args: () => ({}),
  },
  {
    re: /(?:^|\b)(?:uc\s+)?(?:so|sale\s*order)\s*[:#]?\s*([A-Z0-9_-]{3,40})\b/i,
    tool: 'unicommerce_sale_order_summary',
    args: (m) => ({ saleOrder: m[1].toUpperCase() }),
  },
  {
    re: /^\/so\s+(\S+)/i,
    tool: 'unicommerce_sale_order_summary',
    args: (m) => ({ saleOrder: m[1].toUpperCase() }),
  },
  {
    re: /(?:health|alive|session)\s+(?:of\s+)?(?:uc|unicommerce)|(?:uc|unicommerce).{0,20}(?:health|alive|status|ping)/i,
    tool: 'unicommerce_health_ping',
    args: () => ({}),
  },
  {
    re: /(?:list|show|get)\s+(?:uc\s+)?facilit/i,
    tool: 'unicommerce_facilities_list',
    args: () => ({}),
  },
  {
    re: /waypoint.{0,30}(?:order|so)|(?:list|show|fetch).{0,20}waypoint/i,
    tool: 'waypoint_list_orders',
    args: () => ({ limit: 20 }),
  },
  {
    re: /^\/waypoint\b/i,
    tool: 'waypoint_list_orders',
    args: () => ({ limit: 20 }),
  },
  {
    re: /(?:read|get|show)\s+(?:sheet|spreadsheet)|sheets?\s+range|\/sheets?\b/i,
    tool: 'sheets_get_range',
    args: () => ({ range: 'Master!A1:G20' }),
  },
  {
    re: /list\s+(?:my\s+)?(?:recent\s+)?spreadsheets?|\/sheets?\s+list\b/i,
    tool: 'sheets_list_spreadsheets',
    args: () => ({ pageSize: 20 }),
  },
  {
    re: /(?:search|find|list)\s+(?:drive|files?)|\/drive\b/i,
    tool: 'drive_search',
    args: () => ({ query: "mimeType != 'application/vnd.google-apps.folder'", pageSize: 10 }),
  },
  {
    re: /(?:home\s*centre|homecentre|vinculum).{0,20}(?:health|ping|status)|(?:^\/(?:hc|homecentre)\s+health)/i,
    tool: 'homecentre_health_ping',
    args: () => ({}),
  },
  {
    re: /(?:home\s*centre|homecentre|vinculum).{0,30}order|\/(?:hc|homecentre)\s+orders/i,
    tool: 'homecentre_orders_list',
    args: () => ({ limit: 20 }),
  },
];

/**
 * @returns {{ toolCalls: Array<{id:string,name:string,args:object}>, help?: string } | null}
 */
export function routeIntent(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (/^\/help\b/i.test(text) || /^help\b/i.test(text)) {
    return {
      toolCalls: [],
      help: [
        'Tool-router mode (no LLM key). Try:',
        '• `/uc health` — Unicommerce session ping',
        '• `/uc facilities` — list facilities',
        '• `/so SO02696` — sale order summary',
        '• `/waypoint` — recent Waypoint SOs',
        '• `/sheets` — peek Master sheet range',
        '• `/drive` — recent Drive files',
        '• `/hc health` — Home Centre (Vinculum) login',
        'Connectors must show Connected in the panel (live only).',
      ].join('\n'),
    };
  }

  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) {
      return {
        toolCalls: [{
          id: `router_${rule.tool}_${Date.now()}`,
          name: rule.tool,
          args: rule.args(m) || {},
        }],
      };
    }
  }

  return {
    toolCalls: [],
    help: 'I could not match that in tool-router mode. Type `/help` for commands, or set AGENT_LLM_API_KEY for natural language.',
  };
}
