/**
 * GitHub OAuth Handler
 * Handles OAuth authorization flow for multi-user authentication
 */

import { Hono } from "hono";
import {
	getUpstreamAuthorizeUrl,
	fetchUpstreamAuthToken,
	fetchGitHubUser,
	getGoogleAuthorizeUrl,
	fetchGoogleAuthToken,
	fetchGoogleUser,
	type Props,
} from "./utils.js";
import {
	renderApprovalDialog,
	parseRedirectApproval,
	clientIdAlreadyApproved,
	storeClientApproval,
} from "./workers-oauth-utils.js";
import {
	getUserApiKey,
	setUserApiKey,
	deleteUserApiKey,
	maskApiKey,
} from "./lib/key-storage.js";
import { HevyClient } from "./lib/client.js";
import {
	deleteServiceConnection,
	listServiceConnections,
	upsertServiceConnection,
	type ZorFitServiceId,
	type ServiceAuthType,
} from "./lib/service-connections.js";
import { getZorFitServiceStatuses } from "./lib/service-registry.js";

interface Env {
	OAUTH_KV: KVNamespace;
	ZORFIT_DB: D1Database;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GOOGLE_LOGIN_CLIENT_ID?: string;
	GOOGLE_LOGIN_CLIENT_SECRET?: string;
	COOKIE_ENCRYPTION_KEY: string;
	FITBIT_CLIENT_ID?: string;
	FITBIT_CLIENT_SECRET?: string;
	FITBIT_ACCESS_TOKEN?: string;
	FITBIT_REFRESH_TOKEN?: string;
	GOOGLE_FIT_CLIENT_ID?: string;
	GOOGLE_FIT_CLIENT_SECRET?: string;
	GOOGLE_FIT_ACCESS_TOKEN?: string;
	GOOGLE_FIT_REFRESH_TOKEN?: string;
	HEVY_API_KEY?: string;
	STRAVA_ACCESS_TOKEN?: string;
	STRAVA_REFRESH_TOKEN?: string;
	STRAVA_CLIENT_ID?: string;
	STRAVA_CLIENT_SECRET?: string;
	CRONOMETER_USERNAME?: string;
	CRONOMETER_PASSWORD?: string;
	INTERVALS_ICU_API_KEY?: string;
	INTERVALS_ICU_ATHLETE_ID?: string;
}

// Create Hono app for OAuth routes
const app = new Hono<{ Bindings: Env }>();

/**
 * Generate a random state parameter for OAuth
 */
function generateState(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Helper function to get the base URL for OAuth endpoints
 * Handles local development where Wrangler rewrites the Host header
 */
function getBaseUrl(c: any): string {
	const url = new URL(c.req.url);

	// Check for X-Forwarded-Host header (reverse proxy)
	const forwardedHost = c.req.header("X-Forwarded-Host");
	if (forwardedHost) {
		return `${url.protocol}//${forwardedHost}`;
	}

	// Check if request came from localhost (local dev)
	// Wrangler dev adds CF-Connecting-IP with localhost address
	const cfConnectingIp = c.req.header("CF-Connecting-IP");

	// Check if connecting from localhost (::1 is IPv6 localhost, 127.0.0.1 is IPv4)
	const isLocalhost = cfConnectingIp === "::1" || cfConnectingIp === "127.0.0.1" || cfConnectingIp?.startsWith("127.");

	if (isLocalhost) {
		return `${url.protocol}//localhost:8787`;
	}

	// Production: use the Host header as-is
	return `${url.protocol}//${url.host}`;
}

function getSessionCookie(sessionToken: string): string {
	return `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
}

function renderAuthSetupPage(provider: string, missing: string[]): string {
	const missingItems = missing.map((name) => `<li><code>${name}</code></li>`).join("");
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${provider} login setup required - ZorFit_MCP</title>
	<style>
		:root {
			color-scheme: dark;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			--bg: #080b10;
			--panel: #10151f;
			--line: #273142;
			--text: #f5f7fb;
			--muted: #aab4c5;
			--green: #8ee6b1;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
			background: linear-gradient(180deg, #0c1119 0%, var(--bg) 100%);
			color: var(--text);
		}
		main {
			width: min(560px, 100%);
			padding: 28px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			border-radius: 8px;
			background: var(--panel);
		}
		h1 { margin: 0 0 12px; font-size: clamp(2rem, 7vw, 3rem); line-height: 1; }
		p, li { color: var(--muted); line-height: 1.6; }
		code {
			padding: 3px 7px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 6px;
			background: rgba(255, 255, 255, 0.08);
			color: var(--green);
		}
		a {
			color: var(--green);
			font-weight: 750;
			text-decoration: none;
		}
	</style>
</head>
<body>
	<main>
		<h1>${provider} login needs setup.</h1>
		<p>This login option is built into ZorFit_MCP, but the production OAuth secrets have not been configured yet.</p>
		<p>Missing Cloudflare secrets:</p>
		<ul>${missingItems}</ul>
		<p><a href="/">Return home</a></p>
	</main>
</body>
</html>`;
}

/**
 * GET /.well-known/oauth-protected-resource
 * OAuth 2.0 Resource Server Metadata (RFC 8707)
 * Tells clients how to access the protected resource
 */
app.get("/.well-known/oauth-protected-resource", (c) => {
	const baseUrl = getBaseUrl(c);

	const response = c.json({
		resource: baseUrl,
		authorization_servers: [`${baseUrl}`],
		bearer_methods_supported: ["header"],
		resource_documentation: `${baseUrl}/`,
	});

	response.headers.set("Access-Control-Allow-Origin", "*");
	return response;
});

/**
 * GET /.well-known/oauth-authorization-server
 * OAuth 2.1 Authorization Server Metadata (RFC 8414)
 * Allows clients to discover OAuth configuration automatically
 */
app.get("/.well-known/oauth-authorization-server", (c) => {
	const baseUrl = getBaseUrl(c);

	const response = c.json({
		issuer: baseUrl,
		authorization_endpoint: `${baseUrl}/authorize`,
		token_endpoint: `${baseUrl}/token`,
		registration_endpoint: `${baseUrl}/register`,
		scopes_supported: ["mcp"],
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code"],
		token_endpoint_auth_methods_supported: ["none"], // Public client
		code_challenge_methods_supported: ["S256"], // PKCE support
		revocation_endpoint_auth_methods_supported: ["none"],
		service_documentation: `${baseUrl}/`,
	});

	response.headers.set("Access-Control-Allow-Origin", "*");
	return response;
});

/**
 * GET /auth/google
 * Starts Google sign-in for website users.
 */
app.get("/auth/google", async (c) => {
	const googleClientId = c.env.GOOGLE_LOGIN_CLIENT_ID;
	const googleClientSecret = c.env.GOOGLE_LOGIN_CLIENT_SECRET;
	const missing = [];
	if (!googleClientId) missing.push("GOOGLE_LOGIN_CLIENT_ID");
	if (!googleClientSecret) missing.push("GOOGLE_LOGIN_CLIENT_SECRET");

	if (!googleClientId || !googleClientSecret) {
		return c.html(renderAuthSetupPage("Google", missing), 501);
	}

	const state = generateState();
	const returnTo = c.req.query("return_to") || "/connections";
	const baseUrl = getBaseUrl(c);
	const callbackUri = `${baseUrl}/auth/google/callback`;

	await c.env.OAUTH_KV.put(
		`google_login_state:${state}`,
		JSON.stringify({
			returnTo,
		}),
		{ expirationTtl: 600 }
	);

	return c.redirect(getGoogleAuthorizeUrl(googleClientId, callbackUri, state));
});

/**
 * GET /auth/google/callback
 * Completes Google sign-in for website users.
 */
app.get("/auth/google/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");

	if (!code || !state) {
		return c.text("Missing code or state parameter", 400);
	}

	const googleClientId = c.env.GOOGLE_LOGIN_CLIENT_ID;
	const googleClientSecret = c.env.GOOGLE_LOGIN_CLIENT_SECRET;
	if (!googleClientId || !googleClientSecret) {
		return c.html(
			renderAuthSetupPage("Google", [
				"GOOGLE_LOGIN_CLIENT_ID",
				"GOOGLE_LOGIN_CLIENT_SECRET",
			]),
			501
		);
	}

	const stateData = await c.env.OAUTH_KV.get(`google_login_state:${state}`, "json");
	if (!stateData || typeof stateData !== "object") {
		return c.text("Invalid or expired state parameter", 400);
	}

	const { returnTo } = stateData as { returnTo?: string };
	const baseUrl = getBaseUrl(c);
	const callbackUri = `${baseUrl}/auth/google/callback`;

	try {
		const accessToken = await fetchGoogleAuthToken(
			code,
			googleClientId,
			googleClientSecret,
			callbackUri
		);
		const user = await fetchGoogleUser(accessToken);
		const sessionToken = generateState();
		const sessionData: Props = {
			login: user.login,
			name: user.name,
			email: user.email,
			accessToken,
			baseUrl,
		};

		await c.env.OAUTH_KV.put(`session:${sessionToken}`, JSON.stringify(sessionData), {
			expirationTtl: 30 * 24 * 60 * 60,
		});
		await c.env.OAUTH_KV.delete(`google_login_state:${state}`);

		const response = c.redirect(returnTo || "/connections");
		response.headers.set("Set-Cookie", getSessionCookie(sessionToken));
		return response;
	} catch (error) {
		console.error("Google OAuth callback error:", error);
		return c.text(
			`Google OAuth error: ${error instanceof Error ? error.message : "Unknown error"}`,
			500
		);
	}
});

