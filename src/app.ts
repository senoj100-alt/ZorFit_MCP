import { Hono } from "hono";
import type { Props } from "./utils.js";
import githubHandler from "./github-handler.js";
import { createMcpRoutes } from "./routes/mcp.js";
import utilityRoutes from "./routes/utility.js";
import { mcpHandlers } from "./mcp-handlers.js";

// Environment interface for OAuth multi-user support
interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	OAUTH_KV: KVNamespace;
	ZORFIT_DB: D1Database;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GOOGLE_LOGIN_CLIENT_ID?: string;
	GOOGLE_LOGIN_CLIENT_SECRET?: string;
	COOKIE_ENCRYPTION_KEY: string;
	FITBIT_CLIENT_ID?: string;
	FITBIT_CLIENT_SECRET?: string;
	GOOGLE_FIT_CLIENT_ID?: string;
	GOOGLE_FIT_CLIENT_SECRET?: string;
	HEVY_API_KEY?: string;
	STRAVA_ACCESS_TOKEN?: string;
	STRAVA_REFRESH_TOKEN?: string;
	STRAVA_CLIENT_ID?: string;
	STRAVA_CLIENT_SECRET?: string;
	CRONOMETER_USERNAME?: string;
	CRONOMETER_PASSWORD?: string;
	INTERVALS_ICU_API_KEY?: string;
	INTERVALS_ICU_ATHLETE_ID?: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_BOT_USERNAME?: string;
	TELEGRAM_WEBHOOK_SECRET?: string;
}

// Variables interface for Hono context
interface Variables {
	props?: Props;
	session?: Props;
}

// Create main Hono app with proper TypeScript types
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global CORS middleware
app.use("*", async (c, next) => {
	// Handle OPTIONS preflight requests
	if (c.req.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
				"Access-Control-Max-Age": "86400",
			},
		});
	}

	await next();

	// Add CORS headers to all responses
	c.res.headers.set("Access-Control-Allow-Origin", "*");
	c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
	return c.res;
});

// Error handling middleware
app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json(
		{
			error: "internal_server_error",
			message: "An unexpected error occurred",
		},
		500
	);
});

// Mount routes (order matters!)
app.route("/", githubHandler);        // OAuth/API routes
app.route("/", createMcpRoutes(mcpHandlers));  // MCP endpoints
app.route("/", utilityRoutes);        // Public pages and health checks

// 404 handler
app.notFound((c) => {
	return c.text("Not found", 404);
});

export default app;
export type { Env, Variables };
