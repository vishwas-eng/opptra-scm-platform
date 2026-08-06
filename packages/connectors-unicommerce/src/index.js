// @opptra/connectors-unicommerce, RE-native Unicommerce capability layer.
// Transport stays in @opptra/uc-client (session paste + keepalive + bearer).
// This package only names actions and routes invoke() → existing uc calls.
export {
  createUnicommerceConnector,
  buildUnicommerceRegistry,
  listUnicommerceActions,
  CONNECTOR_ID,
  CONNECTOR_NAME,
} from './connector.js';
