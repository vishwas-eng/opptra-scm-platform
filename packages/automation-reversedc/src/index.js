// Reverse DC = Delivery Challan from a Unicommerce credit note.
// Bulk Return ID + facility (or an upload) → parse the CN → rebuild a Delivery Challan
// when the numbers reconcile, else edit the original PDF in place so no data is lost.
export { editCreditNoteToDeliveryChallan } from './edit.js';
export { makeReverseDcPipeline, reconcileParsed, istTodayDate } from './pipeline.js';
export { parseCreditNote } from './parseCn.js';
export { buildDeliveryChallanHtml, renderDeliveryChallanPdf } from './renderDc.js';