/**
 * GET /authorize
 * OAuth authorization endpoint - initiates GitHub OAuth flow
 */
app.get("/authorize", async (c) => {
	const clientId = c.req.query("client_id");
	const redirectUri = c.req.query("redirect_uri");
	const state = c.req.query("state");
	const scope = c.req.query("scope") || "mcp";

	if (!clientId || !redirectUri || !state) {
		return c.text("Missing required parameters: client_id, redirect_uri, or state", 400);
	}

	// Check if user is already authenticated (has session cookie)
	const sessionCookie = c.req.header("Cookie");
	const sessionToken = sessionCookie?.match(/session=([^;]+)/)?.[1];

	if (sessionToken) {
		// User is already authenticated, check if client is already approved
		const sessionData = await c.env.OAUTH_KV.get(`session:${sessionToken}`, "json");

		if (sessionData && typeof sessionData === "object" && "login" in sessionData) {
			const username = (sessionData as { login: string }).login;
			const alreadyApproved = await clientIdAlreadyApproved(c.env.OAUTH_KV, username, clientId);

			if (alreadyApproved) {
				// Auto-approve and redirect
				const authCode = generateState();
				await c.env.OAUTH_KV.put(
					`authcode:${authCode}`,
					JSON.stringify({
						clientId,
						redirectUri,
						sessionToken,
					}),
					{ expirationTtl: 600 } // 10 minutes
				);

				const redirectUrl = new URL(redirectUri);
				redirectUrl.searchParams.set("code", authCode);
				redirectUrl.searchParams.set("state", state);

				return c.redirect(redirectUrl.toString());
			}

			// Show approval dialog
			const html = renderApprovalDialog({
				clientId,
				redirectUri,
				state,
				scope,
				userLogin: username,
				userName: (sessionData as { name?: string }).name || username,
				authorizeEndpoint: "/authorize",
			});

			return c.html(html);
		}
	}

	// User not authenticated, redirect to GitHub OAuth
	if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
		return c.html(renderAuthSetupPage("GitHub", ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]));
	}

	const githubState = generateState();

	// Store OAuth state and client info
	await c.env.OAUTH_KV.put(
		`oauth_state:${githubState}`,
		JSON.stringify({
			clientId,
			redirectUri,
			state,
			scope,
		}),
		{ expirationTtl: 600 } // 10 minutes
	);

	const url = new URL(c.req.url);
	const callbackUri = `${url.protocol}//${url.host}/callback`;

	const githubAuthUrl = getUpstreamAuthorizeUrl(
		c.env.GITHUB_CLIENT_ID,
		callbackUri,
		githubState,
		"user:email"
	);

	return c.redirect(githubAuthUrl);
});

/**
 * POST /authorize
 * Handles approval form submission
 */
app.post("/authorize", async (c) => {
	const approval = await parseRedirectApproval(c.req.raw);

	if (!approval.approved) {
		return c.text("Authorization denied", 403);
	}

	// Get session from cookie
	const sessionCookie = c.req.header("Cookie");
	const sessionToken = sessionCookie?.match(/session=([^;]+)/)?.[1];

	if (!sessionToken) {
		return c.text("No session found", 401);
	}

	const sessionData = await c.env.OAUTH_KV.get(`session:${sessionToken}`, "json");
	if (!sessionData || typeof sessionData !== "object" || !("login" in sessionData)) {
		return c.text("Invalid session", 401);
	}

	const username = (sessionData as { login: string }).login;

	// Store approval
	await storeClientApproval(c.env.OAUTH_KV, username, approval.clientId);

	// Generate authorization code
	const authCode = generateState();
	await c.env.OAUTH_KV.put(
		`authcode:${authCode}`,
		JSON.stringify({
			clientId: approval.clientId,
			redirectUri: approval.redirectUri,
			sessionToken,
		}),
		{ expirationTtl: 600 } // 10 minutes
	);

	// Redirect back to client with auth code
	const redirectUrl = new URL(approval.redirectUri);
	redirectUrl.searchParams.set("code", authCode);
	redirectUrl.searchParams.set("state", approval.state);

	return c.redirect(redirectUrl.toString());
});

