// @opptra/capture, turn a recorded seller-portal session into a connector blueprint.
export { analyzeCapture, detectAuth, templatizePath, shapeOf } from './analyze.js';
export {
  redactEntry, redactHeaders, redactBody, redactUrl, redactString, extractSessionMaterial,
} from './redact.js';
export { harToEntries } from './har.js';
