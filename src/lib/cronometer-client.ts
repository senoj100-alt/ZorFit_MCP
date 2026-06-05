export interface CronometerCredentials {
	username?: string;
	password?: string;
	timezone?: string;
	sessionCache?: CronometerSessionCache;
}

export interface CronometerSessionCache {
	get(username: string): Promise<CronometerSession | null>;
	set(username: string, session: CronometerSession): Promise<void>;
	delete(username: string): Promise<void>;
}

export interface CronometerSession {
	userId: number;
	sessionKey: string;
}

export class KvCronometerSessionCache implements CronometerSessionCache {
	private static readonly ttlSeconds = 4 * 60 * 60;

	constructor(private readonly kv: KVNamespace) {}

	private key(username: string): string {
		return `cronometer_session:${username.toLowerCase()}`;
	}

	async get(username: string): Promise<CronometerSession | null> {
		const session = await this.kv.get<CronometerSession>(
			this.key(username),
			"json",
		);
		if (
			!session ||
			typeof session.userId !== "number" ||
			typeof session.sessionKey !== "string" ||
			!session.sessionKey
		) {
			return null;
		}
		return session;
	}

	async set(username: string, session: CronometerSession): Promise<void> {
		await this.kv.put(this.key(username), JSON.stringify(session), {
			expirationTtl: KvCronometerSessionCache.ttlSeconds,
		});
	}

	async delete(username: string): Promise<void> {
		await this.kv.delete(this.key(username));
	}
}

const NUTRIENT_IDS = {
	energy: 208,
	protein: 203,
	fat: 204,
	carbs: 205,
	fiber: 291,
	sugar: 269,
	sodium: 307,
	alcohol: 221,
	netCarbs: -1205,
};

const APP_AUTH = {
	api: 3,
	os: "Android",
	build: "2807",
	flavour: "free",
};

export class CronometerClient {
	private readonly baseUrl = "https://mobile.cronometer.com";
	private userId?: number;
	private token?: string;

	constructor(private readonly credentials: CronometerCredentials) {}

	private requireCredentials(): {
		username: string;
		password: string;
		timezone: string;
	} {
		const {
			username,
			password,
			timezone = "America/New_York",
		} = this.credentials;
		if (!username || !password) {
			throw new Error(
				"Cronometer is not configured. Set CRONOMETER_USERNAME and CRONOMETER_PASSWORD as Worker secrets.",
			);
		}
		return { username, password, timezone };
	}

	private formatDay(date?: string): string {
		const source = date ? new Date(`${date}T00:00:00`) : new Date();
		return `${source.getFullYear()}-${source.getMonth() + 1}-${source.getDate()}`;
	}

	private offsetDay(date: string | undefined, offset: number): string {
		const source = date ? new Date(`${date}T00:00:00`) : new Date();
		source.setDate(source.getDate() + offset);
		return source.toISOString().slice(0, 10);
	}

