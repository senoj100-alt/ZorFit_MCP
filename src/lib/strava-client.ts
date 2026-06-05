export interface StravaCredentials {
	accessToken?: string;
	refreshToken?: string;
	clientId?: string;
	clientSecret?: string;
	onTokenRefresh?: (tokens: {
		accessToken: string;
		refreshToken: string;
		expiresAt?: number;
	}) => Promise<void>;
}

export class StravaClient {
	private readonly baseUrl = "https://www.strava.com/api/v3";
	private accessToken?: string;
	private refreshToken?: string;

	constructor(private readonly credentials: StravaCredentials) {
		this.accessToken = credentials.accessToken;
		this.refreshToken = credentials.refreshToken;
	}

	private requireCredentials(): void {
		if (!this.accessToken || !this.refreshToken) {
			throw new Error(
				"Strava is not configured. Set STRAVA_ACCESS_TOKEN, STRAVA_REFRESH_TOKEN, STRAVA_CLIENT_ID, and STRAVA_CLIENT_SECRET as Worker secrets.",
			);
		}
	}

	private async refreshAccessToken(): Promise<void> {
		const { clientId, clientSecret, onTokenRefresh } = this.credentials;
		if (!clientId || !clientSecret || !this.refreshToken) {
			throw new Error("Strava refresh credentials are missing.");
		}

		const response = await fetch("https://www.strava.com/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: this.refreshToken,
				grant_type: "refresh_token",
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Strava token refresh failed (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		const data = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_at?: number;
		};
		if (!data.access_token || !data.refresh_token) {
			throw new Error("Strava token refresh response did not include tokens.");
		}

		this.accessToken = data.access_token;
		this.refreshToken = data.refresh_token;
		await onTokenRefresh?.({
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAt: data.expires_at,
		});
	}

	private async request<T>(
		path: string,
		options: RequestInit = {},
		retried = false,
	): Promise<T> {
		this.requireCredentials();
		const response = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: "application/json",
				...options.headers,
			},
		});

		if (response.status === 401 && !retried) {
			await this.refreshAccessToken();
			return this.request<T>(path, options, true);
		}

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Strava API error (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		return response.json() as Promise<T>;
	}

	async getAthlete(): Promise<unknown> {
		return this.request("/athlete");
	}

	async getRecentActivities(perPage = 30): Promise<unknown[]> {
		const params = new URLSearchParams({
			per_page: String(Math.min(Math.max(perPage, 1), 100)),
		});
		return this.request(`/athlete/activities?${params.toString()}`);
	}

	async starSegment(segmentId: number, starred: boolean): Promise<unknown> {
		return this.request(`/segments/${segmentId}/starred`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ starred }),
		});
	}
}
