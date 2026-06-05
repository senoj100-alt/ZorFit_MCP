import { ZorFitMCP } from "./mcp-agent.js";

// Create MCP handlers
export const mcpHandlers = {
	streamableHTTP: ZorFitMCP.serve("/mcp", { binding: "MCP_OBJECT" }),
	sse: ZorFitMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }),
};
