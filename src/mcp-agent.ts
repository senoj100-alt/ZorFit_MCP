import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HevyClient } from "./lib/client.js";
import {
	CreateWorkoutSchema,
	UpdateWorkoutSchema,
	CreateRoutineSchema,
	UpdateRoutineSchema,
	CreateExerciseTemplateSchema,
	CreateRoutineFolderSchema,
	transformWorkoutToAPI,
	transformRoutineToAPI,
	transformExerciseTemplateToAPI,
	transformRoutineFolderToAPI,
} from "./lib/schemas.js";
import {
	ValidationError,
	validatePagination,
	validateISO8601Date,
	validateWorkoutData,
	validateRoutineData,
	validateExerciseTemplate,
	PAGINATION_LIMITS,
} from "./lib/transforms.js";
import { handleError } from "./lib/errors.js";
import type { Props } from "./utils.js";
import { getUserApiKey } from "./lib/key-storage.js";
import { getZorFitServiceStatuses } from "./lib/service-registry.js";
import { getServiceConnection } from "./lib/service-connections.js";
import { StravaClient } from "./lib/strava-client.js";
import { CronometerClient, KvCronometerSessionCache } from "./lib/cronometer-client.js";
import { IntervalsClient } from "./lib/intervals-client.js";
import { FitbitClient } from "./lib/fitbit-client.js";
import { GoogleFitClient } from "./lib/google-fit-client.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

// Environment interface for OAuth multi-user support
interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	OAUTH_KV: KVNamespace;
	ZORFIT_DB: D1Database;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
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

