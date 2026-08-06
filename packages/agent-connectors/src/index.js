// @opptra/agent-connectors, the ONE source of truth for Agent connector metadata,
// tool specs, tool execution and status assembly. Both hosts import from here:
//   apps/api    (chat, connectors panel), invokeUc = enqueue + poll Run
//   apps/worker (playbook replay), invokeUc = direct connector call
// Keeping this in a package (not inside apps/api) means the worker no longer reaches
// across app boundaries into API source files.
export {
  LIVE_CONNECTOR_IDS, isLiveConnector,
  RESOURCE_CONNECTOR_IDS, isResourceConnector,
  CONNECTOR_META, COMING_SOON_IDS,
} from './meta.js';
export {
  TOOLS_BY_CONNECTOR, MUTATING_TOOLS,
  buildToolSpecs, makeToolExecutor,
  canonicalToolName, connectorForTool, isKnownTool,
} from './tools.js';
export { buildConnectorStatus, connectedLiveIds } from './status.js';
export {
  agentGoogleFor, mapGoogleToolError, escapeDriveQuery, GOOGLE_RECONNECT_URL,
} from './google.js';
