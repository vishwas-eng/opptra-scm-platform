// Agent tool specs + executor, shared by the API (chat) and the worker (playbooks).
//
// The executor takes `invokeUc` as a dependency because the two hosts must reach
// Unicommerce differently:
//   - API: enqueue connector.unicommerce.invoke and poll the Run (only the worker may
//     talk to UC).
//   - Worker: call the connector directly, it IS the UC-talking process. Enqueueing
//     from inside the worker would deadlock a concurrency-1 queue: the playbook job
//     holds the only slot while waiting for the UC job it just queued.
import {
  config, listConnectorResources, resolveBoundResource,
} from '@opptra/core';
import { queryWaypointSOs } from '@opptra/automation-sheet/waypointDb.js';
import { makeVinculumClient } from '@opptra/integrations-vinculum';
import { sheetsApi, driveApi } from '@opptra/integrations-google';
import {
  sanitizeResult, CONNECTOR_ERROR_CODES, connectorError,
} from '@opptra/connectors-sdk';
import { isLiveConnector, COMING_SOON_IDS } from './meta.js';
import {
  agentGoogleFor, mapGoogleToolError, escapeDriveQuery, GOOGLE_RECONNECT_URL,
} from './google.js';

/* ------------------------------ tool specs ------------------------------ */

const SHEET_ID_PROPS = {
  resourceId: { type: 'string', description: 'Bound resourceUid from Connectors (preferred)' },
  spreadsheetId: { type: 'string', description: 'Google spreadsheet id, must already be bound' },
};
const DRIVE_ID_PROPS = {
  resourceId: { type: 'string', description: 'Bound resourceUid from Connectors (preferred)' },
  folderId: { type: 'string', description: 'Drive folder id, must already be bound' },
  fileId: { type: 'string', description: 'Drive file id, must already be bound' },
};

/** The only mimeType values drive_search will filter on (no free-form query expressions). */
const DRIVE_MIME_FILTERS = Object.freeze({
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  document: 'application/vnd.google-apps.document',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
  csv: 'text/csv',
});