	private async login(): Promise<void> {
		const { username, password, timezone } = this.requireCredentials();
		const cachedSession = await this.credentials.sessionCache?.get(username);
		if (cachedSession) {
			this.userId = cachedSession.userId;
			this.token = cachedSession.sessionKey;
			return;
		}

		const payload = {
			email: username,
			password,
			timezone,
			userCode: null,
			build: "4.48.2 b2807-a",
			device: "Android 14 (SDK 34), Google Pixel 6 Pro",
			firebaseToken: "",
			features: {
				food_search_config: '{"newSearch": true, "newSpellcheck": true}',
				use_gpt_autofill: "true",
			},
			auth: {
				userId: null,
				token: null,
				...APP_AUTH,
			},
			lastSeen: 0,
			config: { call_version: 2 },
		};

		const response = await fetch(`${this.baseUrl}/api/v2/login`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"User-Agent": "Dart/3.9 (dart:io)",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Cronometer login failed (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		const data = (await response.json()) as {
			id?: number;
			sessionKey?: string;
			result?: string;
		};

		if (!data.id || !data.sessionKey) {
			throw new Error(
				`Cronometer login response did not include a session: ${JSON.stringify(data)}`,
			);
		}

		this.userId = data.id;
		this.token = data.sessionKey;
		await this.credentials.sessionCache?.set(username, {
			userId: this.userId,
			sessionKey: this.token,
		});
	}

	private async clearCachedSession(): Promise<void> {
		const { username } = this.requireCredentials();
		await this.credentials.sessionCache?.delete(username);
	}

	private async request<T>(
		endpoint: string,
		payload: Record<string, unknown>,
		retried = false,
	): Promise<T> {
		if (!this.token) {
			await this.login();
		}

		const response = await fetch(`${this.baseUrl}${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"User-Agent": "Dart/3.9 (dart:io)",
			},
			body: JSON.stringify({
				...payload,
				auth: {
					userId: this.userId,
					token: this.token,
					...APP_AUTH,
				},
				lastSeen: 0,
			}),
		});

		if ((response.status === 401 || response.status === 403) && !retried) {
			this.token = undefined;
			await this.clearCachedSession();
			await this.login();
			return this.request<T>(endpoint, payload, true);
		}

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Cronometer API error (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		const data = (await response.json()) as T & { result?: string };
		if (data && typeof data === "object" && data.result === "FAILURE") {
			if (!retried) {
				this.token = undefined;
				await this.clearCachedSession();
				await this.login();
				return this.request<T>(endpoint, payload, true);
			}
			throw new Error(`Cronometer API failure: ${JSON.stringify(data)}`);
		}

		return data;
	}

	private async requestV3(
		method: string,
		path: string,
		jsonBody?: Record<string, unknown>,
		retried = false,
	): Promise<Response> {
		if (!this.token) {
			await this.login();
		}

		const response = await fetch(
			`${this.baseUrl}/api/v3/user/${this.userId}${path}`,
			{
				method,
				headers: {
					"x-crono-session": this.token ?? "",
					"x-crono-app-os": "android",
					"x-crono-app-build-number": "2807",
					"x-crono-app-version": "4.48.2",
					"Content-Type": "application/json; charset=utf-8",
				},
				body: jsonBody ? JSON.stringify(jsonBody) : undefined,
			},
		);

		if ((response.status === 401 || response.status === 403) && !retried) {
			this.token = undefined;
			await this.clearCachedSession();
			await this.login();
			return this.requestV3(method, path, jsonBody, true);
		}

		return response;
	}

	async searchFood(query: string): Promise<unknown[]> {
		const data = await this.request<{ foods?: unknown[] }>(
			"/api/v2/find_food",
			{
				query,
				tab: "ALL",
				sources: ["All"],
				config: {
					newSearch: true,
					newSpellcheck: true,
					call_version: 1,
				},
			},
		);
		return data.foods ?? [];
	}

	async getFood(foodId: number): Promise<unknown> {
		return this.request("/api/v2/get_food", {
			id: foodId,
			config: { call_version: 1 },
		});
	}

	async createCustomFood(args: {
		name: string;
		calories: number;
		proteinG: number;
		fatG: number;
		carbsG: number;
		fiberG?: number;
		sugarG?: number;
		sodiumMg?: number;
		servingName?: string;
		servingGrams?: number;
	}): Promise<unknown> {
		const servingGrams = args.servingGrams ?? 100;
		const scale = servingGrams > 0 ? 100 / servingGrams : 1;
		const fiber = args.fiberG ?? 0;
		const sugar = args.sugarG ?? 0;
		const sodium = args.sodiumMg ?? 0;
		const netCarbs = Math.max(0, args.carbsG - fiber);

		return this.request("/api/v2/add_food", {
			data: {
				id: 0,
				name: args.name,
				category: 0,
				owner: null,
				retired: null,
				source: null,
				defaultMeasureId: 0,
				comments: null,
				alternateId: null,
				measures: [
					{
						id: 0,
						name: args.servingName ?? "1 serving",
						value: servingGrams,
						amount: 1.0,
						type: "Atomic",
					},
				],
				labelType: "AMERICAN_2016",
				nutrients: [
					{
						id: NUTRIENT_IDS.energy,
						amount: Math.round(args.calories * scale * 100) / 100,
					},
					{
						id: NUTRIENT_IDS.protein,
						amount: Math.round(args.proteinG * scale * 100) / 100,
					},
					{
						id: NUTRIENT_IDS.fat,
						amount: Math.round(args.fatG * scale * 100) / 100,
					},
					{
						id: NUTRIENT_IDS.carbs,
						amount: Math.round(args.carbsG * scale * 100) / 100,
					},
					{
						id: NUTRIENT_IDS.fiber,
						amount: Math.round(fiber * scale * 100) / 100,
					},
					{
						id: NUTRIENT_IDS.sugar,
						amount: Math.round(sugar * scale * 100) / 100,
					},
					{
						id: NUTRIENT_IDS.sodium,
						amount: Math.round(sodium * scale * 100) / 100,
					},
					{ id: -203, amount: Math.round(args.proteinG * scale * 100) / 100 },
					{ id: -204, amount: Math.round(args.fatG * scale * 100) / 100 },
					{ id: -205, amount: Math.round(args.carbsG * scale * 100) / 100 },
					{ id: -221, amount: 0 },
					{
						id: NUTRIENT_IDS.netCarbs,
						amount: Math.round(netCarbs * scale * 100) / 100,
					},
				],
				properties: {},
				foodTags: [],
			},
			config: { call_version: 1 },
		});
	}

	private mealGroupForHour(hour: number): number {
		if (hour >= 4 && hour < 10) return 1;
		if (hour >= 10 && hour < 14) return 2;
		if (hour >= 14 && hour < 21) return 3;
		return 4;
	}

	async addServing(args: {
		foodId: number;
		measureId?: number;
		grams: number;
		date?: string;
		translationId?: number;
		diaryGroup?: number;
	}): Promise<unknown> {
		if (!this.userId) {
			await this.login();
		}
		const now = new Date();
		const diaryGroup =
			args.diaryGroup && args.diaryGroup > 0
				? args.diaryGroup
				: this.mealGroupForHour(now.getHours());
		const serving = {
			order: (diaryGroup << 16) | 1,
			day: this.formatDay(args.date),
			time: `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
			offset: null,
			source: null,
			userId: this.userId,
			servingId: null,
			type: "Serving",
			foodId: args.foodId,
			measureId: args.measureId ?? 0,
			grams: args.grams,
			translationId: args.translationId ?? 0,
		};

		return this.request("/api/v2/add_serving", {
			serving,
			config: { call_version: 2 },
		});
	}

	async getDiary(date?: string): Promise<unknown> {
		return this.request("/api/v2/get_diary", {
			day: this.formatDay(date),
			config: { call_version: 1 },
		});
	}

	async deleteEntries(entryIds: string[], date?: string): Promise<unknown> {
		const diaryData = (await this.getDiary(date)) as {
			diary?: Array<Record<string, unknown>>;
		};
		const idSet = new Set(entryIds.map(String));
		const toDelete = (diaryData.diary ?? []).filter((entry) =>
			idSet.has(String(entry.servingId)),
		);

		if (toDelete.length === 0) {
			return { removed: [], count: 0 };
		}

		const response = await this.requestV3("DELETE", "/diary-entries", {
			diaryEntries: toDelete,
		});
		if (response.status !== 204) {
			throw new Error(
				`Cronometer delete failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
			);
		}

		return {
			removed: toDelete.map((entry) => String(entry.servingId)),
			count: toDelete.length,
		};
	}

	async markDayComplete(date: string, complete: boolean): Promise<unknown> {
		return this.request("/api/v2/set_complete", {
			day: this.formatDay(date),
			complete,
			config: { call_version: 1 },
		});
	}

	async copyDay(date?: string): Promise<unknown> {
		const to = this.formatDay(date);
		const from = this.formatDay(this.offsetDay(date, -1));
		return this.request("/api/v2/copy", {
			from,
			to,
			diaryGroupNumber: null,
			config: { call_version: 1 },
		});
	}

	async getNutrients(date?: string): Promise<unknown> {
		return this.request("/api/v2/get_nutrients", {
			day: this.formatDay(date),
			config: { call_version: 1 },
		});
	}

	async getDailyNutrition(date?: string): Promise<unknown> {
		const diary = (await this.getDiary(date)) as {
			summary?: Record<string, unknown>;
			diary?: Array<Record<string, unknown>>;
		};
		const [nutrients, nutritionScores] = await Promise.all([
			this.getNutrients(date),
			this.getNutritionScoresFromDiary(diary),
		]);
		return {
			date: date ?? new Date().toISOString().slice(0, 10),
			summary: diary.summary ?? null,
			nutrients,
			nutritionScores,
			entries: diary.diary ?? [],
		};
	}

	private async getNutritionScoresFromDiary(diaryData: {
		diary?: Array<Record<string, unknown>>;
	}): Promise<unknown> {
		const servingIds = (diaryData.diary ?? [])
			.filter(
				(entry) => entry.type === "Serving" && entry.servingId !== undefined,
			)
			.map((entry) => entry.servingId);

		return this.request("/api/v2/get_nutrition_scores", {
			startDay: "1900-1-1",
			endDay: "1900-1-1",
			servingIds,
			supplements: "true",
			config: { call_version: 1 },
		});
	}

	async getNutritionScores(date?: string): Promise<unknown> {
		const diaryData = (await this.getDiary(date)) as {
			diary?: Array<Record<string, unknown>>;
		};
		return this.getNutritionScoresFromDiary(diaryData);
	}

	async getMacroTargets(): Promise<unknown> {
		const [schedules, templates] = await Promise.all([
			this.request("/api/v2/get_macro_schedules", {
				config: { call_version: 1 },
			}),
			this.request("/api/v2/get_macro_target_templates", {
				config: { call_version: 1 },
			}),
		]);

		return { schedules, templates };
	}

	async getFastingHistory(
		startDate?: string,
		endDate?: string,
	): Promise<unknown> {
		const end = endDate ?? new Date().toISOString().slice(0, 10);
		const start = startDate ?? this.offsetDay(end, -30);
		return this.request("/api/v2/get_fasting_with_date_range", {
			start: this.formatDay(start),
			end: this.formatDay(end),
			config: { call_version: 1 },
		});
	}

	async getFastingStats(): Promise<unknown> {
		return this.request("/api/v2/get_fasting_stats", {
			config: { call_version: 1 },
		});
	}
}