/**
 * GET /callback
 * GitHub OAuth callback - exchanges code for access token
 */
app.get("/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");

	if (!code || !state) {
		return c.text("Missing code or state parameter", 400);
	}

	// Retrieve OAuth state
	const stateData = await c.env.OAUTH_KV.get(`oauth_state:${state}`, "json");
	if (!stateData || typeof stateData !== "object") {
		return c.text("Invalid or expired state parameter", 400);
	}

	const { clientId, redirectUri, state: clientState, scope } = stateData as {
		clientId: string;
		redirectUri: string;
		state: string;
		scope: string;
	};

	try {
		// Exchange code for GitHub access token
		const url = new URL(c.req.url);
		const callbackUri = `${url.protocol}//${url.host}/callback`;

		const accessToken = await fetchUpstreamAuthToken(
			code,
			c.env.GITHUB_CLIENT_ID,
			c.env.GITHUB_CLIENT_SECRET,
			callbackUri
		);

		// Fetch user information from GitHub
		const user = await fetchGitHubUser(accessToken);

		// Create session
		const sessionToken = generateState();
		const baseUrl = `${url.protocol}//${url.host}`;
		const sessionData: Props = {
			login: user.login,
			name: user.name,
			email: user.email,
			accessToken,
			baseUrl,
		};

		// Store session in KV (expires in 30 days)
		await c.env.OAUTH_KV.put(`session:${sessionToken}`, JSON.stringify(sessionData), {
			expirationTtl: 30 * 24 * 60 * 60,
		});

		// Clean up state
		await c.env.OAUTH_KV.delete(`oauth_state:${state}`);

		// Check if client is already approved
		const alreadyApproved = await clientIdAlreadyApproved(c.env.OAUTH_KV, user.login, clientId);

		if (alreadyApproved) {
			// Auto-approve and redirect
			const authCode = generateState();
			await c.env.OAUTH_KV.put(
				`authcode:${authCode}`,
				JSON.stringify({
					clientId,
					redirectUri,
					sessionToken,
				}),
				{ expirationTtl: 600 }
			);

			const redirectUrl = new URL(redirectUri);
			redirectUrl.searchParams.set("code", authCode);
			redirectUrl.searchParams.set("state", clientState);

			// Set session cookie
			const response = c.redirect(redirectUrl.toString());
			response.headers.set(
				"Set-Cookie",
				`session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
			);
			return response;
		}

		// Show approval dialog
		const html = renderApprovalDialog({
			clientId,
			redirectUri,
			state: clientState,
			scope,
			userLogin: user.login,
			userName: user.name,
			authorizeEndpoint: "/authorize",
		});

		const response = c.html(html);
		response.headers.set(
			"Set-Cookie",
			`session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
		);
		return response;
	} catch (error) {
		console.error("OAuth callback error:", error);
		return c.text(`OAuth error: ${error instanceof Error ? error.message : "Unknown error"}`, 500);
	}
});

/**
 * POST /token
 * OAuth 2.1 token endpoint - exchanges authorization code for access token
 * This is what MCP clients call to complete the OAuth flow
 */
app.post("/token", async (c) => {
	try {
		const formData = await c.req.formData();
		const grantType = formData.get("grant_type");
		const code = formData.get("code");
		const redirectUri = formData.get("redirect_uri");
		const clientId = formData.get("client_id");

		if (grantType !== "authorization_code") {
			return c.json(
				{
					error: "unsupported_grant_type",
					error_description: "Only authorization_code grant type is supported",
				},
				400
			);
		}

		if (!code || !redirectUri || !clientId) {
			return c.json(
				{
					error: "invalid_request",
					error_description: "Missing required parameters: code, redirect_uri, or client_id",
				},
				400
			);
		}

		// Retrieve authorization code from KV
		const authData = await c.env.OAUTH_KV.get(`authcode:${code}`, "json");
		if (!authData || typeof authData !== "object") {
			return c.json(
				{
					error: "invalid_grant",
					error_description: "Invalid or expired authorization code",
				},
				400
			);
		}

		const { clientId: storedClientId, redirectUri: storedRedirectUri, sessionToken } = authData as {
			clientId: string;
			redirectUri: string;
			sessionToken: string;
		};

		// Validate client_id and redirect_uri match
		if (clientId !== storedClientId || redirectUri !== storedRedirectUri) {
			return c.json(
				{
					error: "invalid_grant",
					error_description: "Client ID or redirect URI mismatch",
				},
				400
			);
		}

		// Retrieve session data
		const sessionData = await c.env.OAUTH_KV.get(`session:${sessionToken}`, "json");
		if (!sessionData || typeof sessionData !== "object") {
			return c.json(
				{
					error: "invalid_grant",
					error_description: "Invalid or expired session",
				},
				400
			);
		}

		// Delete the authorization code (single-use)
		await c.env.OAUTH_KV.delete(`authcode:${code}`);

		// Generate access token (we'll use the session token as the access token)
		const accessToken = sessionToken;

		// Return OAuth 2.1 token response
		return c.json({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 30 * 24 * 60 * 60, // 30 days
			scope: "mcp",
		});
	} catch (error) {
		console.error("Token endpoint error:", error);
		return c.json(
			{
				error: "server_error",
				error_description: "An error occurred while processing the token request",
			},
			500
		);
	}
});

/**
 * POST /register
 * OAuth 2.1 dynamic client registration endpoint
 * For now, we accept all clients dynamically
 */