/** Tool specs per connector. Single source of truth for chat + playbook validation. */
export const TOOLS_BY_CONNECTOR = {
  unicommerce: [
    { name: 'unicommerce_health_ping', description: 'Ping Unicommerce session health', parameters: { type: 'object', properties: {} } },
    { name: 'unicommerce_facilities_list', description: 'List UC facilities', parameters: { type: 'object', properties: {} } },
    { name: 'unicommerce_sale_order_summary', description: 'Get sale order summary', parameters: { type: 'object', properties: { saleOrder: { type: 'string' } }, required: ['saleOrder'] } },
    { name: 'unicommerce_sale_order_get', description: 'Get full sale order (summary + facility hop)', parameters: { type: 'object', properties: { saleOrder: { type: 'string' } }, required: ['saleOrder'] } },
    { name: 'unicommerce_shipping_packages', description: 'Get shipping packages for a sale order', parameters: { type: 'object', properties: { saleOrder: { type: 'string' }, facility: { type: 'string' } }, required: ['saleOrder'] } },
    { name: 'unicommerce_inventory_snapshot', description: 'Inventory snapshot for up to 100 SKUs', parameters: { type: 'object', properties: { skus: { type: 'array', items: { type: 'string' } }, facility: { type: 'string' } }, required: ['skus'] } },
    { name: 'unicommerce_invoice_details', description: 'Invoices + credit notes for a sale order', parameters: { type: 'object', properties: { saleOrder: { type: 'string' }, facility: { type: 'string' } }, required: ['saleOrder'] } },
    { name: 'unicommerce_line_items', description: 'Per-SKU line items on a sale order', parameters: { type: 'object', properties: { saleOrder: { type: 'string' }, facility: { type: 'string' } }, required: ['saleOrder'] } },
    { name: 'unicommerce_batchwise_inventory', description: 'Shelf/batch level stock for one SKU', parameters: { type: 'object', properties: { sku: { type: 'string' }, facility: { type: 'string' } }, required: ['sku'] } },
    { name: 'unicommerce_shipments_search', description: 'Search the UC shipments grid by status and created-date range (TODAY/YESTERDAY/LAST_WEEK)', parameters: { type: 'object', properties: { statuses: { type: 'array', items: { type: 'string' } }, createdRange: { type: 'string' }, limit: { type: 'integer' }, facility: { type: 'string' } } } },
    { name: 'unicommerce_facilities_channels', description: 'List sales channels configured on the tenant', parameters: { type: 'object', properties: {} } },
  ],
  waypoint: [
    {
      name: 'waypoint_list_orders',
      description: 'List Waypoint sale orders (filter by status/customer/warehouse/date; soCode/poCode for exact lookup)',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'max rows (default 20, cap 50)' },
          soCode: { type: 'string' },
          poCode: { type: 'string' },
          status: { type: 'string', description: 'e.g. CREATED, PROCESSING, DISPATCHED' },
          customer: { type: 'string', description: 'customer code' },
          warehouse: { type: 'string', description: 'dispatch warehouse code' },
          createdFrom: { type: 'string', description: 'ISO date lower bound' },
          createdTo: { type: 'string', description: 'ISO date upper bound' },
        },
      },
    },
  ],
  'google-sheets': [
    { name: 'sheets_list_bound', description: 'List spreadsheets the user bound under Connectors (use resourceId for read/write)', parameters: { type: 'object', properties: {} } },
    { name: 'sheets_list_spreadsheets', description: 'Discover recent Google Spreadsheets visible via OAuth (not a substitute for binding, bind on Connectors to read/write)', parameters: { type: 'object', properties: { pageSize: { type: 'integer' }, nameContains: { type: 'string' } } } },
    { name: 'sheets_list_tabs', description: 'List tab names in a bound spreadsheet', parameters: { type: 'object', properties: SHEET_ID_PROPS } },
    { name: 'sheets_read', description: 'Read values from a bound spreadsheet range (A1). Alias: sheets_get_range', parameters: { type: 'object', properties: { ...SHEET_ID_PROPS, range: { type: 'string' } }, required: ['range'] } },
    { name: 'sheets_get_range', description: 'Read values from a bound sheet range (A1 notation)', parameters: { type: 'object', properties: { ...SHEET_ID_PROPS, range: { type: 'string' } }, required: ['range'] } },
    { name: 'sheets_write', description: 'Write/overwrite values into a bound sheet range (USER_ENTERED). Alias: sheets_update_range', parameters: { type: 'object', properties: { ...SHEET_ID_PROPS, range: { type: 'string' }, values: { type: 'array' } }, required: ['range', 'values'] } },
    { name: 'sheets_update_range', description: 'Write/overwrite values into a bound sheet range (USER_ENTERED). values = 2D array of rows.', parameters: { type: 'object', properties: { ...SHEET_ID_PROPS, range: { type: 'string' }, values: { type: 'array' } }, required: ['range', 'values'] } },
    { name: 'sheets_append_rows', description: 'Append rows to a bound sheet tab/range', parameters: { type: 'object', properties: { ...SHEET_ID_PROPS, range: { type: 'string' }, values: { type: 'array' } }, required: ['range', 'values'] } },
    { name: 'sheets_clear_range', description: 'Clear values in a bound sheet range (keeps formatting)', parameters: { type: 'object', properties: { ...SHEET_ID_PROPS, range: { type: 'string' } }, required: ['range'] } },
    { name: 'sheets_copy_range', description: 'Copy values between bound spreadsheet ranges', parameters: { type: 'object', properties: { sourceResourceId: { type: 'string' }, sourceSpreadsheetId: { type: 'string' }, sourceRange: { type: 'string' }, destResourceId: { type: 'string' }, destSpreadsheetId: { type: 'string' }, destRange: { type: 'string' } }, required: ['sourceRange', 'destRange'] } },
  ],
  'google-drive': [
    { name: 'drive_list_bound', description: 'List Drive folders/files the user bound under Connectors', parameters: { type: 'object', properties: {} } },
    { name: 'drive_search', description: 'Discover Drive files by name (bind on Connectors before list/download)', parameters: { type: 'object', properties: { nameContains: { type: 'string', description: 'substring of the file name' }, mimeType: { type: 'string', enum: ['spreadsheet', 'document', 'folder', 'pdf', 'csv'], description: 'optional type filter' }, pageSize: { type: 'integer' } } } },
    { name: 'drive_list', description: 'List files in a bound Drive folder. Alias: drive_list_folder', parameters: { type: 'object', properties: { resourceId: DRIVE_ID_PROPS.resourceId, folderId: DRIVE_ID_PROPS.folderId, pageSize: { type: 'integer' } } } },
    { name: 'drive_list_folder', description: 'List files in a bound Drive folder id', parameters: { type: 'object', properties: { resourceId: DRIVE_ID_PROPS.resourceId, folderId: DRIVE_ID_PROPS.folderId, pageSize: { type: 'integer' } } } },
    { name: 'drive_get_file_meta', description: 'Get metadata for a bound Drive file', parameters: { type: 'object', properties: { resourceId: DRIVE_ID_PROPS.resourceId, fileId: DRIVE_ID_PROPS.fileId } } },
    { name: 'drive_download', description: 'Download/preview a bound Drive text/csv/json file. Alias: drive_read_text_file', parameters: { type: 'object', properties: { resourceId: DRIVE_ID_PROPS.resourceId, fileId: DRIVE_ID_PROPS.fileId, maxChars: { type: 'integer' } } } },
    { name: 'drive_read_text_file', description: 'Download a small text/csv/json Drive file and return a text preview (truncated)', parameters: { type: 'object', properties: { resourceId: DRIVE_ID_PROPS.resourceId, fileId: DRIVE_ID_PROPS.fileId, maxChars: { type: 'integer' } } } },
  ],
  homecentre: [
    { name: 'homecentre_health_ping', description: 'Home Centre / Vinculum login health', parameters: { type: 'object', properties: {} } },
    { name: 'homecentre_orders_list', description: 'List active Home Centre orders', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } },
    {
      name: 'homecentre_run_operation',
      description: 'Run a Home Centre job for one region and report what it did. Defaults to a dry run, set dryRun:false only when the user explicitly asks to write for real.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['inventory', 'orders'], description: 'inventory = push stock to Home Centre; orders = punch HC orders into Unicommerce' },
          region: { type: 'string', enum: ['uae', 'ksa'], description: 'UAE and KSA are separate marketplaces' },
          dryRun: { type: 'boolean', description: 'default true, preview without writing' },
          limit: { type: 'integer', description: 'max orders to process' },
        },
        required: ['operation', 'region'],
      },
    },
    {
      name: 'homecentre_schedule_operation',
      description: 'Schedule a Home Centre job to run daily at a chosen local time, or turn the schedule off. Run it once first and show the user the result before scheduling.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['inventory', 'orders'] },
          region: { type: 'string', enum: ['uae', 'ksa'] },
          enabled: { type: 'boolean' },
          hour: { type: 'integer', minimum: 0, maximum: 23, description: 'local hour in the region timezone' },
          minute: { type: 'integer', enum: [0, 15, 30, 45] },
          dryRun: { type: 'boolean', description: 'whether the scheduled run writes for real' },
        },
        required: ['operation', 'region', 'enabled'],
      },
    },
  ],
};