// Define our MCP agent with fitness API tools and OAuth support
export class ZorFitMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "ZorFit_MCP",
		version: "1.0.0",
		description:
			"Multi-user remote MCP server for Hevy, Strava, Cronometer, Intervals.icu, Fitbit, and Google Fit health data",
	});

	private client?: HevyClient;

	private createCronometerClient(): CronometerClient {
		return new CronometerClient({
			username: this.env.CRONOMETER_USERNAME,
			password: this.env.CRONOMETER_PASSWORD,
			sessionCache: new KvCronometerSessionCache(this.env.OAUTH_KV),
		});
	}

	private createFitbitClient(): FitbitClient {
		return new FitbitClient({
			accessToken: this.env.FITBIT_ACCESS_TOKEN,
			refreshToken: this.env.FITBIT_REFRESH_TOKEN,
			clientId: this.env.FITBIT_CLIENT_ID,
			clientSecret: this.env.FITBIT_CLIENT_SECRET,
			onTokenRefresh: async (tokens) => {
				if (!this.props?.login) return;
				const { upsertServiceConnection } = await import("./lib/service-connections.js");
				await upsertServiceConnection(this.env, this.props, {
					serviceId: "fitbit",
					authType: "oauth",
					credentials: {
						accessToken: tokens.accessToken,
						refreshToken: tokens.refreshToken,
					},
					expiresAt: tokens.expiresAt,
				});
				this.env.FITBIT_ACCESS_TOKEN = tokens.accessToken;
				this.env.FITBIT_REFRESH_TOKEN = tokens.refreshToken;
			},
		});
	}

	private createGoogleFitClient(): GoogleFitClient {
		return new GoogleFitClient({
			accessToken: this.env.GOOGLE_FIT_ACCESS_TOKEN,
			refreshToken: this.env.GOOGLE_FIT_REFRESH_TOKEN,
			clientId: this.env.GOOGLE_FIT_CLIENT_ID,
			clientSecret: this.env.GOOGLE_FIT_CLIENT_SECRET,
			onTokenRefresh: async (tokens) => {
				if (!this.props?.login) return;
				const { upsertServiceConnection } = await import("./lib/service-connections.js");
				await upsertServiceConnection(this.env, this.props, {
					serviceId: "google_fit",
					authType: "oauth",
					credentials: {
						accessToken: tokens.accessToken,
						refreshToken: tokens.refreshToken ?? this.env.GOOGLE_FIT_REFRESH_TOKEN,
					},
					expiresAt: tokens.expiresAt,
				});
				this.env.GOOGLE_FIT_ACCESS_TOKEN = tokens.accessToken;
				if (tokens.refreshToken) this.env.GOOGLE_FIT_REFRESH_TOKEN = tokens.refreshToken;
			},
		});
	}

	private getHevyClient(): HevyClient {
		if (!this.client) {
			throw new Error(
				"Hevy is not configured. Add HEVY_API_KEY as a Worker secret, or sign in and add a personal Hevy API key from /connections.",
			);
		}
		return this.client;
	}

	private async loadUserServiceConnections(): Promise<void> {
		if (!this.props?.login) return;
		const services = [
			"hevy",
			"strava",
			"cronometer",
			"intervals_icu",
			"fitbit",
			"google_fit",
		] as const;

		for (const serviceId of services) {
			const connection = await getServiceConnection(this.env, this.props, serviceId);
			if (!connection) continue;
			const credentials = connection.credentials as Record<string, string | number | undefined>;

			switch (serviceId) {
				case "hevy":
					if (credentials.apiKey) this.env.HEVY_API_KEY = String(credentials.apiKey);
					break;
				case "strava":
					if (credentials.accessToken) this.env.STRAVA_ACCESS_TOKEN = String(credentials.accessToken);
					if (credentials.refreshToken) this.env.STRAVA_REFRESH_TOKEN = String(credentials.refreshToken);
					break;
				case "cronometer":
					if (credentials.username) this.env.CRONOMETER_USERNAME = String(credentials.username);
					if (credentials.password) this.env.CRONOMETER_PASSWORD = String(credentials.password);
					break;
				case "intervals_icu":
					if (credentials.apiKey) this.env.INTERVALS_ICU_API_KEY = String(credentials.apiKey);
					if (credentials.athleteId) this.env.INTERVALS_ICU_ATHLETE_ID = String(credentials.athleteId);
					break;
				case "fitbit":
					if (credentials.accessToken) this.env.FITBIT_ACCESS_TOKEN = String(credentials.accessToken);
					if (credentials.refreshToken) this.env.FITBIT_REFRESH_TOKEN = String(credentials.refreshToken);
					break;
				case "google_fit":
					if (credentials.accessToken) this.env.GOOGLE_FIT_ACCESS_TOKEN = String(credentials.accessToken);
					if (credentials.refreshToken) this.env.GOOGLE_FIT_REFRESH_TOKEN = String(credentials.refreshToken);
					break;
			}
		}
	}

	async init() {
		// Check if user is authenticated
		if (!this.props || !this.props.login) {
			const setupHint = this.props?.baseUrl
				? ` Visit ${this.props.baseUrl}/connections to get started.`
				: " Visit your server URL to authenticate.";
			throw new Error(
				"Authentication required. Please authenticate via OAuth to use ZorFit_MCP." +
					setupHint
			);
		}

		// Load user's Hevy API key from encrypted KV storage
		const userApiKey = await getUserApiKey(
			this.env.OAUTH_KV,
			this.env.COOKIE_ENCRYPTION_KEY,
			this.props.login
		);
		await this.loadUserServiceConnections();
		const hevyApiKey = userApiKey || this.env.HEVY_API_KEY;

		if (hevyApiKey) {
			this.client = new HevyClient({
				apiKey: hevyApiKey,
			});
		}

		// ============================================
		// FITNESS AGGREGATOR
		// ============================================

		this.server.tool(
			"fitness_get_connected_services",
			{},
			async () => {
					try {
						const session = this.props;
						if (!session?.login) {
							throw new Error("Authentication required.");
						}
						const statuses = await getZorFitServiceStatuses(
							this.env,
							session,
						);

					const summary = statuses
						.map((service) => {
							const state = service.configured ? "configured" : "missing";
							return `${service.label}: ${state} (${service.auth}, ${service.source})`;
						})
						.join("\n");

					return {
						content: [
							{
								type: "text",
								text: `ZorFit service status for ${session.login}:\n${summary}`,
							},
							{
								type: "text",
								text: JSON.stringify(statuses, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"fitness_get_integration_plan",
			{},
			async () => ({
				content: [
					{
						type: "text",
						text: [
							"ZorFit MCP integration plan:",
							"1. Keep the existing Hevy remote tools as the base implementation.",
							"2. Port Strava OAuth and activity tools into a Worker-native module.",
							"3. Port Cronometer credential handling and nutrition/body tools into a Worker-native module.",
							"4. Port Intervals.icu API-key access and calendar/activity tools into a Worker-native module.",
							"5. Add Fitbit and Google Fit OAuth tools for consumer wearable and phone health data.",
							"6. Add normalized cross-service tools such as fitness_get_daily_summary and fitness_query_metrics.",
						].join("\n"),
					},
				],
			}),
		);

		// ============================================
		// STRAVA
		// ============================================

		this.server.tool(
			"strava_get_athlete",
			{},
			async () => {
				try {
					const strava = new StravaClient({
						accessToken: this.env.STRAVA_ACCESS_TOKEN,
						refreshToken: this.env.STRAVA_REFRESH_TOKEN,
						clientId: this.env.STRAVA_CLIENT_ID,
						clientSecret: this.env.STRAVA_CLIENT_SECRET,
					});
					const athlete = await strava.getAthlete();

					return {
						content: [
							{
								type: "text",
								text: "Retrieved Strava athlete profile.",
							},
							{
								type: "text",
								text: JSON.stringify(athlete, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"strava_get_recent_activities",
			{
				per_page: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.default(30)
					.describe("Number of recent Strava activities to fetch"),
			},
			async ({ per_page }) => {
				try {
					const strava = new StravaClient({
						accessToken: this.env.STRAVA_ACCESS_TOKEN,
						refreshToken: this.env.STRAVA_REFRESH_TOKEN,
						clientId: this.env.STRAVA_CLIENT_ID,
						clientSecret: this.env.STRAVA_CLIENT_SECRET,
					});
					const activities = await strava.getRecentActivities(per_page);

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${activities.length} Strava activities.`,
							},
							{
								type: "text",
								text: JSON.stringify(activities, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"strava_star_segment",
			{
				segment_id: z
					.number()
					.int()
					.positive()
					.describe("The Strava segment ID to star or unstar."),
				starred: z
					.boolean()
					.describe("Set true to star the segment, false to unstar it."),
			},
			async ({ segment_id, starred }) => {
				try {
					const strava = new StravaClient({
						accessToken: this.env.STRAVA_ACCESS_TOKEN,
						refreshToken: this.env.STRAVA_REFRESH_TOKEN,
						clientId: this.env.STRAVA_CLIENT_ID,
						clientSecret: this.env.STRAVA_CLIENT_SECRET,
					});
					const segment = await strava.starSegment(segment_id, starred);

					return {
						content: [
							{
								type: "text",
								text: `${starred ? "Starred" : "Unstarred"} Strava segment ${segment_id}.`,
							},
							{
								type: "text",
								text: JSON.stringify(segment, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// CRONOMETER
		// ============================================

		this.server.tool(
			"cronometer_get_food_log",
			{
				date: z
					.string()
					.optional()
					.describe("Date to fetch as YYYY-MM-DD. Defaults to today."),
			},
			async ({ date }) => {
				try {
					if (date) {
						validateISO8601Date(date, "date");
					}
					const cronometer = this.createCronometerClient();
					const diary = await cronometer.getDiary(date);

					return {
						content: [
							{
								type: "text",
								text: `Retrieved Cronometer food log for ${date ?? "today"}.`,
							},
							{
								type: "text",
								text: JSON.stringify(diary, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_get_daily_nutrition",
			{
				date: z
					.string()
					.optional()
					.describe("Date to fetch as YYYY-MM-DD. Defaults to today."),
			},
			async ({ date }) => {
				try {
					if (date) {
						validateISO8601Date(date, "date");
					}
					const cronometer = this.createCronometerClient();
					const nutrition = await cronometer.getDailyNutrition(date);

					return {
						content: [
							{
								type: "text",
								text: `Retrieved Cronometer daily nutrition for ${date ?? "today"}.`,
							},
							{
								type: "text",
								text: JSON.stringify(nutrition, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_get_nutrition_scores",
			{
				date: z
					.string()
					.optional()
					.describe("Date to fetch as YYYY-MM-DD. Defaults to today."),
			},
			async ({ date }) => {
				try {
					if (date) validateISO8601Date(date, "date");
					const cronometer = this.createCronometerClient();
					const scores = await cronometer.getNutritionScores(date);
					return {
						content: [
							{ type: "text", text: `Retrieved Cronometer nutrition scores for ${date ?? "today"}.` },
							{ type: "text", text: JSON.stringify(scores, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_search_foods",
			{
				query: z.string().min(1).describe("Food name or keyword to search."),
			},
			async ({ query }) => {
				try {
					const cronometer = this.createCronometerClient();
					const foods = await cronometer.searchFood(query);
					const results = foods.map((food) => {
						const item = food as Record<string, unknown>;
						return {
							food_id: item.id,
							name: item.name,
							source: item.source,
							measure_id: item.measureId,
							translation_id: item.translationId,
							measure_display: item.measureDisplayName,
							score: item.score,
						};
					});
					return {
						content: [
							{ type: "text", text: `Found ${results.length} Cronometer foods for "${query}".` },
							{ type: "text", text: JSON.stringify(results, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_get_food_details",
			{
				food_id: z.number().int().positive().describe("Food ID from cronometer_search_foods."),
			},
			async ({ food_id }) => {
				try {
					const cronometer = this.createCronometerClient();
					const food = await cronometer.getFood(food_id) as Record<string, unknown>;
					const measures = Array.isArray(food.measures)
						? food.measures.map((measure) => {
								const item = measure as Record<string, unknown>;
								return {
									measure_id: item.id,
									name: item.name,
									grams: item.value,
								};
							})
						: [];
					return {
						content: [
							{ type: "text", text: `Retrieved Cronometer food details for ${food_id}.` },
							{
								type: "text",
								text: JSON.stringify(
									{
										food_id: food.id,
										name: food.name,
										default_measure_id: food.defaultMeasureId,
										measures,
										nutrients: food.nutrients ?? [],
									},
									null,
									2,
								),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_add_food_entry",
			{
				food_id: z.number().int().positive().describe("Cronometer food ID."),
				measure_id: z.number().int().optional().describe("Measure ID from search/details."),
				grams: z.number().positive().describe("Serving weight in grams."),
				date: z.string().optional().describe("Date as YYYY-MM-DD. Defaults to today."),
				translation_id: z.number().int().optional().default(0),
				diary_group: z
					.enum(["auto", "breakfast", "lunch", "dinner", "snacks"])
					.optional()
					.default("auto")
					.describe("Meal slot."),
			},
			async ({ food_id, measure_id, grams, date, translation_id, diary_group }) => {
				try {
					if (date) validateISO8601Date(date, "date");
					const groupMap: Record<string, number> = {
						auto: 0,
						breakfast: 1,
						lunch: 2,
						dinner: 3,
						snacks: 4,
					};
					const cronometer = this.createCronometerClient();
					const entry = await cronometer.addServing({
						foodId: food_id,
						measureId: measure_id,
						grams,
						date,
						translationId: translation_id,
						diaryGroup: groupMap[diary_group],
					});
					return {
						content: [
							{ type: "text", text: `Added Cronometer food entry for ${date ?? "today"}.` },
							{ type: "text", text: JSON.stringify(entry, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_remove_food_entry",
			{
				entry_ids: z.array(z.string()).min(1).describe("Serving/entry IDs from cronometer_get_food_log."),
				date: z.string().optional().describe("Date as YYYY-MM-DD. Defaults to today."),
			},
			async ({ entry_ids, date }) => {
				try {
					if (date) validateISO8601Date(date, "date");
					const cronometer = this.createCronometerClient();
					const result = await cronometer.deleteEntries(entry_ids, date);
					return {
						content: [
							{ type: "text", text: `Removed Cronometer food entries for ${date ?? "today"}.` },
							{ type: "text", text: JSON.stringify(result, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_mark_day_complete",
			{
				date: z.string().describe("Date as YYYY-MM-DD."),
				complete: z.boolean().optional().default(true),
			},
			async ({ date, complete }) => {
				try {
					validateISO8601Date(date, "date");
					const cronometer = this.createCronometerClient();
					const result = await cronometer.markDayComplete(date, complete);
					return {
						content: [
							{ type: "text", text: `Marked Cronometer day ${date} as ${complete ? "complete" : "incomplete"}.` },
							{ type: "text", text: JSON.stringify(result, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_copy_day",
			{
				date: z.string().optional().describe("Destination date as YYYY-MM-DD. Defaults to today."),
			},
			async ({ date }) => {
				try {
					if (date) validateISO8601Date(date, "date");
					const cronometer = this.createCronometerClient();
					const result = await cronometer.copyDay(date);
					return {
						content: [
							{ type: "text", text: `Copied previous Cronometer day into ${date ?? "today"}.` },
							{ type: "text", text: JSON.stringify(result, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_add_custom_food",
			{
				name: z.string().min(1),
				calories: z.number().min(0),
				protein_g: z.number().min(0),
				fat_g: z.number().min(0),
				carbs_g: z.number().min(0),
				fiber_g: z.number().min(0).optional().default(0),
				sugar_g: z.number().min(0).optional().default(0),
				sodium_mg: z.number().min(0).optional().default(0),
				serving_name: z.string().optional().default("1 serving"),
				serving_grams: z.number().positive().optional().default(100),
			},
			async (args) => {
				try {
					const cronometer = this.createCronometerClient();
					const created = await cronometer.createCustomFood({
						name: args.name,
						calories: args.calories,
						proteinG: args.protein_g,
						fatG: args.fat_g,
						carbsG: args.carbs_g,
						fiberG: args.fiber_g,
						sugarG: args.sugar_g,
						sodiumMg: args.sodium_mg,
						servingName: args.serving_name,
						servingGrams: args.serving_grams,
					});
					return {
						content: [
							{ type: "text", text: `Created custom Cronometer food: ${args.name}.` },
							{ type: "text", text: JSON.stringify(created, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_get_macro_targets",
			{},
			async () => {
				try {
					const cronometer = this.createCronometerClient();
					const targets = await cronometer.getMacroTargets();
					return {
						content: [
							{ type: "text", text: "Retrieved Cronometer macro targets." },
							{ type: "text", text: JSON.stringify(targets, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_get_fasting_history",
			{
				start_date: z.string().optional().describe("Start date as YYYY-MM-DD. Defaults to 30 days ago."),
				end_date: z.string().optional().describe("End date as YYYY-MM-DD. Defaults to today."),
			},
			async ({ start_date, end_date }) => {
				try {
					if (start_date) validateISO8601Date(start_date, "start_date");
					if (end_date) validateISO8601Date(end_date, "end_date");
					const cronometer = this.createCronometerClient();
					const history = await cronometer.getFastingHistory(start_date, end_date);
					return {
						content: [
							{ type: "text", text: "Retrieved Cronometer fasting history." },
							{ type: "text", text: JSON.stringify(history, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"cronometer_get_fasting_stats",
			{},
			async () => {
				try {
					const cronometer = this.createCronometerClient();
					const stats = await cronometer.getFastingStats();
					return {
						content: [
							{ type: "text", text: "Retrieved Cronometer fasting stats." },
							{ type: "text", text: JSON.stringify(stats, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// INTERVALS.ICU
		// ============================================

		this.server.tool(
			"intervals_get_athlete",
			{},
			async () => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const athlete = await intervals.getAthlete() as Record<string, unknown>;
					const sportSettings = Array.isArray(athlete.sportSettings)
						? athlete.sportSettings.map((sport) => {
								const item = sport as Record<string, unknown>;
								return {
									types: item.types,
									ftp: item.ftp,
									lthr: item.lthr,
									max_hr: item.max_hr,
									threshold_pace: item.threshold_pace,
									pace_units: item.pace_units,
								};
							})
						: [];
					const safeAthlete = {
						id: athlete.id,
						name: athlete.name,
						measurement_preference: athlete.measurement_preference,
						timezone: athlete.timezone,
						sex: athlete.sex,
						weight: athlete.icu_weight ?? athlete.weight,
						resting_hr: athlete.icu_resting_hr,
						fitness: {
							ctl: athlete.ctl,
							atl: athlete.atl,
							tsb: athlete.tsb,
							ramp_rate: athlete.ramp_rate,
						},
						sport_settings: sportSettings,
					};

					return {
						content: [
							{
								type: "text",
								text: "Retrieved Intervals.icu athlete profile summary.",
							},
							{
								type: "text",
								text: JSON.stringify(safeAthlete, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_get_recent_activities",
			{
				oldest: z
					.string()
					.optional()
					.describe("Oldest activity date/time, ISO-8601 format."),
				newest: z
					.string()
					.optional()
					.describe("Newest activity date/time, ISO-8601 format."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.default(30)
					.describe("Maximum number of activities to return."),
			},
			async ({ oldest, newest, limit }) => {
				try {
					if (oldest) {
						validateISO8601Date(oldest, "oldest");
					}
					if (newest) {
						validateISO8601Date(newest, "newest");
					}
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const activities = await intervals.getRecentActivities({
						oldest,
						newest,
						limit,
					});

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${activities.length} Intervals.icu activities.`,
							},
							{
								type: "text",
								text: JSON.stringify(activities, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_get_wellness",
			{
				oldest: z
					.string()
					.optional()
					.describe("Oldest wellness date, ISO-8601 format."),
				newest: z
					.string()
					.optional()
					.describe("Newest wellness date, ISO-8601 format."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.default(30)
					.describe("Maximum number of wellness records to return."),
			},
			async ({ oldest, newest, limit }) => {
				try {
					if (oldest) {
						validateISO8601Date(oldest, "oldest");
					}
					if (newest) {
						validateISO8601Date(newest, "newest");
					}
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const wellness = await intervals.getWellness({ oldest, newest, limit });

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${wellness.length} Intervals.icu wellness records.`,
							},
							{
								type: "text",
								text: JSON.stringify(wellness, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_update_activity",
			{
				activity_id: z.string().min(1),
				data: JsonObjectSchema.describe("Intervals.icu activity fields to update."),
			},
			async ({ activity_id, data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.updateActivity(activity_id, data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_delete_activity",
			{ activity_id: z.string().min(1) },
			async ({ activity_id }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.deleteActivity(activity_id);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_update_wellness",
			{
				date: z.string().optional().describe("Date as YYYY-MM-DD. If omitted, data must include id."),
				data: JsonObjectSchema.describe("Intervals.icu wellness fields to update."),
			},
			async ({ date, data }) => {
				try {
					if (date) validateISO8601Date(date, "date");
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.updateWellness(data, date);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_create_event",
			{
				start_date: z.string().describe("Date as YYYY-MM-DD."),
				name: z.string().min(1),
				category: z.enum(["WORKOUT", "NOTE", "RACE", "GOAL"]),
				description: z.string().optional(),
				event_type: z.string().optional().describe("Activity type, such as Ride, Run, Swim."),
				duration_seconds: z.number().int().positive().optional(),
				distance_meters: z.number().positive().optional(),
				training_load: z.number().int().positive().optional(),
			},
			async (args) => {
				try {
					validateISO8601Date(args.start_date, "start_date");
					const eventData: Record<string, unknown> = {
						start_date_local: args.start_date,
						name: args.name,
						category: args.category,
					};
					if (args.description) eventData.description = args.description;
					if (args.event_type) eventData.type = args.event_type;
					if (args.duration_seconds) eventData.moving_time = args.duration_seconds;
					if (args.distance_meters) eventData.distance = args.distance_meters;
					if (args.training_load) eventData.icu_training_load = args.training_load;
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.createEvent(eventData);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_update_event",
			{
				event_id: z.number().int().positive(),
				data: JsonObjectSchema.describe("Intervals.icu event fields to update."),
			},
			async ({ event_id, data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.updateEvent(event_id, data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_delete_event",
			{ event_id: z.number().int().positive() },
			async ({ event_id }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.deleteEvent(event_id);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_bulk_create_events",
			{ events: z.array(JsonObjectSchema).min(1) },
			async ({ events }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.bulkCreateEvents(events);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_bulk_delete_events",
			{ event_ids: z.array(z.number().int().positive()).min(1) },
			async ({ event_ids }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.bulkDeleteEvents(event_ids);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_duplicate_event",
			{
				event_id: z.number().int().positive(),
				new_date: z.string().describe("New date as YYYY-MM-DD."),
			},
			async ({ event_id, new_date }) => {
				try {
					validateISO8601Date(new_date, "new_date");
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.duplicateEvent(event_id, new_date);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_create_gear",
			{ data: JsonObjectSchema.describe("Intervals.icu gear fields.") },
			async ({ data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.createGear(data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_update_gear",
			{
				gear_id: z.string().min(1),
				data: JsonObjectSchema.describe("Intervals.icu gear fields to update."),
			},
			async ({ gear_id, data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.updateGear(gear_id, data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_delete_gear",
			{ gear_id: z.string().min(1) },
			async ({ gear_id }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.deleteGear(gear_id);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_create_gear_reminder",
			{
				gear_id: z.string().min(1),
				data: JsonObjectSchema.describe("Intervals.icu gear reminder fields."),
			},
			async ({ gear_id, data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.createGearReminder(gear_id, data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_update_gear_reminder",
			{
				gear_id: z.string().min(1),
				reminder_id: z.number().int().positive(),
				data: JsonObjectSchema.describe("Intervals.icu gear reminder fields to update."),
			},
			async ({ gear_id, reminder_id, data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.updateGearReminder(gear_id, reminder_id, data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_create_sport_settings",
			{ data: JsonObjectSchema.describe("Intervals.icu sport settings fields.") },
			async ({ data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.createSportSettings(data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_update_sport_settings",
			{
				sport_id: z.number().int().positive(),
				data: JsonObjectSchema.describe("Intervals.icu sport settings fields to update."),
			},
			async ({ sport_id, data }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.updateSportSettings(sport_id, data);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_apply_sport_settings",
			{
				sport_id: z.number().int().positive(),
				oldest: z.string().optional().describe("Oldest date to apply from, YYYY-MM-DD."),
			},
			async ({ sport_id, oldest }) => {
				try {
					if (oldest) validateISO8601Date(oldest, "oldest");
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.applySportSettings(sport_id, oldest);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"intervals_delete_sport_settings",
			{ sport_id: z.number().int().positive() },
			async ({ sport_id }) => {
				try {
					const intervals = new IntervalsClient({
						apiKey: this.env.INTERVALS_ICU_API_KEY,
						athleteId: this.env.INTERVALS_ICU_ATHLETE_ID,
					});
					const result = await intervals.deleteSportSettings(sport_id);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// FITBIT
		// ============================================

		this.server.tool("fitbit_get_profile", {}, async () => {
			try {
				const fitbit = this.createFitbitClient();
				const profile = await fitbit.getProfile();
				return {
					content: [
						{ type: "text", text: "Retrieved Fitbit profile." },
						{ type: "text", text: JSON.stringify(profile, null, 2) },
					],
				};
			} catch (error) {
				return handleError(error);
			}
		});

		this.server.tool(
			"fitbit_get_activity_summary",
			{
				date: z.string().optional().default("today").describe("Date as YYYY-MM-DD, or 'today'."),
			},
			async ({ date }) => {
				try {
					if (date !== "today") validateISO8601Date(date, "date");
					const fitbit = this.createFitbitClient();
					const activity = await fitbit.getActivitySummary(date);
					return {
						content: [
							{ type: "text", text: `Retrieved Fitbit activity summary for ${date}.` },
							{ type: "text", text: JSON.stringify(activity, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"fitbit_get_sleep",
			{
				date: z.string().optional().default("today").describe("Date as YYYY-MM-DD, or 'today'."),
			},
			async ({ date }) => {
				try {
					if (date !== "today") validateISO8601Date(date, "date");
					const fitbit = this.createFitbitClient();
					const sleep = await fitbit.getSleep(date);
					return {
						content: [
							{ type: "text", text: `Retrieved Fitbit sleep for ${date}.` },
							{ type: "text", text: JSON.stringify(sleep, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"fitbit_get_body_weight",
			{
				date: z.string().optional().default("today").describe("Date as YYYY-MM-DD, or 'today'."),
			},
			async ({ date }) => {
				try {
					if (date !== "today") validateISO8601Date(date, "date");
					const fitbit = this.createFitbitClient();
					const weight = await fitbit.getBodyWeight(date);
					return {
						content: [
							{ type: "text", text: `Retrieved Fitbit body weight for ${date}.` },
							{ type: "text", text: JSON.stringify(weight, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"fitbit_get_heart_rate",
			{
				date: z.string().optional().default("today").describe("Date as YYYY-MM-DD, or 'today'."),
				period: z.enum(["1d", "7d", "30d", "1w", "1m"]).optional().default("1d"),
			},
			async ({ date, period }) => {
				try {
					if (date !== "today") validateISO8601Date(date, "date");
					const fitbit = this.createFitbitClient();
					const heart = await fitbit.getHeartRate(date, period);
					return {
						content: [
							{ type: "text", text: `Retrieved Fitbit heart rate for ${date}/${period}.` },
							{ type: "text", text: JSON.stringify(heart, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// GOOGLE FIT
		// ============================================

		const GoogleFitRangeSchema = {
			start_date: z.string().describe("Start date as YYYY-MM-DD."),
			end_date: z.string().describe("End date as YYYY-MM-DD."),
		};

		const toMillis = (date: string, endOfDay = false) => {
			validateISO8601Date(date, "date");
			return Date.parse(`${date}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
		};

		this.server.tool("google_fit_list_data_sources", {}, async () => {
			try {
				const googleFit = this.createGoogleFitClient();
				const sources = await googleFit.listDataSources();
				return {
					content: [
						{ type: "text", text: "Retrieved Google Fit data sources." },
						{ type: "text", text: JSON.stringify(sources, null, 2) },
					],
				};
			} catch (error) {
				return handleError(error);
			}
		});

		this.server.tool(
			"google_fit_get_activity_summary",
			GoogleFitRangeSchema,
			async ({ start_date, end_date }) => {
				try {
					const googleFit = this.createGoogleFitClient();
					const summary = await googleFit.aggregate({
						startTimeMillis: toMillis(start_date),
						endTimeMillis: toMillis(end_date, true),
						dataTypeNames: [
							"com.google.step_count.delta",
							"com.google.calories.expended",
							"com.google.distance.delta",
							"com.google.activity.segment",
						],
					});
					return {
						content: [
							{ type: "text", text: `Retrieved Google Fit activity summary from ${start_date} to ${end_date}.` },
							{ type: "text", text: JSON.stringify(summary, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"google_fit_get_body_summary",
			GoogleFitRangeSchema,
			async ({ start_date, end_date }) => {
				try {
					const googleFit = this.createGoogleFitClient();
					const summary = await googleFit.aggregate({
						startTimeMillis: toMillis(start_date),
						endTimeMillis: toMillis(end_date, true),
						dataTypeNames: [
							"com.google.weight",
							"com.google.body.fat.percentage",
						],
					});
					return {
						content: [
							{ type: "text", text: `Retrieved Google Fit body summary from ${start_date} to ${end_date}.` },
							{ type: "text", text: JSON.stringify(summary, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"google_fit_get_heart_summary",
			GoogleFitRangeSchema,
			async ({ start_date, end_date }) => {
				try {
					const googleFit = this.createGoogleFitClient();
					const summary = await googleFit.aggregate({
						startTimeMillis: toMillis(start_date),
						endTimeMillis: toMillis(end_date, true),
						dataTypeNames: [
							"com.google.heart_rate.bpm",
							"com.google.heart_minutes",
						],
					});
					return {
						content: [
							{ type: "text", text: `Retrieved Google Fit heart summary from ${start_date} to ${end_date}.` },
							{ type: "text", text: JSON.stringify(summary, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		this.server.tool(
			"google_fit_get_sleep_summary",
			GoogleFitRangeSchema,
			async ({ start_date, end_date }) => {
				try {
					const googleFit = this.createGoogleFitClient();
					const summary = await googleFit.aggregate({
						startTimeMillis: toMillis(start_date),
						endTimeMillis: toMillis(end_date, true),
						dataTypeNames: ["com.google.sleep.segment"],
					});
					return {
						content: [
							{ type: "text", text: `Retrieved Google Fit sleep summary from ${start_date} to ${end_date}.` },
							{ type: "text", text: JSON.stringify(summary, null, 2) },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WORKOUTS
		// ============================================

		this.server.tool(
			"get_workouts",
			{
				page: z.number().optional().describe("Page number (Must be 1 or greater)").default(1),
				page_size: z.number().optional().describe("Number of items per page (Max 10)").default(10),
			},
			async ({ page, page_size }) => {
				try {
					// Validate pagination parameters
					validatePagination(page, page_size, PAGINATION_LIMITS.WORKOUTS);

					const workouts = await this.getHevyClient().getWorkouts({ page, pageSize: page_size });

					const workoutDetails = workouts.workouts?.map((workout: any, index: number) => {
						return `Workout ${index + 1}: ${workout.title || 'Untitled'}\n  ID: ${workout.id}\n  Date: ${workout.start_time}`;
					}).join('\n') || 'No workouts found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${workouts.workouts?.length || 0} workouts (page ${workouts.page} of ${workouts.page_count})`,
							},
							{
								type: "text",
								text: workoutDetails,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(workouts.workouts, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_workout",
			{
				workout_id: z.string().describe("The ID of the workout to retrieve"),
			},
			async ({ workout_id }) => {
				try {
					const workout = await this.getHevyClient().getWorkout(workout_id);

					return {
						content: [
							{
								type: "text",
								text: `Workout: ${workout.title || 'Untitled'}\nID: ${workout.id}\nExercises: ${workout.exercises?.length || 0}`,
							},
							{
								type: "text",
								text: JSON.stringify(workout, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_workout",
			CreateWorkoutSchema.shape,
			async (args) => {
				try {
					// Validate workout data including dates, exercises, and RPE values
					validateWorkoutData(args);

					const workout = await this.getHevyClient().createWorkout(transformWorkoutToAPI(args));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully logged workout: ${workout.title}`,
							},
							{
								type: "text",
								text: `Workout ID: ${workout.id}\nExercises: ${workout.exercises?.length || 0}\nStarted: ${args.start_time}`,
							},
							{
								type: "text",
								text: `\n\nWorkout data:\n${JSON.stringify(workout, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"update_workout",
			{
				workout_id: z.string().describe("The ID of the workout to update"),
				...UpdateWorkoutSchema.shape,
			},
			async (args) => {
				try {
					const { workout_id, ...workoutData } = args;

					// Validate workout data including dates, exercises, and RPE values
					validateWorkoutData(workoutData);

					const workout = await this.getHevyClient().updateWorkout(workout_id, transformWorkoutToAPI(workoutData));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully updated workout: ${workout.title}`,
							},
							{
								type: "text",
								text: `Workout ID: ${workout.id}\nExercises: ${workout.exercises?.length || 0}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_workouts_count",
			{},
			async () => {
				try {
					const result = await this.getHevyClient().getWorkoutsCount();

					return {
						content: [
							{
								type: "text",
								text: `Total workouts: ${result.workout_count}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_workout_events",
			{
				page: z.number().optional().describe("Page number (Must be 1 or greater)").default(1),
				page_size: z.number().optional().describe("Number of items per page (Max 10)").default(5),
				since: z.string().optional().describe("Get events since this date (ISO 8601 format, e.g., 2024-01-01T00:00:00Z)"),
			},
			async (args) => {
				try {
					// Validate pagination parameters
					validatePagination(args.page, args.page_size, PAGINATION_LIMITS.WORKOUT_EVENTS);

					// Validate date format if provided
					if (args.since) {
						validateISO8601Date(args.since, "since");
					}

					const params: any = { page: args.page, pageSize: args.page_size };
					if (args.since) params.since = args.since;

					const events = await this.getHevyClient().getWorkoutEvents(params);

					const eventDetails = events.events?.map((event: any, index: number) => {
						if (event.type === 'deleted') {
							return `${index + 1}. DELETED - Workout ID: ${event.id}\n   Deleted at: ${event.deleted_at}`;
						} else {
							return `${index + 1}. UPDATED - ${event.workout?.title || 'Untitled'}\n   Workout ID: ${event.workout?.id}\n   Updated: ${event.workout?.updated_at}`;
						}
					}).join('\n') || 'No events found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${events.events?.length || 0} workout events (page ${events.page} of ${events.page_count})`,
							},
							{
								type: "text",
								text: eventDetails,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		// ============================================
		// ROUTINES
		// ============================================

		this.server.tool(
			"get_routines",
			{
				page: z.number().optional().describe("Page number (Must be 1 or greater)").default(1),
				page_size: z.number().optional().describe("Number of items per page (Max 10)").default(5),
			},
			async ({ page, page_size }) => {
				try {
					// Validate pagination parameters
					validatePagination(page, page_size, PAGINATION_LIMITS.ROUTINES);

					const routines = await this.getHevyClient().getRoutines({ page, pageSize: page_size });

					const routineDetails = routines.routines?.map((routine: any, index: number) => {
						const exerciseCount = routine.exercises?.length || 0;
						return `Routine ${index + 1}: ${routine.title}\n  Exercises: ${exerciseCount}\n  ID: ${routine.id}`;
					}).join('\n') || 'No routines found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${routines.routines?.length || 0} routines (page ${routines.page} of ${routines.page_count})`,
							},
							{
								type: "text",
								text: routineDetails,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(routines.routines, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_routine",
			{
				routine_id: z.string().describe("The ID of the routine to retrieve"),
			},
			async ({ routine_id }) => {
				try {
					const result = await this.getHevyClient().getRoutine(routine_id);
					const routine = result.routine;

					return {
						content: [
							{
								type: "text",
								text: `Routine: ${routine.title}\nID: ${routine.id}\nExercises: ${routine.exercises?.length || 0}`,
							},
							{
								type: "text",
								text: JSON.stringify(routine, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_routine",
			CreateRoutineSchema.shape,
			async (args) => {
				try {
					// Validate routine data including exercises and sets
					validateRoutineData(args);

					const routine = await this.getHevyClient().createRoutine(transformRoutineToAPI(args));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully created routine: ${routine.title}`,
							},
							{
								type: "text",
								text: `Routine ID: ${routine.id}\nExercises: ${routine.exercises?.length || 0}`,
							},
							{
								type: "text",
								text: `\n\nFull routine data:\n${JSON.stringify(routine, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"update_routine",
			{
				routine_id: z.string().describe("The ID of the routine to update"),
				...UpdateRoutineSchema.shape,
			},
			async (args) => {
				try {
					const { routine_id, ...routineData } = args;

					// Validate routine data including exercises and sets
					validateRoutineData(routineData);

					const routine = await this.getHevyClient().updateRoutine(routine_id, transformRoutineToAPI(routineData));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully updated routine: ${routine.title}`,
							},
							{
								type: "text",
								text: `Routine ID: ${routine.id}\nExercises: ${routine.exercises?.length || 0}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		// ============================================
		// EXERCISE TEMPLATES
		// ============================================

		this.server.tool(
			"get_exercise_templates",
			{
				page: z.number().optional().describe("Page number (Must be 1 or greater)").default(1),
				page_size: z.number().optional().describe("Number of items per page (Max 100)").default(20),
			},
			async ({ page, page_size }) => {
				try {
					// Validate pagination parameters with higher limit for templates
					validatePagination(page, page_size, PAGINATION_LIMITS.EXERCISE_TEMPLATES);

					const templates = await this.getHevyClient().getExerciseTemplates({ page, pageSize: page_size });

					const templateDetails = templates.exercise_templates?.map((template: any, index: number) => {
						return `${index + 1}. ${template.title} (${template.type})\n   ID: ${template.id}\n   Primary: ${template.primary_muscle_group}\n   Custom: ${template.is_custom ? 'Yes' : 'No'}`;
					}).join('\n') || 'No exercise templates found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${templates.exercise_templates?.length || 0} exercise templates (page ${templates.page} of ${templates.page_count})`,
							},
							{
								type: "text",
								text: templateDetails,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_exercise_template",
			{
				exercise_template_id: z.string().describe("The ID of the exercise template"),
			},
			async ({ exercise_template_id }) => {
				try {
					const template = await this.getHevyClient().getExerciseTemplate(exercise_template_id);

					return {
						content: [
							{
								type: "text",
								text: `Exercise: ${template.title}\nType: ${template.type}\nPrimary Muscle: ${template.primary_muscle_group}\nCustom: ${template.is_custom ? 'Yes' : 'No'}`,
							},
							{
								type: "text",
								text: JSON.stringify(template, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_exercise_template",
			CreateExerciseTemplateSchema.shape,
			async (args) => {
				try {
					// Validate exercise template data
					validateExerciseTemplate(args);

					const result = await this.getHevyClient().createExerciseTemplate(transformExerciseTemplateToAPI(args));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully created custom exercise template: ${args.title}`,
							},
							{
								type: "text",
								text: `Exercise Template ID: ${result.id}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_exercise_history",
			{
				exercise_template_id: z.string().describe("The ID of the exercise template"),
				start_date: z.string().optional().describe("Optional start date (ISO 8601 format, e.g., 2024-01-01T00:00:00Z)"),
				end_date: z.string().optional().describe("Optional end date (ISO 8601 format, e.g., 2024-12-31T23:59:59Z)"),
			},
			async (args) => {
				try {
					// Validate date formats if provided
					if (args.start_date) {
						validateISO8601Date(args.start_date, "start_date");
					}
					if (args.end_date) {
						validateISO8601Date(args.end_date, "end_date");
					}

					// Validate that end_date is after start_date if both are provided
					if (args.start_date && args.end_date) {
						const start = new Date(args.start_date);
						const end = new Date(args.end_date);
						if (end <= start) {
							throw new ValidationError("end_date must be after start_date");
						}
					}

					const params: any = {};
					if (args.start_date) params.start_date = args.start_date;
					if (args.end_date) params.end_date = args.end_date;

					const history = await this.getHevyClient().getExerciseHistory(args.exercise_template_id, params);

					const historyDetails = history.exercise_history?.map((entry: any, index: number) => {
						return `${index + 1}. ${entry.workout_title} (${entry.workout_start_time})\n   Weight: ${entry.weight_kg}kg, Reps: ${entry.reps}, RPE: ${entry.rpe || 'N/A'}\n   Set Type: ${entry.set_type}`;
					}).join('\n') || 'No exercise history found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${history.exercise_history?.length || 0} exercise history entries`,
							},
							{
								type: "text",
								text: historyDetails,
							},
							{
								type: "text",
								text: `\n\nFull data:\n${JSON.stringify(history.exercise_history, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		// ============================================
		// ROUTINE FOLDERS
		// ============================================

		this.server.tool(
			"get_routine_folders",
			{
				page: z.number().optional().describe("Page number (Must be 1 or greater)").default(1),
				page_size: z.number().optional().describe("Number of items per page (Max 10)").default(10),
			},
			async ({ page, page_size }) => {
				try {
					// Validate pagination parameters
					validatePagination(page, page_size, PAGINATION_LIMITS.ROUTINE_FOLDERS);

					const folders = await this.getHevyClient().getRoutineFolders({ page, pageSize: page_size });

					const folderDetails = folders.routine_folders?.map((folder: any, index: number) => {
						return `${index + 1}. ${folder.title}\n   ID: ${folder.id}\n   Index: ${folder.index}`;
					}).join('\n') || 'No routine folders found';

					return {
						content: [
							{
								type: "text",
								text: `Retrieved ${folders.routine_folders?.length || 0} routine folders (page ${folders.page} of ${folders.page_count})`,
							},
							{
								type: "text",
								text: folderDetails,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"get_routine_folder",
			{
				folder_id: z.string().describe("The ID of the routine folder"),
			},
			async ({ folder_id }) => {
				try {
					const folder = await this.getHevyClient().getRoutineFolder(folder_id);

					return {
						content: [
							{
								type: "text",
								text: `Folder: ${folder.title}\nID: ${folder.id}\nIndex: ${folder.index}`,
							},
							{
								type: "text",
								text: JSON.stringify(folder, null, 2),
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);

		this.server.tool(
			"create_routine_folder",
			CreateRoutineFolderSchema.shape,
			async (args) => {
				try {
					const folder = await this.getHevyClient().createRoutineFolder(transformRoutineFolderToAPI(args));

					return {
						content: [
							{
								type: "text",
								text: `✓ Successfully created routine folder: ${folder.title}`,
							},
							{
								type: "text",
								text: `Folder ID: ${folder.id}\nIndex: ${folder.index}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			}
		);
	}
}