app.post("/register", async (c) => {
	try {
		const body = await c.req.json();
		const redirectUris = body.redirect_uris;

		if (!redirectUris || !Array.isArray(redirectUris) || redirectUris.length === 0) {
			return c.json(
				{
					error: "invalid_redirect_uri",
					error_description: "At least one redirect_uri is required",
				},
				400
			);
		}

		// Generate a client ID
		const clientId = generateState();

		// Store client registration in KV (optional, for future validation)
		await c.env.OAUTH_KV.put(
			`client:${clientId}`,
			JSON.stringify({
				client_id: clientId,
				redirect_uris: redirectUris,
				created_at: new Date().toISOString(),
			}),
			{ expirationTtl: 365 * 24 * 60 * 60 } // 1 year
		);

		// Return OAuth 2.1 registration response
		return c.json({
			client_id: clientId,
			redirect_uris: redirectUris,
			grant_types: ["authorization_code"],
			token_endpoint_auth_method: "none", // Public client
		});
	} catch (error) {
		console.error("Client registration error:", error);
		return c.json(
			{
				error: "server_error",
				error_description: "An error occurred during client registration",
			},
			500
		);
	}
});

/**
 * GET /logout
 * Clears user session
 */
app.get("/logout", async (c) => {
	const sessionCookie = c.req.header("Cookie");
	const sessionToken = sessionCookie?.match(/session=([^;]+)/)?.[1];

	if (sessionToken) {
		await c.env.OAUTH_KV.delete(`session:${sessionToken}`);
	}

	const response = c.text("Logged out successfully");
	response.headers.set("Set-Cookie", "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
	return response;
});

/**
 * Helper: Get authenticated session data
 */
async function getAuthenticatedSession(c: any): Promise<Props | null> {
	const sessionCookie = c.req.header("Cookie");
	const sessionToken = sessionCookie?.match(/session=([^;]+)/)?.[1];

	if (!sessionToken) {
		return null;
	}

	const sessionData = await c.env.OAUTH_KV.get(`session:${sessionToken}`, "json");
	if (!sessionData || typeof sessionData !== "object" || !("login" in sessionData)) {
		return null;
	}

	return sessionData as Props;
}

const SERVICE_CONFIG: Record<
	ZorFitServiceId,
	{
		label: string;
		authType: ServiceAuthType;
		fields: string[];
		helpUrl: string;
		helpLabel: string;
		helpText: string;
	}
> = {
	hevy: {
		label: "Hevy",
		authType: "api_key",
		fields: ["apiKey"],
		helpUrl: "https://hevy.com/settings?developer",
		helpLabel: "Get Hevy API key",
		helpText: "Hevy API keys are available from the web app developer settings for Hevy Pro users.",
	},
	strava: {
		label: "Strava",
		authType: "oauth",
		fields: ["accessToken", "refreshToken"],
		helpUrl: "https://www.strava.com/settings/api",
		helpLabel: "Open Strava API settings",
		helpText: "Create a Strava app here, then use OAuth or paste your own access and refresh tokens.",
	},
	cronometer: {
		label: "Cronometer",
		authType: "username_password",
		fields: ["username", "password"],
		helpUrl: "https://cronometer.com/login/",
		helpLabel: "Open Cronometer",
		helpText: "Use the Cronometer username/email and password for your own account. Cronometer does not provide a standard public API key flow.",
	},
	intervals_icu: {
		label: "Intervals.icu",
		authType: "api_key",
		fields: ["apiKey", "athleteId"],
		helpUrl: "https://intervals.icu/settings",
		helpLabel: "Get Intervals.icu API key",
		helpText: "Open Settings, then Developer Settings, and create an API key. Your athlete ID is shown in Intervals.icu.",
	},
	fitbit: {
		label: "Fitbit",
		authType: "oauth",
		fields: ["accessToken", "refreshToken"],
		helpUrl: "https://dev.fitbit.com/apps",
		helpLabel: "Open Fitbit developer apps",
		helpText: "Use OAuth connect when the app credentials are configured, or paste OAuth tokens from your own Fitbit app.",
	},
	google_fit: {
		label: "Google Fit",
		authType: "oauth",
		fields: ["accessToken", "refreshToken"],
		helpUrl: "https://console.cloud.google.com/apis/credentials",
		helpLabel: "Open Google OAuth credentials",
		helpText: "Create a Google OAuth client with Fitness API scopes, then use OAuth connect or paste tokens.",
	},
};

function connectionLoginRedirect(c: any, path: string) {
	if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
		const url = new URL(c.req.url);
		url.pathname = "/signup";
		url.search = "";
		return c.redirect(url.toString());
	}

	const url = new URL(c.req.url);
	const authorizeUrl = new URL("/authorize", url.origin);
	authorizeUrl.searchParams.set("client_id", "connections");
	authorizeUrl.searchParams.set("redirect_uri", `${url.origin}${path}`);
	authorizeUrl.searchParams.set("state", "connections");
	return c.redirect(authorizeUrl.toString());
}

/**
 * GET /connections
 * Product-ready user service connection area.
 */
