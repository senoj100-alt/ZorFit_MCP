export interface GoogleFitCredentials {
	accessToken?: string;
	refreshToken?: string;
	clientId?: string;
	clientSecret?: string;
	onTokenRefresh?: (tokens: {
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
	}) => Promise<void>;
}

export class GoogleFitClient {
	private readonly baseUrl = "https://fitness.googleapis.com/fitness/v1";
	private accessToken?: string;
	private refreshToken?: string;

	constructor(private readonly credentials: GoogleFitCredentials) {
		this.accessToken = credentials.accessToken;
		this.refreshToken = credentials.refreshToken;
	}

	private requireCredentials(): void {
		if (!this.accessToken || !this.refreshToken) {
			throw new Error("Google Fit is not connected. Open /connections and connect Google Fit.");
		}
	}

	private async refreshAccessToken(): Promise<void> {
		const { clientId, clientSecret, onTokenRefresh } = this.credentials;
		if (!clientId || !clientSecret || !this.refreshToken) {
			throw new Error("Google Fit refresh credentials are missing.");
		}

		const response = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: this.refreshToken,
				grant_type: "refresh_token",
			}),
		});

		if (!response.ok) {
			throw new Error(`Google token refresh failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
		}

		const data = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!data.access_token) {
			throw new Error("Google token refresh response did not include an access token.");
		}

		this.accessToken = data.access_token;
		await onTokenRefresh?.({
			accessToken: data.access_token,
			refreshToken: this.refreshToken,
			expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
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
			throw new Error(`Google Fit API error (${response.status}): ${(await response.text()).slice(0, 500)}`);
		}

		return response.json() as Promise<T>;
	}

	async listDataSources(): Promise<unknown> {
		return this.request("/users/me/dataSources");
	}

	async aggregate(args: {
		startTimeMillis: number;
		endTimeMillis: number;
		dataTypeNames: string[];
		bucketByTimeMillis?: number;
	}): Promise<unknown> {
		return this.request("/users/me/dataset:aggregate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				aggregateBy: args.dataTypeNames.map((dataTypeName) => ({ dataTypeName })),
				bucketByTime: {
					durationMillis: args.bucketByTimeMillis ?? 24 * 60 * 60 * 1000,
				},
				startTimeMillis: args.startTimeMillis,
				endTimeMillis: args.endTimeMillis,
			}),
		});
	}
}