/** Map tool name → owning connector id (aliases included). */
const CONNECTOR_BY_TOOL = (() => {
  const map = new Map();
  for (const [connectorId, tools] of Object.entries(TOOLS_BY_CONNECTOR)) {
    for (const t of tools) map.set(t.name, connectorId);
  }
  return map;
})();

const DOTTED_ALIASES = {
  'sheets.read': 'sheets_read',
  'sheets.write': 'sheets_write',
  'sheets.append': 'sheets_append_rows',
  'sheets.clear': 'sheets_clear_range',
  'drive.list': 'drive_list',
  'drive.download': 'drive_download',
};

export function canonicalToolName(name) {
  const raw = String(name || '');
  return DOTTED_ALIASES[raw] || raw;
}

export function connectorForTool(name) {
  return CONNECTOR_BY_TOOL.get(canonicalToolName(name)) || null;
}

export function isKnownTool(name) {
  return CONNECTOR_BY_TOOL.has(canonicalToolName(name));
}

export function buildToolSpecs(connectedLiveIds) {
  const set = new Set((connectedLiveIds || []).filter(isLiveConnector));
  const tools = [];
  for (const [connectorId, specs] of Object.entries(TOOLS_BY_CONNECTOR)) {
    if (set.has(connectorId)) tools.push(...specs);
  }
  return tools;
}