app.get("/connections", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return connectionLoginRedirect(c, "/connections");

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>ZorFit_MCP Connections</title>
	<style>
		:root {
			color-scheme: dark;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			--bg: #080b10;
			--panel: #10151f;
			--panel-2: #151b27;
			--line: #273142;
			--text: #f5f7fb;
			--muted: #aab4c5;
			--soft: #d7deea;
			--green: #8ee6b1;
			--blue: #9db9ff;
			--amber: #ffd38a;
			--red: #ffb4b4;
			--ink: #091019;
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			color: var(--text);
			background:
				radial-gradient(circle at 78% 0%, rgba(157, 185, 255, 0.18), transparent 31rem),
				linear-gradient(180deg, #0c1119 0%, var(--bg) 46%, #07090d 100%);
		}

		a {
			color: inherit;
			text-decoration: none;
		}

		.shell {
			width: min(1180px, calc(100% - 32px));
			margin: 0 auto;
		}

		.notice {
			border-bottom: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(8, 11, 16, 0.72);
			backdrop-filter: blur(18px);
		}

		.notice .shell {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 10px;
			min-height: 40px;
			color: var(--soft);
			font-size: 0.88rem;
		}

		.pill {
			display: inline-flex;
			align-items: center;
			min-height: 24px;
			padding: 0 10px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			border-radius: 999px;
			color: var(--green);
			background: rgba(142, 230, 177, 0.08);
			font-size: 0.76rem;
			font-weight: 780;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			white-space: nowrap;
		}

		nav {
			position: sticky;
			top: 0;
			z-index: 10;
			border-bottom: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(8, 11, 16, 0.78);
			backdrop-filter: blur(18px);
		}

		nav .shell {
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: 72px;
			gap: 18px;
		}

		.brand {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			font-weight: 850;
			letter-spacing: 0;
		}

		.mark {
			display: grid;
			place-items: center;
			width: 32px;
			height: 32px;
			border: 1px solid rgba(255, 255, 255, 0.18);
			border-radius: 8px;
			background: linear-gradient(135deg, var(--green), var(--blue));
			color: var(--ink);
			font-weight: 900;
		}

		.nav-actions {
			display: flex;
			align-items: center;
			gap: 10px;
		}

		.button, button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 40px;
			padding: 0 14px;
			border: 1px solid rgba(255, 255, 255, 0.14);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.06);
			color: var(--text);
			font: inherit;
			font-weight: 760;
			cursor: pointer;
			white-space: nowrap;
		}

		.button.primary, button.primary {
			border-color: transparent;
			background: var(--text);
			color: var(--ink);
		}

		button.danger {
			color: var(--red);
		}

		button:disabled {
			cursor: not-allowed;
			opacity: 0.45;
		}

		main {
			padding: 54px 0 84px;
		}

		header {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 24px;
			align-items: end;
			padding-bottom: 30px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		}

		.eyebrow {
			color: var(--green);
			font-size: 0.76rem;
			font-weight: 820;
			letter-spacing: 0.12em;
			text-transform: uppercase;
		}

		h1 {
			max-width: 760px;
			margin: 12px 0 12px;
			font-size: clamp(2.7rem, 7vw, 5.6rem);
			line-height: 0.92;
			letter-spacing: 0;
		}

		h2, h3 {
			margin: 0;
			letter-spacing: 0;
		}

		p {
			color: var(--muted);
			line-height: 1.65;
		}

		.lede {
			max-width: 720px;
			margin: 0;
			font-size: 1.08rem;
		}

		.summary {
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 14px;
			margin-top: 24px;
		}

		.summary-card {
			padding: 16px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.04);
		}

		.summary-card strong {
			display: block;
			font-size: 1.45rem;
			margin-bottom: 4px;
		}

		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
			gap: 16px;
			margin-top: 28px;
		}

		.card {
			display: flex;
			flex-direction: column;
			min-height: 430px;
			padding: 20px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 8px;
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.03));
		}

		.card-top {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 14px;
			margin-bottom: 14px;
		}

		.status {
			display: inline-flex;
			align-items: center;
			min-height: 24px;
			padding: 0 9px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			border-radius: 999px;
			color: var(--muted);
			background: rgba(255, 255, 255, 0.04);
			font-size: 0.68rem;
			font-weight: 820;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			white-space: nowrap;
		}

		.status.configured {
			color: var(--green);
			background: rgba(142, 230, 177, 0.08);
		}

		.status.server {
			color: var(--blue);
			background: rgba(157, 185, 255, 0.1);
		}

		.note {
			margin: 8px 0 14px;
			font-size: 0.88rem;
		}

		.help {
			padding: 12px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 8px;
			background: rgba(8, 11, 16, 0.5);
		}

		.help p {
			margin: 0 0 8px;
			font-size: 0.82rem;
		}

		.help a {
			color: var(--green);
			font-size: 0.84rem;
			font-weight: 780;
		}

		label {
			display: block;
			margin-top: 13px;
			color: var(--soft);
			font-size: 0.8rem;
			font-weight: 720;
		}

		input {
			width: 100%;
			margin-top: 6px;
			padding: 11px 12px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			border-radius: 8px;
			background: rgba(8, 11, 16, 0.72);
			color: var(--text);
			font: inherit;
		}

		input::placeholder {
			color: #6f7d92;
		}

		.actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: auto;
			padding-top: 16px;
		}

		#message {
			min-height: 24px;
			margin-top: 18px;
			color: var(--green);
			font-weight: 760;
		}

		@media (max-width: 840px) {
			header, .summary {
				grid-template-columns: 1fr;
			}

			nav .shell {
				align-items: flex-start;
				flex-direction: column;
				padding: 14px 0;
			}
		}
	</style>
