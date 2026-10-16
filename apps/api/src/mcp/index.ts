// Point d'entrée public du client MCP.
export {
  createMcpPool,
  type McpLogger,
  type McpPool,
  type McpPoolOptions,
  type McpTransportConfig,
  McpUnavailableError,
} from "./pool.js";
export {
  type FormatMcpResult,
  loadMcpTools,
  loadMcpToolsOrFallback,
  type LoadMcpToolsOptions,
  MCP_TOOL_PREFIX,
  type McpToolset,
  UNAVAILABLE_MESSAGE,
} from "./tools.js";