/* ------------------------------ executor ------------------------------ */

/** Mutating tools, playbook UIs surface these, and future approval gates key off this. */
export const MUTATING_TOOLS = new Set([
  'sheets_write', 'sheets_update_range', 'sheets_append_rows', 'sheets_clear_range', 'sheets_copy_range',
]);

function clampRows(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 200).map((row) => {
    if (!Array.isArray(row)) return [String(row ?? '')];
    return row.slice(0, 50).map((c) => (c == null ? '' : String(c).slice(0, 500)));
  });
}

/**
 * @param {{
 *   userEmail: string,
 *   connectedIds: string[],
 *   invokeUc: (action: string, params?: object) => Promise<object>,
 * }} opts
 */
export function makeToolExecutor({ userEmail, connectedIds, invokeUc, runChannelOperation, scheduleChannelOperation }) {
  const set = new Set((connectedIds || []).filter(isLiveConnector));
  if (typeof invokeUc !== 'function') {
    // Fail closed at construction, not on first UC call at 3 AM inside a playbook.
    throw new Error('makeToolExecutor requires invokeUc(action, params)');
  }

  const need = (id) => {
    if (!isLiveConnector(id)) {
      return connectorError(CONNECTOR_ERROR_CODES.COMING_SOON, `${id} is coming soon and cannot be used yet.`);
    }
    if (!set.has(id)) {
      return connectorError(CONNECTOR_ERROR_CODES.NOT_CONNECTED, `Connect ${id} in the Agent connectors panel first.`);
    }
    return null;
  };

  async function resolveSheet(args = {}) {
    return resolveBoundResource({
      userEmail,
      connectorId: 'google-sheets',
      resourceUid: args.resourceId || args.resourceUid || null,
      externalId: args.spreadsheetId || null,
      kinds: ['spreadsheet'],
    });
  }

  async function resolveDrive(args = {}, { preferFolder = false } = {}) {
    const kinds = preferFolder ? ['drive_folder'] : ['drive_folder', 'drive_file'];
    return resolveBoundResource({
      userEmail,
      connectorId: 'google-drive',
      resourceUid: args.resourceId || args.resourceUid || null,
      externalId: args.folderId || args.fileId || null,
      kinds,
    });
  }

  async function runUnicommerce(tool, args) {
    if (tool === 'unicommerce_health_ping') return sanitizeResult(await invokeUc('health.ping'));
    if (tool === 'unicommerce_facilities_list') return sanitizeResult(await invokeUc('facilities.list'));
    if (tool === 'unicommerce_sale_order_summary') {
      return sanitizeResult(await invokeUc('saleOrder.getSummary', { saleOrder: args.saleOrder }));
    }
    if (tool === 'unicommerce_sale_order_get') {
      return sanitizeResult(await invokeUc('saleOrder.get', { saleOrder: args.saleOrder }));
    }
    if (tool === 'unicommerce_shipping_packages') {
      const params = { saleOrder: args.saleOrder };
      if (args.facility) params.facility = args.facility;
      return sanitizeResult(await invokeUc('saleOrder.getShippingPackages', params));
    }
    if (tool === 'unicommerce_inventory_snapshot') {
      const params = { skus: Array.isArray(args.skus) ? args.skus.slice(0, 100) : [] };
      if (args.facility) params.facility = args.facility;
      return sanitizeResult(await invokeUc('inventory.snapshot', params));
    }
    if (tool === 'unicommerce_invoice_details') {
      const params = { saleOrder: args.saleOrder };
      if (args.facility) params.facility = args.facility;
      return sanitizeResult(await invokeUc('saleOrder.getInvoiceDetails', params));
    }
    if (tool === 'unicommerce_line_items') {
      const params = { saleOrder: args.saleOrder };
      if (args.facility) params.facility = args.facility;
      return sanitizeResult(await invokeUc('saleOrder.getLineItems', params));
    }
    if (tool === 'unicommerce_batchwise_inventory') {
      const params = { sku: args.sku };
      if (args.facility) params.facility = args.facility;
      return sanitizeResult(await invokeUc('inventory.batchwise', params));
    }
    if (tool === 'unicommerce_shipments_search') {
      const params = {};
      if (Array.isArray(args.statuses) && args.statuses.length) params.statuses = args.statuses.slice(0, 20);
      if (args.createdRange) params.createdRange = args.createdRange;
      if (args.limit) params.limit = Math.min(Number(args.limit) || 50, 200);
      if (args.facility) params.facility = args.facility;
      return sanitizeResult(await invokeUc('shipments.search', params));
    }
    if (tool === 'unicommerce_facilities_channels') {
      return sanitizeResult(await invokeUc('channels.list'));
    }
    return connectorError(CONNECTOR_ERROR_CODES.UNKNOWN_ACTION, `Unknown Unicommerce tool: ${tool}`);
  }

  async function runWaypoint(args) {
    const cfg = config();
    if (!cfg.WAYPOINT_DB_URL) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED, 'WAYPOINT_DB_URL not configured on the server.');
    }
    const limit = Math.min(Number(args.limit) || 20, 50);
    const rows = await queryWaypointSOs(cfg.WAYPOINT_DB_URL, {
      soCode: args.soCode,
      poCode: args.poCode,
      status: args.status,
      customer: args.customer,
      warehouse: args.warehouse,
      createdFrom: args.createdFrom,
      createdTo: args.createdTo,
      limit,
    });
    return sanitizeResult({ ok: true, count: rows.length, limit, orders: rows });
  }

  async function runSheets(tool, args, g) {
    if (tool === 'sheets_list_bound') {
      const resources = await listConnectorResources({ userEmail, connectorId: 'google-sheets' });
      return sanitizeResult({
        ok: true,
        googleEmail: g.googleEmail,
        resources,
        hint: resources.length
          ? 'Use resourceId with sheets_read / sheets_write.'
          : 'Bind a spreadsheet on Connectors → Google Sheets → Add spreadsheet.',
      });
    }
    if (tool === 'sheets_list_spreadsheets') {
      if (!g.drive) {
        return connectorError(CONNECTOR_ERROR_CODES.SCOPE_MISSING, 'Drive scope missing, reconnect Google', {
          reconnect: true, oauthUrl: GOOGLE_RECONNECT_URL,
        });
      }
      const nameQ = args.nameContains ? ` and name contains '${escapeDriveQuery(args.nameContains)}'` : '';
      const res = await g.drive.files.list({
        q: `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false${nameQ}`,
        pageSize: Math.min(Number(args.pageSize) || 20, 50),
        fields: 'files(id,name,modifiedTime)',
        orderBy: 'modifiedTime desc',
      });
      return sanitizeResult({
        ok: true,
        googleEmail: g.googleEmail,
        spreadsheets: res.data.files || [],
        note: 'Discovery only, bind a spreadsheet on Connectors before sheets_read/write.',
      });
    }

    if (tool === 'sheets_copy_range') {
      if (!args.sourceRange || !args.destRange) {
        return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'sourceRange and destRange required');
      }
      const src = await resolveSheet({
        resourceId: args.sourceResourceId,
        spreadsheetId: args.sourceSpreadsheetId,
      });
      if (!src.ok) return src;
      // resolveBoundResource short-circuits on resourceUid and ignores externalId, so
      // falling back to sourceResourceId here would resolve the DESTINATION to the SOURCE
      // sheet and write over it, while cheerfully echoing the destination id back. Only
      // fall back when the caller named no destination at all (copy within one sheet).
      const destNamed = args.destResourceId || args.destSpreadsheetId;
      const dst = destNamed
        ? await resolveSheet({ resourceId: args.destResourceId, spreadsheetId: args.destSpreadsheetId })
        : src;
      if (!dst.ok) return dst;
      const values = await sheetsApi.read(g.sheets, src.resource.externalId, args.sourceRange);
      const clipped = clampRows(values);
      if (!clipped.length) {
        return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'source range empty');
      }
      await sheetsApi.update(g.sheets, dst.resource.externalId, args.destRange, clipped);
      return sanitizeResult({
        ok: true,
        sourceResourceId: src.resource.resourceUid,
        sourceSpreadsheetId: src.resource.externalId,
        sourceRange: args.sourceRange,
        destResourceId: dst.resource.resourceUid,
        destSpreadsheetId: dst.resource.externalId,
        destRange: args.destRange,
        rowsCopied: clipped.length,
      });
    }

    const resolved = await resolveSheet(args);
    if (!resolved.ok) return resolved;
    const sid = resolved.resource.externalId;
    const resourceId = resolved.resource.resourceUid;

    if (tool === 'sheets_list_tabs') {
      const tabs = await sheetsApi.listTabs(g.sheets, sid);
      return sanitizeResult({ ok: true, resourceId, spreadsheetId: sid, name: resolved.resource.name, tabs });
    }
    if (tool === 'sheets_read' || tool === 'sheets_get_range') {
      const range = args.range || 'A1:G20';
      const values = await sheetsApi.read(g.sheets, sid, range);
      return sanitizeResult({
        ok: true, resourceId, spreadsheetId: sid, name: resolved.resource.name,
        range,
        values: values.slice(0, 80),
        totalRows: values.length,
        truncated: values.length > 80,
      });
    }
    if (tool === 'sheets_write' || tool === 'sheets_update_range') {
      const values = clampRows(args.values);
      if (!values.length) return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'values required (2D array)');
      if (!args.range) return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'range required');
      await sheetsApi.update(g.sheets, sid, args.range, values);
      return sanitizeResult({ ok: true, resourceId, spreadsheetId: sid, range: args.range, rowsWritten: values.length });
    }
    if (tool === 'sheets_append_rows') {
      const values = clampRows(args.values);
      if (!values.length) return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'values required (2D array)');
      if (!args.range) return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'range required');
      await sheetsApi.append(g.sheets, sid, args.range, values);
      return sanitizeResult({ ok: true, resourceId, spreadsheetId: sid, range: args.range, rowsAppended: values.length });
    }
    if (tool === 'sheets_clear_range') {
      if (!args.range) return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'range required');
      await sheetsApi.clear(g.sheets, sid, args.range);
      return sanitizeResult({ ok: true, resourceId, spreadsheetId: sid, range: args.range, cleared: true });
    }
    return connectorError(CONNECTOR_ERROR_CODES.UNKNOWN_ACTION, `Unknown Sheets tool: ${tool}`);
  }

  async function runDrive(tool, args, g) {
    if (tool === 'drive_list_bound') {
      const resources = await listConnectorResources({ userEmail, connectorId: 'google-drive' });
      return sanitizeResult({
        ok: true,
        googleEmail: g.googleEmail,
        resources,
        hint: resources.length
          ? 'Use resourceId with drive_list / drive_download.'
          : 'Bind a folder or file on Connectors → Google Drive → Add folder.',
      });
    }
    if (tool === 'drive_search') {
      // Deliberately NOT a raw `q` passthrough. A free-form Drive query would let anything
      // that reaches the model, including text read out of a bound sheet or CSV, i.e.
      // content an outsider can influence, enumerate the user's entire Drive
      // (`fullText contains 'password'`), straight past the bind-first ACL that every
      // other Drive/Sheets tool enforces. Only a name substring and a fixed type filter.
      const clauses = ['trashed = false'];
      if (args.nameContains) clauses.push(`name contains '${escapeDriveQuery(args.nameContains)}'`);
      const mime = DRIVE_MIME_FILTERS[String(args.mimeType || '').toLowerCase()];
      if (mime) clauses.push(`mimeType = '${mime}'`);
      else clauses.push("mimeType != 'application/vnd.google-apps.folder'");
      const q = clauses.join(' and ');
      const res = await g.drive.files.list({
        q,
        pageSize: Math.min(Number(args.pageSize) || 15, 40),
        fields: 'files(id,name,mimeType,modifiedTime,size)',
        orderBy: 'modifiedTime desc',
      });
      return sanitizeResult({
        ok: true,
        googleEmail: g.googleEmail,
        files: res.data.files || [],
        note: 'Discovery only, bind on Connectors before drive_list/download.',
      });
    }
    if (tool === 'drive_list' || tool === 'drive_list_folder') {
      const resolved = await resolveDrive(
        { resourceId: args.resourceId, folderId: args.folderId },
        { preferFolder: true },
      );
      if (!resolved.ok) return resolved;
      if (resolved.resource.kind !== 'drive_folder') {
        return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'drive_list requires a bound folder (not a file).');
      }
      const files = await driveApi.listFolder(g.drive, resolved.resource.externalId);
      return sanitizeResult({
        ok: true,
        resourceId: resolved.resource.resourceUid,
        folderId: resolved.resource.externalId,
        name: resolved.resource.name,
        files: files.slice(0, Math.min(Number(args.pageSize) || 50, 100)),
      });
    }
    if (tool === 'drive_get_file_meta') {
      const resolved = await resolveDrive({ resourceId: args.resourceId, fileId: args.fileId });
      if (!resolved.ok) return resolved;
      const res = await g.drive.files.get({
        fileId: resolved.resource.externalId,
        fields: 'id,name,mimeType,modifiedTime,size,parents,webViewLink',
      });
      return sanitizeResult({ ok: true, resourceId: resolved.resource.resourceUid, file: res.data });
    }
    if (tool === 'drive_download' || tool === 'drive_read_text_file') {
      const resolved = await resolveDrive({ resourceId: args.resourceId, fileId: args.fileId });
      if (!resolved.ok) return resolved;
      const fileId = resolved.resource.externalId;
      const meta = await g.drive.files.get({ fileId, fields: 'id,name,mimeType,size' });
      const mime = meta.data.mimeType || '';
      const maxChars = Math.min(Number(args.maxChars) || 8000, 20000);
      let buf;
      if (mime === 'application/vnd.google-apps.document') {
        const res = await g.drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
        buf = Buffer.from(res.data);
      } else if (mime === 'application/vnd.google-apps.spreadsheet') {
        const res = await g.drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'arraybuffer' });
        buf = Buffer.from(res.data);
      } else if (/^text\/|json|csv|xml/i.test(mime) || /\.(csv|txt|json|tsv)$/i.test(meta.data.name || '')) {
        buf = await driveApi.getFileBytes(g.drive, fileId);
      } else {
        return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT,
          `Cannot preview binary type ${mime}. Use drive_get_file_meta.`);
      }
      const text = buf.toString('utf8');
      return sanitizeResult({
        ok: true,
        resourceId: resolved.resource.resourceUid,
        file: { id: meta.data.id, name: meta.data.name, mimeType: mime, size: meta.data.size },
        text: text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text,
        truncated: text.length > maxChars,
      });
    }
    return connectorError(CONNECTOR_ERROR_CODES.UNKNOWN_ACTION, `Unknown Drive tool: ${tool}`);
  }

  async function runHomecentre(tool, args) {
    const cfg = config();
    if (!cfg.VINCULUM_USER || !cfg.VINCULUM_PASS) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED, 'VINCULUM_USER / VINCULUM_PASS not configured');
    }
    try {
      const client = makeVinculumClient({
        baseUrl: cfg.VINCULUM_BASE_URL,
        userName: cfg.VINCULUM_USER,
        password: cfg.VINCULUM_PASS,
      });
      if (tool === 'homecentre_health_ping') {
        await client.login();
        return sanitizeResult({ ok: true, backend: 'vinculum', portal: 'Home Centre' });
      }
      if (tool === 'homecentre_orders_list') {
        const limit = Math.min(Number(args.limit) || 20, 50);
        const data = await client.listActiveOrders({ page: 1, rows: limit });
        return sanitizeResult({
          ok: true,
          count: data.orders?.length || 0,
          records: data.records,
          orders: (data.orders || []).slice(0, limit),
        });
      }
      if (tool === 'homecentre_run_operation') {
        if (typeof runChannelOperation !== 'function') {
          return connectorError(CONNECTOR_ERROR_CODES.INTERNAL,
            'Channel operations can only be started from the app, not from this context.');
        }
        // Dry-run unless the user asked otherwise IN WORDS. An agent must never infer
        // permission to write to a live marketplace from an ambiguous instruction.
        const dryRun = args.dryRun !== false;
        const r = await runChannelOperation({
          connectorId: 'homecentre',
          region: args.region,
          operation: args.operation,
          dryRun,
          limit: args.limit,
          userEmail,
        });
        return sanitizeResult(r);
      }

      if (tool === 'homecentre_schedule_operation') {
        if (typeof scheduleChannelOperation !== 'function') {
          return connectorError(CONNECTOR_ERROR_CODES.INTERNAL,
            'Schedules can only be changed from the app, not from this context.');
        }
        const r = await scheduleChannelOperation({
          connectorId: 'homecentre',
          region: args.region,
          operation: args.operation,
          enabled: !!args.enabled,
          hour: args.hour ?? 9,
          minute: args.minute ?? 0,
          dryRun: args.dryRun !== false,
          userEmail,
        });
        return sanitizeResult(r);
      }

      return connectorError(CONNECTOR_ERROR_CODES.UNKNOWN_ACTION, `Unknown Home Centre tool: ${tool}`);
    } catch (err) {
      return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, String(err.message || err));
    }
  }

  return async function executeTool(name, args = {}) {
    const tool = canonicalToolName(name);
    const connectorId = connectorForTool(tool);

    if (!connectorId) {
      const marketplacePrefix = new RegExp(`^(${COMING_SOON_IDS.join('|')})_`);
      if (marketplacePrefix.test(tool)) {
        return connectorError(CONNECTOR_ERROR_CODES.COMING_SOON,
          'This marketplace connector is coming soon and cannot be used yet.');
      }
      return connectorError(CONNECTOR_ERROR_CODES.UNKNOWN_ACTION, `Unknown tool: ${tool}`);
    }

    const blocked = need(connectorId);
    if (blocked) return blocked;

    if (connectorId === 'unicommerce') return runUnicommerce(tool, args);
    if (connectorId === 'waypoint') {
      try { return await runWaypoint(args); }
      catch (err) {
        return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, `Waypoint DB error: ${String(err.message || err)}`);
      }
    }
    if (connectorId === 'homecentre') return runHomecentre(tool, args);

    // Sheets / Drive need a per-user Google client.
    let g;
    try { g = await agentGoogleFor(userEmail); }
    catch (err) { return mapGoogleToolError(err); }
    if (!g?.sheets || !g?.drive) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED,
        `Connect your Google account in Connectors (${connectorId === 'google-sheets' ? 'Sheets' : 'Drive'})`,
        { reconnect: true, oauthUrl: GOOGLE_RECONNECT_URL });
    }
    try {
      if (connectorId === 'google-sheets') return await runSheets(tool, args, g);
      return await runDrive(tool, args, g);
    } catch (err) {
      return mapGoogleToolError(err);
    }
  };
}
