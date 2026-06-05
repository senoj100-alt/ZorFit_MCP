/**
 * OAuth Utilities for GitHub Authentication
 * Based on Cloudflare OAuth provider patterns
 */

/**
 * Props type that holds user information from an upstream OAuth provider
 * Note: Hevy API keys are stored separately in KV and fetched as needed
 */
export type Props = {
	login: string; // Stable ZorFit login key
	name: string; // Display name
	email: string; // Email address
	accessToken: string; // Upstream provider access token
	baseUrl?: string; // Base URL of the worker (for generating setup links)
};

/**
 * Constructs the GitHub OAuth authorization URL
 */
export function getUpstreamAuthorizeUrl(
	clientId: string,
	redirectUri: string,
	state: string,
	scope = "user:email"
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		state,
		scope,
		response_type: "code",
	});

	return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Exchanges authorization code for access token
 */
export async function fetchUpstreamAuthToken(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string
): Promise<string> {
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		throw new Error(`GitHub token exchange failed: ${response.statusText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		error?: string;
		error_description?: string;
	};

	if (data.error) {
		throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
	}

	if (!data.access_token) {
		throw new Error("No access token received from GitHub");
	}

	return data.access_token;
}

/**
 * Fetches user information from GitHub API
 */
export async function fetchGitHubUser(
	accessToken: string
): Promise<{ login: string; name: string; email: string }> {
	const response = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "Hevy-MCP-Server",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub user: ${response.statusText}`);
	}

	const user = (await response.json()) as {
		login: string;
		name: string | null;
		email: string | null;
	};

	// Fetch email separately if not included in user object
	let email = user.email;
	if (!email) {
		const emailResponse = await fetch("https://api.github.com/user/emails", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Hevy-MCP-Server",
			},
		});

		if (emailResponse.ok) {
			const emails = (await emailResponse.json()) as Array<{
				email: string;
				primary: boolean;
				verified: boolean;
			}>;
			const primaryEmail = emails.find((e) => e.primary && e.verified);
			email = primaryEmail?.email || emails[0]?.email || "";
		}
	}

	return {
		login: user.login,
		name: user.name || user.login,
		email: email || "",
	};
}

/**
 * Constructs a Google OpenID Connect authorization URL
 */
export function getGoogleAuthorizeUrl(
	clientId: string,
	redirectUri: string,
	state: string
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		state,
		scope: "openid email profile",
		response_type: "code",
		access_type: "offline",
		prompt: "select_account",
	});

	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchanges a Google authorization code for an access token
 */
export async function fetchGoogleAuthToken(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string
): Promise<string> {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
	});

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!response.ok) {
		throw new Error(`Google token exchange failed: ${response.statusText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		error?: string;
		error_description?: string;
	};

	if (data.error) {
		throw new Error(`Google OAuth error: ${data.error_description || data.error}`);
	}

	if (!data.access_token) {
		throw new Error("No access token received from Google");
	}

	return data.access_token;
}

/**
 * Fetches user information from Google's OpenID Connect userinfo endpoint
 */
export async function fetchGoogleUser(
	accessToken: string
): Promise<{ login: string; name: string; email: string }> {
	const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch Google user: ${response.statusText}`);
	}

	const user = (await response.json()) as {
		sub: string;
		name?: string;
		email?: string;
	};

	return {
		login: `google:${user.sub}`,
		name: user.name || user.email || "Google user",
		email: user.email || "",
	};
}
