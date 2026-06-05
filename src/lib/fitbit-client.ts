export interface FitbitCredentials {
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

export class FitbitClient {
	private readonly baseUrl = "https://api.fitbit.com/1";
	private accessToken?: string;
	private refreshToken?: string;

	constructor(private readonly credentials: FitbitCredentials) {
		this.accessToken = credentials.accessToken;
		this.refreshToken = credentials.refreshToken;
	}

	private requireCredentials(): void {
		if (!this.accessToken || !this.refreshToken) {
			throw new Error("Fitbit is not connected. Open /connections and connect Fitbit.");
		}
	}

	private async refreshAccessToken(): Promise<void> {
		const { clientId, clientSecret, onTokenRefresh } = this.credentials;
		if (!clientId || !clientSecret || !this.refreshToken) {
			throw new Error("Fitbit refresh credentials are missing.");
		}

		const response = await fetch("https://api.fitbit.com/oauth2/token", {
			method: "POST",
			headers: {
				Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.refreshToken,
			}),
		});

		if (!response.ok) {
			throw new Error(`Fitbit token refresh failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
		}

		const data = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!data.access_token || !data.refresh_token) {
			throw new Error("Fitbit token refresh response did not include tokens.");
		}

		this.accessToken = data.access_token;
		this.refreshToken = data.refresh_token;
		await onTokenRefresh?.({
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
		});
	}

	private async request<T>(path: string, retried = false): Promise<T> {
		this.requireCredentials();
		const response = await fetch(`${this.baseUrl}${path}`, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: "application/json",
			},
		});

		if (response.status === 401 && !retried) {
			await this.refreshAccessToken();
			return this.request<T>(path, true);
		}

		if (!response.ok) {
			throw new Error(`Fitbit API error (${response.status}): ${(await response.text()).slice(0, 500)}`);
		}

		return response.json() as Promise<T>;
	}

	async getProfile(): Promise<unknown> {
		return this.request("/user/-/profile.json");
	}

	async getActivitySummary(date = "today"): Promise<unknown> {
		return this.request(`/user/-/activities/date/${encodeURIComponent(date)}.json`);
	}

	async getSleep(date = "today"): Promise<unknown> {
		return this.request(`/user/-/sleep/date/${encodeURIComponent(date)}.json`);
	}

	async getBodyWeight(date = "today"): Promise<unknown> {
		return this.request(`/user/-/body/log/weight/date/${encodeURIComponent(date)}.json`);
	}

	async getHeartRate(date = "today", period = "1d"): Promise<unknown> {
		return this.request(
			`/user/-/activities/heart/date/${encodeURIComponent(date)}/${encodeURIComponent(period)}.json`,
		);
	}
}