</head>
<body>
	<div class="notice">
		<div class="shell">
			<span class="pill">Connections</span>
			<span>Each user can add their own service credentials. Server-level secrets show as connected too.</span>
		</div>
	</div>
	<nav>
		<div class="shell">
			<a class="brand" href="/">
				<span class="mark">1H</span>
				<span>ZorFit_MCP</span>
			</a>
			<div class="nav-actions">
				<a class="button" href="/">Home</a>
				<a class="button" href="/health">Status</a>
				<a class="button primary" href="/logout">Logout</a>
			</div>
		</div>
	</nav>
	<main class="shell">
		<header>
			<div>
				<span class="eyebrow">Service dashboard</span>
				<h1>ZorFit_MCP Connections</h1>
				<p class="lede">Connect personal health and fitness services for @${session.login}. Per-user tokens are encrypted in D1; server-level credentials appear as connected for every signed-in user.</p>
			</div>
			<div class="summary" aria-label="Connection summary">
				<div class="summary-card"><strong id="connectedCount">0</strong><span>Connected</span></div>
				<div class="summary-card"><strong>6</strong><span>Sources</span></div>
				<div class="summary-card"><strong>/mcp</strong><span>Endpoint</span></div>
			</div>
		</header>
		<div id="message"></div>
		<section class="grid" id="services"></section>
	</main>
	<script>
		const serviceConfig = ${JSON.stringify(SERVICE_CONFIG)};
		const message = document.getElementById("message");
		const services = document.getElementById("services");
		const connectedCount = document.getElementById("connectedCount");

		function fieldLabel(field) {
			return field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
		}

		function sourceLabel(source) {
			if (source === "user_d1") return "Connected via account";
			if (source === "worker_secret") return "Connected via server";
			return "Not connected";
		}

		function sourceClass(status) {
			if (!status?.configured) return "";
			return status.source === "worker_secret" ? "configured server" : "configured";
		}

		function show(text) {
			message.textContent = text;
			setTimeout(() => { message.textContent = ""; }, 4000);
		}

		async function load() {
			const response = await fetch("/api/connections");
			const data = await response.json();
			const statuses = new Map((data.statuses || []).map((status) => [status.id, status]));
			const connected = (data.statuses || []).filter((status) => status.configured).length;
			connectedCount.textContent = String(connected);
			services.innerHTML = Object.entries(serviceConfig).map(([id, config]) => {
				const status = statuses.get(id);
				const isConfigured = Boolean(status?.configured);
				const isServerConfigured = status?.source === "worker_secret";
				const fields = config.fields.map((field) => \`
					<label>\${fieldLabel(field)}
						<input name="\${field}" type="\${field.toLowerCase().includes("secret") || field.toLowerCase().includes("password") || field.toLowerCase().includes("token") ? "password" : "text"}" autocomplete="off" placeholder="\${field}" />
					</label>\`).join("");
				const oauthButton = ["fitbit", "google_fit"].includes(id)
					? \`<a class="button secondary" href="/connect/\${id}">OAuth connect</a>\`
					: "";
				return \`
					<form class="card" data-service="\${id}">
						<div class="card-top">
							<div>
								<h2>\${config.label}</h2>
								<p class="note">Auth: \${config.authType}. \${status?.notes || ""}</p>
							</div>
							<div class="status \${sourceClass(status)}">\${sourceLabel(status?.source)}</div>
						</div>
						<div class="help">
							<p>\${config.helpText}</p>
							<a href="\${config.helpUrl}" target="_blank" rel="noreferrer">\${config.helpLabel}</a>
						</div>
						\${fields}
						<div class="actions">
							<button class="primary" type="submit">Save</button>
							<button type="button" class="danger" data-delete="\${id}" \${isServerConfigured ? "disabled" : ""}>\${isServerConfigured ? "Server secret" : "Delete"}</button>
							\${oauthButton}
						</div>
					</form>\`;
			}).join("");
		}

		services.addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.target;
			const serviceId = form.dataset.service;
			const config = serviceConfig[serviceId];
			const credentials = {};
			for (const field of config.fields) {
				const value = form.elements[field].value.trim();
				if (value) credentials[field] = value;
			}
			const response = await fetch("/api/connections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ serviceId, authType: config.authType, credentials }),
			});
			const data = await response.json().catch(() => ({}));
			show(response.ok ? "Saved connection." : (data.error || "Could not save connection."));
			await load();
		});

		services.addEventListener("click", async (event) => {
			const serviceId = event.target.dataset?.delete;
			if (!serviceId) return;
			if (!confirm("Delete this service connection?")) return;
			const response = await fetch(\`/api/connections/\${serviceId}\`, { method: "DELETE" });
			show(response.ok ? "Deleted connection." : "Could not delete connection.");
			await load();
		});

		load();
	</script>
</body>
</html>`;

	return c.html(html);
});

app.get("/api/connections", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const [connections, statuses] = await Promise.all([
		listServiceConnections(c.env, session),
		getZorFitServiceStatuses(c.env, session),
	]);
	return c.json({ connections, statuses });
});

app.post("/api/connections", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const serviceId = body.serviceId as ZorFitServiceId;
		const config = SERVICE_CONFIG[serviceId];
		if (!config) return c.json({ error: "Unknown service" }, 400);
		if (!body.credentials || typeof body.credentials !== "object") {
			return c.json({ error: "Credentials are required." }, 400);
		}
		const missingFields = config.fields.filter((field) => {
			const value = body.credentials[field];
			return typeof value !== "string" || value.trim().length === 0;
		});
		if (missingFields.length > 0) {
			return c.json(
				{ error: `Missing required fields: ${missingFields.join(", ")}` },
				400,
			);
		}
		await upsertServiceConnection(c.env, session, {
			serviceId,
			authType: body.authType ?? config.authType,
			credentials: body.credentials,
		});
		return c.json({ success: true });
	} catch (error) {
		console.error("Connection save failed:", error);
		return c.json(
			{ error: "Could not save connection. Please try again." },
			500,
		);
	}
});

app.delete("/api/connections/:service", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const serviceId = c.req.param("service") as ZorFitServiceId;
	if (!SERVICE_CONFIG[serviceId]) return c.json({ error: "Unknown service" }, 400);
	await deleteServiceConnection(c.env, session, serviceId);
	return c.json({ success: true });
});

app.get("/connect/fitbit", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return connectionLoginRedirect(c, "/connections");
	if (!c.env.FITBIT_CLIENT_ID) return c.text("FITBIT_CLIENT_ID is not configured.", 500);
	const url = new URL(c.req.url);
	const state = crypto.randomUUID();
	await c.env.OAUTH_KV.put(`provider_state:${state}`, JSON.stringify({ service: "fitbit", login: session.login }), { expirationTtl: 600 });
	const authUrl = new URL("https://www.fitbit.com/oauth2/authorize");
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", c.env.FITBIT_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", `${url.origin}/connect/fitbit/callback`);
	authUrl.searchParams.set("scope", "activity heartrate location nutrition profile settings sleep weight");
	authUrl.searchParams.set("state", state);
	return c.redirect(authUrl.toString());
});

app.get("/connect/fitbit/callback", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return connectionLoginRedirect(c, "/connections");
	const code = c.req.query("code");
	const state = c.req.query("state");
	const url = new URL(c.req.url);
	if (!code || !state) return c.text("Missing Fitbit callback parameters.", 400);
	const stateData = await c.env.OAUTH_KV.get(`provider_state:${state}`, "json");
	if (!stateData) return c.text("Invalid or expired Fitbit state.", 400);
	const response = await fetch("https://api.fitbit.com/oauth2/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`${c.env.FITBIT_CLIENT_ID}:${c.env.FITBIT_CLIENT_SECRET}`)}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: c.env.FITBIT_CLIENT_ID ?? "",
			grant_type: "authorization_code",
			redirect_uri: `${url.origin}/connect/fitbit/callback`,
			code,
		}),
	});
	if (!response.ok) return c.text(`Fitbit token exchange failed: ${(await response.text()).slice(0, 500)}`, 400);
	const token = await response.json() as { access_token: string; refresh_token: string; expires_in?: number; scope?: string };
	await upsertServiceConnection(c.env, session, {
		serviceId: "fitbit",
		authType: "oauth",
		credentials: { accessToken: token.access_token, refreshToken: token.refresh_token },
		scopes: token.scope?.split(" "),
		expiresAt: token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined,
	});
	await c.env.OAUTH_KV.delete(`provider_state:${state}`);
	return c.redirect("/connections");
});

app.get("/connect/google_fit", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return connectionLoginRedirect(c, "/connections");
	if (!c.env.GOOGLE_FIT_CLIENT_ID) return c.text("GOOGLE_FIT_CLIENT_ID is not configured.", 500);
	const url = new URL(c.req.url);
	const state = crypto.randomUUID();
	await c.env.OAUTH_KV.put(`provider_state:${state}`, JSON.stringify({ service: "google_fit", login: session.login }), { expirationTtl: 600 });
	const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", c.env.GOOGLE_FIT_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", `${url.origin}/connect/google_fit/callback`);
	authUrl.searchParams.set("access_type", "offline");
	authUrl.searchParams.set("prompt", "consent");
	authUrl.searchParams.set("scope", [
		"https://www.googleapis.com/auth/fitness.activity.read",
		"https://www.googleapis.com/auth/fitness.body.read",
		"https://www.googleapis.com/auth/fitness.heart_rate.read",
		"https://www.googleapis.com/auth/fitness.sleep.read",
	].join(" "));
	authUrl.searchParams.set("state", state);
	return c.redirect(authUrl.toString());
});

