// Report / export-job actions — the exact 4-step contract proven in production by
// uc-fmcg-daily-reports (config → create → poll list → download):
//   1. GET  /data/tasks/export/config/get?exportConfigName=<name>   → columns + filters
//   2. POST /data/tasks/export/job/create                            → { exportJobId }
//      NOTE: the field really is spelled `exportColums` — Unicommerce's own typo, and
//      the required spelling. Do not "fix" it.
//   3. GET  /data/user/exportJobs                                    → poll by id
//   4. GET  <exportFilePath> with the session cookie                 → CSV bytes
//
// A successful job with exportCount 0 has NO exportFilePath — that is an empty report,
// not a failure. All endpoints are facility-scoped session calls.

const EXPORT_JOB_TERMINAL_OK = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS']);
const EXPORT_JOB_TERMINAL_FAIL = new Set(['FAILED', 'ERROR', 'CANCELLED']);

export function registerReportActions(register) {
  register({
    id: 'reports.exportTypes',
    title: 'List export report types',
    mutates: false,
    backend: 're',
    description: 'GET /data/tasks/export/configs — every export job type this tenant can run (names are tenant-specific; probe before hardcoding).',
    inputSchema: { type: 'object', additionalProperties: false, properties: { facility: { type: 'string', maxLength: 60 } } },
    handler: async (uc, params) => {
      const opts = params.facility ? { facility: params.facility } : {};
      const d = await uc.dataGet('/data/tasks/export/configs', opts);
      const configs = d?.exportConfigs || d?.configs || [];
      const found = Array.isArray(configs) && configs.length > 0;
      return {
        ok: true,
        count: found ? configs.length : 0,
        configs: found ? configs : [],
        // Key names only when the probe misses — never the raw body (secret/PII risk).
        ...(found ? {} : { responseKeys: d && typeof d === 'object' ? Object.keys(d).slice(0, 25) : [] }),
      };
    },
  });

  register({
    id: 'reports.exportConfigGet',
    title: 'Get export report config',
    mutates: false,
    backend: 're',
    description: 'GET /data/tasks/export/config/get?exportConfigName=<name> — column ids + filter ids for one report type (e.g. "DATATABLE SEARCH INVENTORY").',
    inputSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 120 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const name = String(params.name || '').trim();
      const opts = params.facility ? { facility: params.facility } : {};
      const d = await uc.dataGet(
        `/data/tasks/export/config/get?exportConfigName=${encodeURIComponent(name)}`,
        opts,
      );
      const columns = (d?.exportColumns || []).map((c) => ({ id: c.id, exportable: c.exportable !== false }));
      const filters = (d?.exportFilters || []).map((f) => ({ id: f.id, type: f.type || f.filterType || null }));
      return {
        ok: true,
        name,
        exists: !!(columns.length || filters.length),
        columns,
        filters,
      };
    },
  });

  register({
    id: 'reports.exportJobCreate',
    title: 'Create export job',
    mutates: true, // creates a server-side job; dry-run previews the exact body instead
    backend: 're',
    description: 'POST /data/tasks/export/job/create — ONETIME export. Columns default to every exportable column from the config. dateFilterId + fromMs/toMs add one date-range filter.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 120, description: 'exportJobTypeName, e.g. "DATATABLE SEARCH INVENTORY"' },
        columns: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 80 } },
        dateFilterId: { type: 'string', maxLength: 60, description: 'e.g. createdIn / addedOn — from reports.exportConfigGet' },
        fromMs: { type: 'integer', description: 'epoch ms lower bound (needs dateFilterId)' },
        toMs: { type: 'integer', description: 'epoch ms upper bound (needs dateFilterId)' },
        reportName: { type: 'string', maxLength: 120 },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const name = String(params.name || '').trim();
      const opts = params.facility ? { facility: params.facility } : {};

      let columns = Array.isArray(params.columns) ? params.columns.filter(Boolean) : [];
      if (!columns.length) {
        const cfgRes = await uc.dataGet(
          `/data/tasks/export/config/get?exportConfigName=${encodeURIComponent(name)}`,
          opts,
        );
        columns = (cfgRes?.exportColumns || [])
          .filter((c) => c.exportable !== false)
          .map((c) => c.id);
        if (!columns.length) {
          return { ok: false, error: `report type "${name}" not found for this tenant (no exportable columns)` };
        }
      }

      const exportFilters = [];
      // `!= null`, not truthiness: fromMs 0 is a legitimate epoch bound and must not
      // silently drop the filter (which would export the entire history instead).
      if (params.dateFilterId && (params.fromMs != null || params.toMs != null)) {
        exportFilters.push({
          id: params.dateFilterId,
          dateRange: { start: params.fromMs || 0, end: params.toMs || Date.now() },
        });
      }

      const body = {
        exportJobTypeName: name,
        exportColums: columns, // sic — see file header
        exportFilters,
        notificationEmail: '',
        frequency: 'ONETIME',
        reportName: String(params.reportName || name).slice(0, 120),
        cronExpression: null,
      };
      const d = await uc.data('/data/tasks/export/job/create', body, opts);
      return {
        ok: d?.successful !== false,
        exportJobId: d?.exportJobId ?? null,
        name,
        columns: columns.length,
        filters: exportFilters.length,
      };
    },
  });

  register({
    id: 'reports.exportJobsList',
    title: 'List export jobs',
    mutates: false,
    backend: 're',
    description: 'GET /data/user/exportJobs — current user\'s export jobs with status + download path. Terminal OK: COMPLETE/COMPLETED/SUCCESS; fail: FAILED/ERROR/CANCELLED.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exportJobId: { type: ['integer', 'string'], description: 'filter to one job' },
        facility: { type: 'string', maxLength: 60 },
      },
    },
    handler: async (uc, params) => {
      const opts = params.facility ? { facility: params.facility } : {};
      const d = await uc.dataGet('/data/user/exportJobs', opts);
      let jobs = (d?.exportJobs || []).map((j) => ({
        id: j.id,
        statusCode: j.statusCode,
        successful: j.successful,
        exportFilePath: j.exportFilePath || null,
        exportCount: j.exportCount ?? null,
        done: EXPORT_JOB_TERMINAL_OK.has(String(j.statusCode || '').toUpperCase()),
        failed: EXPORT_JOB_TERMINAL_FAIL.has(String(j.statusCode || '').toUpperCase()),
      }));
      if (params.exportJobId != null && params.exportJobId !== '') {
        const want = String(params.exportJobId);
        jobs = jobs.filter((j) => String(j.id) === want);
      }
      return { ok: true, count: jobs.length, jobs };
    },
  });
}
