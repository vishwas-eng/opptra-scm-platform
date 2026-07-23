// ASN compile - ported from b2b AsnFill.gs (SO-only path, the reliable one).
//   1. hop facilities → POST /data/oms/saleorder/fetch { code }  (RSG first - many Myntra B2B SOs live there)
//   2. map saleOrderItems → rows (this SO only)
//   3. write the channel file (Flipkart/Myntra XLSX · Zepto CSV)
import { rowsFromSaleOrderDto, poFromDto } from './rows.js';
import { writeFlipkart, writeMyntra, writeZepto } from './writers.js';

const DEFAULT_FACILITIES = ['Opp_RSG_MH', 'Opp_WIQ_MH_1', 'Opp_BSB_HR_1P', 'Opp_WIQ_KA', 'Opp_WIQ_HR'];

export function makeAsnPipeline(uc, cfg = {}) {
  // RSG first, then the configured/default facilities (deduped).
  const configured = String(cfg.UC_ASN_FACILITIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const facilities = [...new Set(['Opp_RSG_MH', ...configured, ...DEFAULT_FACILITIES])];

  async function fetchSoDto(so) {
    for (const facility of facilities) {
      const res = await uc.data('/data/oms/saleorder/fetch', { code: so }, { facility }).catch(() => null);
      const dto = res && res.successful !== false ? res.saleOrderDTO : null;
      if (dto && (dto.code || (dto.saleOrderItems || []).length)) return { dto, facility };
    }
    return null;
  }

  async function compile(so, channel) {
    const ch = String(channel || 'flipkart').toLowerCase().trim();
    if (!['flipkart', 'myntra', 'zepto'].includes(ch)) throw new Error(`unsupported channel: ${channel}`);

    const found = await fetchSoDto(so);
    if (!found) return { ok: false, error: `SO ${so} not found (or not invoiced) in any facility` };

    const rows = rowsFromSaleOrderDto(found.dto, so);
    if (!rows.length) return { ok: false, error: `SO ${so}: no line items with qty > 0` };

    const po = poFromDto(found.dto) || so;
    const dateStr = new Date().toISOString().slice(0, 10);
    const file = ch === 'myntra' ? await writeMyntra(rows, po, dateStr)
      : ch === 'zepto' ? writeZepto(rows, po)
      : await writeFlipkart(rows, po, dateStr);

    return {
      ok: true, so, channel: ch, facility: found.facility, po,
      lineCount: rows.length, invoice: rows[0]?.invoice_code || '',
      file: { filename: file.filename, contentType: file.contentType, base64: file.buffer.toString('base64') },
    };
  }

  return { compile, fetchSoDto };
}
