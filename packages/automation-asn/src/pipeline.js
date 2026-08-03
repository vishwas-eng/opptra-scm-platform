// ASN compile - ported from b2b AsnFill.gs (SO-only path, the reliable one).
//   1. hop facilities → POST /data/oms/saleorder/fetch { code }  (RSG first - many Myntra B2B SOs live there)
//   2. detect the marketplace from the SO's own UC channel (asnChannelFamily_) - the
//      operator never picks it, so a Zepto SO can't be compiled into a Flipkart file
//   3. map saleOrderItems → rows (this SO only)
//   4. write the channel file (Flipkart/Myntra XLSX · Zepto CSV)
import { asnUnsupportedChannelMessage } from '@opptra/core/validate';
import { rowsFromSaleOrderDto, poFromDto } from './rows.js';
import { writeFlipkart, writeMyntra, writeZepto } from './writers.js';

const DEFAULT_FACILITIES = ['Opp_RSG_MH', 'Opp_WIQ_MH_1', 'Opp_BSB_HR_1P', 'Opp_WIQ_KA', 'Opp_WIQ_HR'];

// Port of asnChannelFamily_: UC channel code (e.g. "MYNTRA_B2B") → output file family.
export function channelFamily(ch) {
  const u = String(ch || '').toUpperCase();
  if (u.includes('MYNTRA')) return 'myntra';
  if (u.includes('ZEPTO')) return 'zepto';
  if (u.includes('FLIPKART')) return 'flipkart';
  return '';
}

export function makeAsnPipeline(uc, cfg = {}) {
  // RSG first, then the configured/default facilities (deduped).
  const configured = String(cfg.UC_ASN_FACILITIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const facilities = [...new Set(['Opp_RSG_MH', ...configured, ...DEFAULT_FACILITIES])];

  async function fetchSoDto(so) {
    for (const facility of facilities) {
      // A dead session must fail loudly, not read as "SO not found in any facility".
      const res = await uc.data('/data/oms/saleorder/fetch', { code: so }, { facility })
        .catch((e) => { if (e?.name === 'SessionError') throw e; return null; });
      const dto = res && res.successful !== false ? res.saleOrderDTO : null;
      if (dto && (dto.code || (dto.saleOrderItems || []).length)) return { dto, facility };
    }
    return null;
  }

  async function compile(so, channelOverride) {
    const found = await fetchSoDto(so);
    if (!found) return { ok: false, error: `SO ${so} not found (or not invoiced) in any facility` };

    const ucChannel = found.dto.channel || found.dto.channelCode || '';
    const ch = String(channelOverride || '').toLowerCase().trim() || channelFamily(ucChannel);
    if (!['flipkart', 'myntra', 'zepto'].includes(ch)) {
      return { ok: false, error: asnUnsupportedChannelMessage(ucChannel) };
    }

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