app.get("/connect/google_fit/callback", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) return connectionLoginRedirect(c, "/connections");
	const code = c.req.query("code");
	const state = c.req.query("state");
	const url = new URL(c.req.url);
	if (!code || !state) return c.text("Missing Google Fit callback parameters.", 400);
	const stateData = await c.env.OAUTH_KV.get(`provider_state:${state}`, "json");
	if (!stateData) return c.text("Invalid or expired Google Fit state.", 400);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: c.env.GOOGLE_FIT_CLIENT_ID ?? "",
			client_secret: c.env.GOOGLE_FIT_CLIENT_SECRET ?? "",
			grant_type: "authorization_code",
			redirect_uri: `${url.origin}/connect/google_fit/callback`,
			code,
		}),
	});
	if (!response.ok) return c.text(`Google token exchange failed: ${(await response.text()).slice(0, 500)}`, 400);
	const token = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
	await upsertServiceConnection(c.env, session, {
		serviceId: "google_fit",
		authType: "oauth",
		credentials: { accessToken: token.access_token, refreshToken: token.refresh_token },
		scopes: token.scope?.split(" "),
		expiresAt: token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined,
	});
	await c.env.OAUTH_KV.delete(`provider_state:${state}`);
	return c.redirect("/connections");
});

/**
 * GET /setup
 * API key management page
 */
app.get("/setup", async (c) => {
	const session = await getAuthenticatedSession(c);

	if (!session) {
		// Redirect to login if not authenticated
		const url = new URL(c.req.url);
		const authorizeUrl = new URL("/authorize", url.origin);
		authorizeUrl.searchParams.set("client_id", "setup");
		authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/setup`);
		authorizeUrl.searchParams.set("state", "setup");
		return c.redirect(authorizeUrl.toString());
	}

	// Check if user has an API key configured
	const hasApiKey = await getUserApiKey(
		c.env.OAUTH_KV,
		c.env.COOKIE_ENCRYPTION_KEY,
		session.login
	);

	const html = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Hevy API Key Setup</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
		}

		.container {
			background: white;
			border-radius: 12px;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
			max-width: 600px;
			width: 100%;
			padding: 40px;
		}

		h1 {
			color: #333;
			margin-bottom: 10px;
			font-size: 28px;
		}

		.user-info {
			background: #f8f9fa;
			padding: 15px;
			border-radius: 8px;
			margin-bottom: 30px;
			display: flex;
			align-items: center;
			gap: 12px;
		}

		.user-info img {
			width: 40px;
			height: 40px;
			border-radius: 50%;
		}

		.user-details {
			flex: 1;
		}

		.user-name {
			font-weight: 600;
			color: #333;
		}

		.user-login {
			font-size: 14px;
			color: #666;
		}

		.logout-btn {
			background: #dc3545;
			color: white;
			border: none;
			padding: 6px 12px;
			border-radius: 4px;
			font-size: 14px;
			cursor: pointer;
			text-decoration: none;
		}

		.logout-btn:hover {
			background: #c82333;
		}

		.status {
			padding: 15px;
			border-radius: 8px;
			margin-bottom: 20px;
			display: flex;
			align-items: center;
			gap: 10px;
		}

		.status.configured {
			background: #d4edda;
			color: #155724;
			border: 1px solid #c3e6cb;
		}

		.status.not-configured {
			background: #fff3cd;
			color: #856404;
			border: 1px solid #ffeaa7;
		}

		.status-icon {
			font-size: 24px;
		}

		label {
			display: block;
			font-weight: 600;
			margin-bottom: 8px;
			color: #333;
		}

		.help-text {
			font-size: 14px;
			color: #666;
			margin-bottom: 8px;
		}

		.help-text a {
			color: #667eea;
			text-decoration: none;
		}

		.help-text a:hover {
			text-decoration: underline;
		}

		input[type="text"] {
			width: 100%;
			padding: 12px;
			border: 2px solid #e0e0e0;
			border-radius: 6px;
			font-size: 14px;
			font-family: monospace;
			transition: border-color 0.2s;
		}

		input[type="text"]:focus {
			outline: none;
			border-color: #667eea;
		}

		.button-group {
			display: flex;
			gap: 10px;
			margin-top: 20px;
		}

		button {
			flex: 1;
			padding: 12px 24px;
			border: none;
			border-radius: 6px;
			font-size: 16px;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s;
		}

		.btn-primary {
			background: #667eea;
			color: white;
		}

		.btn-primary:hover:not(:disabled) {
			background: #5568d3;
		}

		.btn-secondary {
			background: #6c757d;
			color: white;
		}

		.btn-secondary:hover:not(:disabled) {
			background: #5a6268;
		}

		.btn-danger {
			background: #dc3545;
			color: white;
		}

		.btn-danger:hover:not(:disabled) {
			background: #c82333;
		}

		button:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}

		.message {
			padding: 12px;
			border-radius: 6px;
			margin-bottom: 20px;
			display: none;
		}

		.message.success {
			background: #d4edda;
			color: #155724;
			border: 1px solid #c3e6cb;
		}

		.message.error {
			background: #f8d7da;
			color: #721c24;
			border: 1px solid #f5c6cb;
		}

		.message.info {
			background: #d1ecf1;
			color: #0c5460;
			border: 1px solid #bee5eb;
		}

		.spinner {
			border: 3px solid #f3f3f3;
			border-top: 3px solid #667eea;
			border-radius: 50%;
			width: 20px;
			height: 20px;
			animation: spin 0.8s linear infinite;
			display: inline-block;
			margin-left: 10px;
		}

		@keyframes spin {
			0% { transform: rotate(0deg); }
			100% { transform: rotate(360deg); }
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>🏋️ Hevy API Key Setup</h1>
		
		<div class="user-info">
			<div class="user-details">
				<div class="user-name">${session.name || session.login}</div>
				<div class="user-login">@${session.login}</div>
			</div>
			<a href="/logout" class="logout-btn">Logout</a>
		</div>

		<div class="status ${hasApiKey ? "configured" : "not-configured"}">
			<span class="status-icon">${hasApiKey ? "✅" : "⚠️"}</span>
			<div>
				<strong>${hasApiKey ? "API Key Configured" : "API Key Not Configured"}</strong>
				<div style="font-size: 14px; margin-top: 4px;">
					${hasApiKey ? "Your Hevy API key is stored securely." : "Please enter your Hevy API key below to start using the MCP server."}
				</div>
			</div>
		</div>

		<div id="message" class="message"></div>

		<form id="apiKeyForm">
			<label for="apiKey">Hevy API Key</label>
			<div class="help-text">
				Get your API key from <a href="https://hevy.com/settings?developer" target="_blank" rel="noopener noreferrer">Hevy Settings → Developer</a>
			</div>
			<input 
				type="text" 
				id="apiKey" 
				name="apiKey" 
				placeholder="Enter your Hevy API key..."
				required
			/>

			<div class="button-group">
				<button type="button" id="testBtn" class="btn-secondary">Test Key</button>
				<button type="submit" class="btn-primary">Save Key</button>
			</div>
		</form>

		${hasApiKey ? `
		<div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
			<button id="deleteBtn" class="btn-danger" style="width: 100%;">Delete API Key</button>
		</div>
		` : ""}
	</div>

	<script>
		const form = document.getElementById('apiKeyForm');
		const apiKeyInput = document.getElementById('apiKey');
		const testBtn = document.getElementById('testBtn');
		const deleteBtn = document.getElementById('deleteBtn');
		const message = document.getElementById('message');

		function showMessage(text, type) {
			message.textContent = text;
			message.className = 'message ' + type;
			message.style.display = 'block';
			setTimeout(() => {
				message.style.display = 'none';
			}, 5000);
		}

		async function testApiKey() {
			const apiKey = apiKeyInput.value.trim();
			if (!apiKey) {
				showMessage('Please enter an API key', 'error');
				return;
			}

			testBtn.disabled = true;
			testBtn.innerHTML = 'Testing...<span class="spinner"></span>';

			try {
				const response = await fetch('/api/test-key', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ apiKey }),
				});

				const data = await response.json();

				if (response.ok) {
					showMessage('✅ API key is valid!', 'success');
				} else {
					showMessage('❌ ' + (data.error || 'Invalid API key'), 'error');
				}
			} catch (error) {
				showMessage('❌ Failed to test API key: ' + error.message, 'error');
			} finally {
				testBtn.disabled = false;
				testBtn.textContent = 'Test Key';
			}
		}

		async function saveApiKey(e) {
			e.preventDefault();

			const apiKey = apiKeyInput.value.trim();
			if (!apiKey) {
				showMessage('Please enter an API key', 'error');
				return;
			}

			const submitBtn = form.querySelector('button[type="submit"]');
			submitBtn.disabled = true;
			submitBtn.innerHTML = 'Saving...<span class="spinner"></span>';

			try {
				const response = await fetch('/api/save-key', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ apiKey }),
				});

				const data = await response.json();

				if (response.ok) {
					showMessage('✅ API key saved successfully!', 'success');
					setTimeout(() => location.reload(), 1500);
				} else {
					showMessage('❌ ' + (data.error || 'Failed to save API key'), 'error');
				}
			} catch (error) {
				showMessage('❌ Failed to save API key: ' + error.message, 'error');
			} finally {
				submitBtn.disabled = false;
				submitBtn.textContent = 'Save Key';
			}
		}

		async function deleteApiKey() {
			if (!confirm('Are you sure you want to delete your API key? You will need to configure it again to use the MCP server.')) {
				return;
			}

			deleteBtn.disabled = true;
			deleteBtn.innerHTML = 'Deleting...<span class="spinner"></span>';

			try {
				const response = await fetch('/api/delete-key', {
					method: 'DELETE',
				});

				if (response.ok) {
					showMessage('✅ API key deleted successfully', 'success');
					setTimeout(() => location.reload(), 1500);
				} else {
					const data = await response.json();
					showMessage('❌ ' + (data.error || 'Failed to delete API key'), 'error');
				}
			} catch (error) {
				showMessage('❌ Failed to delete API key: ' + error.message, 'error');
			} finally {
				deleteBtn.disabled = false;
				deleteBtn.textContent = 'Delete API Key';
			}
		}

		testBtn.addEventListener('click', testApiKey);
		form.addEventListener('submit', saveApiKey);
		if (deleteBtn) {
			deleteBtn.addEventListener('click', deleteApiKey);
		}
	</script>
</body>
</html>
	`;

	return c.html(html);
});

/**
 * POST /api/test-key
 * Test if a Hevy API key is valid
 */
app.post("/api/test-key", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		const body = await c.req.json();
		const apiKey = body.apiKey;

		if (!apiKey || typeof apiKey !== "string") {
			return c.json({ error: "Invalid request: apiKey is required" }, 400);
		}

		// Test the API key by making a simple request
		const client = new HevyClient({ apiKey });
		await client.getWorkouts({ pageSize: 1 });

		return c.json({ valid: true });
	} catch (error) {
		console.error("API key test error:", error);
		return c.json(
			{ error: error instanceof Error ? error.message : "Invalid API key" },
			400
		);
	}
});

