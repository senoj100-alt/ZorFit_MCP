/**
 * OAuth Provider Utilities
 * Handles approval dialogs and client approval tracking
 */

import { ZORFIT_BRAND, ZORFIT_THEME_CSS } from "./lib/zorfit-theme.js";

/**
 * Renders the OAuth approval dialog HTML
 * Shown to users when authorizing a new OAuth client
 */
export function renderApprovalDialog(params: {
	clientId: string;
	redirectUri: string;
	state: string;
	scope: string;
	userLogin: string;
	userName: string;
	authorizeEndpoint: string;
}): string {
	const { clientId, redirectUri, state, scope, userLogin, userName, authorizeEndpoint } = params;
	const display = {
		authorizeEndpoint: escapeHtml(authorizeEndpoint),
		clientId: escapeHtml(clientId),
		redirectHost: escapeHtml(safeHostLabel(redirectUri)),
		redirectUri: escapeHtml(redirectUri),
		scope: escapeHtml(scope || "mcp"),
		state: escapeHtml(state),
		userLogin: escapeHtml(userLogin),
		userName: escapeHtml(userName),
	};

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Authorize ZorFit_MCP</title>
	<style>
		${ZORFIT_THEME_CSS}
		:root {
			--panel-soft: rgba(245, 242, 236, 0.06);
			--shadow: rgba(0, 0, 0, 0.38);
		}
		body {
			min-height: 100vh;
			padding: 32px 18px;
		}
		.container {
			position: relative;
			z-index: 1;
			max-width: 680px;
			width: 100%;
			margin: 0 auto;
		}
		.header {
			margin-bottom: 18px;
		}
		.brand {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 26px;
		}
		.brand-subtitle {
			color: var(--muted);
			display: block;
			font-size: 13px;
		}
		.header h1 {
			font-size: clamp(32px, 6vw, 54px);
			line-height: 0.98;
			letter-spacing: 0;
			max-width: 620px;
			margin-bottom: 14px;
		}
		.header p {
			color: var(--soft);
			font-size: 17px;
			line-height: 1.6;
			max-width: 610px;
		}
		.panel {
			background: linear-gradient(180deg, rgba(245, 242, 236, 0.07), rgba(245, 242, 236, 0.035));
			border: 1px solid var(--line);
			border-radius: 8px;
			box-shadow: 0 26px 80px var(--shadow);
			padding: 24px;
			backdrop-filter: blur(18px);
		}
		.user-info {
			background: var(--panel-soft);
			border: 1px solid var(--line);
			border-radius: 8px;
			padding: 16px;
			margin-bottom: 16px;
		}
		.user-info p {
			color: var(--muted);
			font-size: 14px;
		}
		.user-info strong {
			color: var(--text);
		}
		.permissions {
			display: grid;
			gap: 12px;
			margin: 18px 0;
		}
		.permissions h2 {
			font-size: 15px;
			color: var(--text);
			margin-bottom: 2px;
		}
		.permission-item {
			background: rgba(245, 242, 236, 0.045);
			border: 1px solid var(--line);
			padding: 14px;
			border-radius: 8px;
		}
		.permission-item p {
			color: var(--muted);
			font-size: 14px;
			line-height: 1.5;
		}
		.permission-item strong {
			color: var(--text);
			display: block;
			margin-bottom: 4px;
		}
		.client-info {
			background: rgba(255, 92, 26, 0.08);
			border: 1px solid rgba(255, 92, 26, 0.24);
			padding: 14px;
			margin: 16px 0 20px;
			border-radius: 8px;
		}
		.client-info p {
			color: var(--muted);
			font-size: 13px;
			line-height: 1.7;
			overflow-wrap: anywhere;
		}
		.client-info code {
			background: rgba(0, 0, 0, 0.28);
			color: var(--amber);
			padding: 2px 6px;
			border-radius: 5px;
			font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			font-size: 12px;
		}
		.actions {
			display: flex;
			gap: 12px;
			margin-top: 22px;
		}
		button {
			flex: 1;
			min-height: 52px;
			padding: 13px 22px;
			border-radius: 6px;
			font-size: 15px;
			font-weight: 600;
			cursor: pointer;
			transition: transform 0.2s, border-color 0.2s, background 0.2s;
		}
		.btn-approve {
			background: var(--green);
			color: #07100b;
			border: 1px solid var(--green);
		}
		.btn-approve:hover {
			background: var(--green-strong);
			border-color: var(--green-strong);
			transform: translateY(-1px);
		}
		.btn-deny {
			background: transparent;
			border: 1px solid var(--line);
			color: var(--soft);
		}
		.btn-deny:hover {
			border-color: rgba(255, 255, 255, 0.28);
			background: rgba(255, 255, 255, 0.06);
		}
		.footer {
			margin-top: 18px;
			text-align: center;
			color: var(--muted);
			font-size: 12px;
		}
		@media (max-width: 620px) {
			body {
				padding: 22px 14px;
			}
			.panel {
				padding: 18px;
			}
			.actions {
				flex-direction: column;
			}
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<div class="brand">
				${ZORFIT_BRAND}
				<span class="brand-subtitle">Private health context for AI agents</span>
			</div>
			<h1>Connect ZorFit_MCP to Claude.</h1>
			<p>Claude is asking permission to use your ZorFit MCP endpoint. Approving lets Claude read the fitness sources you connect, then answer questions using your workouts, nutrition, sleep, recovery, and activity context.</p>
		</div>

		<div class="panel">
			<div class="user-info">
				<p><strong>Signed in as:</strong> ${display.userName} (@${display.userLogin})</p>
			</div>

			<div class="client-info">
				<p><strong>Requesting app:</strong> ${display.redirectHost}</p>
				<p><strong>Scope:</strong> <code>${display.scope}</code></p>
				<p><strong>Client ID:</strong> <code>${display.clientId}</code></p>
				<p><strong>Redirect URI:</strong> <code>${display.redirectUri}</code></p>
			</div>

			<div class="permissions">
				<h2>Claude will be able to:</h2>
				<div class="permission-item">
					<p><strong>Read connected health sources</strong></p>
					<p>Use your connected Hevy, Strava, Cronometer, Intervals.icu, Fitbit, and Google Fit data through ZorFit_MCP.</p>
				</div>
				<div class="permission-item">
					<p><strong>Call ZorFit MCP tools</strong></p>
					<p>Summarize training, nutrition, sleep, activity, recovery, and cross-source patterns when you ask Claude health-related questions.</p>
				</div>
				<div class="permission-item">
					<p><strong>Keep provider credentials private</strong></p>
					<p>Claude receives MCP tool results, not your raw API keys or passwords. Stored credentials remain encrypted in your ZorFit account.</p>
				</div>
			</div>

			<form method="POST" action="${display.authorizeEndpoint}">
				<input type="hidden" name="client_id" value="${display.clientId}" />
				<input type="hidden" name="redirect_uri" value="${display.redirectUri}" />
				<input type="hidden" name="state" value="${display.state}" />
				<input type="hidden" name="scope" value="${display.scope}" />
				
				<div class="actions">
					<button type="submit" name="approve" value="true" class="btn-approve">
						Authorize Claude
					</button>
					<button type="submit" name="approve" value="false" class="btn-deny">
						Cancel
					</button>
				</div>
			</form>

			<div class="footer">
				<p>You can remove this approval later by signing out or clearing the connector from Claude.</p>
			</div>
		</div>
	</div>
</body>
</html>`;
}

function safeHostLabel(uri: string): string {
	try {
		return new URL(uri).hostname;
	} catch {
		return "Connected MCP client";
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return char;
		}
	});
}

/**
 * Parses the approval form submission
 */
export async function parseRedirectApproval(request: Request): Promise<{
	approved: boolean;
	clientId: string;
	redirectUri: string;
	state: string;
	scope: string;
}> {
	const formData = await request.formData();

	return {
		approved: formData.get("approve") === "true",
		clientId: formData.get("client_id") as string,
		redirectUri: formData.get("redirect_uri") as string,
		state: formData.get("state") as string,
		scope: formData.get("scope") as string,
	};
}

/**
 * Checks if a client has already been approved by the user
 * Stored in KV with key: `approval:{username}:{clientId}`
 */
export async function clientIdAlreadyApproved(
	kv: KVNamespace,
	username: string,
	clientId: string
): Promise<boolean> {
	const key = `approval:${username}:${clientId}`;
	const approval = await kv.get(key);
	return approval === "true";
}

/**
 * Stores client approval in KV
 */
export async function storeClientApproval(
	kv: KVNamespace,
	username: string,
	clientId: string
): Promise<void> {
	const key = `approval:${username}:${clientId}`;
	// Store for 1 year
	await kv.put(key, "true", { expirationTtl: 365 * 24 * 60 * 60 });
}