/**
 * POST /api/save-key
 * Save user's Hevy API key
 */
app.post("/api/save-key", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		const body = await c.req.json();
		const apiKey = body.apiKey;

		if (!apiKey || typeof apiKey !== "string") {
			return c.json({ error: "Invalid request: apiKey is required" }, 400);
		}

		// Validate the API key first
		const client = new HevyClient({ apiKey });
		await client.getWorkouts({ pageSize: 1 });

		// Store encrypted API key in KV
		await setUserApiKey(
			c.env.OAUTH_KV,
			c.env.COOKIE_ENCRYPTION_KEY,
			session.login,
			apiKey
		);

		return c.json({ success: true });
	} catch (error) {
		console.error("API key save error:", error);
		return c.json(
			{ error: error instanceof Error ? error.message : "Failed to save API key" },
			400
		);
	}
});

/**
 * GET /api/get-key
 * Get API key status
 */
app.get("/api/get-key", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		const apiKey = await getUserApiKey(
			c.env.OAUTH_KV,
			c.env.COOKIE_ENCRYPTION_KEY,
			session.login
		);

		if (!apiKey) {
			return c.json({ configured: false });
		}

		return c.json({
			configured: true,
			maskedKey: maskApiKey(apiKey),
		});
	} catch (error) {
		console.error("API key retrieval error:", error);
		return c.json({ error: "Failed to retrieve API key status" }, 500);
	}
});

/**
 * DELETE /api/delete-key
 * Delete user's API key
 */
app.delete("/api/delete-key", async (c) => {
	const session = await getAuthenticatedSession(c);
	if (!session) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		await deleteUserApiKey(c.env.OAUTH_KV, session.login);
		return c.json({ success: true });
	} catch (error) {
		console.error("API key deletion error:", error);
		return c.json({ error: "Failed to delete API key" }, 500);
	}
});

export default app;
