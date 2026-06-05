import type { Env } from "../app.js";
import type { Props } from "../utils.js";
import { CronometerClient, KvCronometerSessionCache } from "./cronometer-client.js";
import { FitbitClient } from "./fitbit-client.js";
import { GoogleFitClient } from "./google-fit-client.js";
import { IntervalsClient } from "./intervals-client.js";
import { HevyClient } from "./client.js";
import { getServiceConnection, ensureUser } from "./service-connections.js";
import type { ZorFitServiceId } from "./service-connections.js";
import { StravaClient } from "./strava-client.js";

export type HealthDataCategory =
	| "hrv"
	| "sleep"
	| "nutrition"
	| "steps"
	| "gym_workouts"
	| "fitness_activities"
	| "recovery";

export type DataProviderId =
	| ZorFitServiceId
	| "garmin"
	| "oura"
	| "whoop"
	| "manual";

export interface DataPreference {
	category: HealthDataCategory;
	provider: DataProviderId;
	fallbackProvider?: DataProviderId;
	enabled: boolean;
}

export interface CategoryContext {
	category: HealthDataCategory;
	provider: DataProviderId;
	status: "ready" | "missing" | "error" | "unsupported";
	data?: unknown;
	note?: string;
}

export interface HealthContextBundle {
	date: string;
	timezone: string;
	rangeDays: number;
	categories: CategoryContext[];
}

export const HEALTH_CATEGORIES: Array<{
	id: HealthDataCategory;
	label: string;
	description: string;
	providers: DataProviderId[];
}> = [
	{
		id: "hrv",
		label: "HRV",
		description: "Heart-rate variability and recovery signals.",
		providers: ["intervals_icu", "fitbit", "google_fit", "garmin", "oura", "whoop"],
	},
	{
		id: "sleep",
		label: "Sleep",
		description: "Sleep duration, quality, and nightly recovery context.",
		providers: ["fitbit", "google_fit", "intervals_icu", "garmin", "oura", "whoop"],
	},
	{
		id: "nutrition",
		label: "Nutrition",
		description: "Food log, macros, micronutrients, and targets.",
		providers: ["cronometer"],
	},
	{
		id: "steps",
		label: "Steps",
		description: "Daily movement and activity volume.",
		providers: ["fitbit", "google_fit", "garmin"],
	},
	{
		id: "gym_workouts",
		label: "Gym workouts",
		description: "Strength workouts, sets, reps, and routines.",
		providers: ["hevy"],
	},
	{
		id: "fitness_activities",
		label: "Other fitness activities",
		description: "Runs, rides, endurance sessions, and training load.",
		providers: ["strava", "intervals_icu", "fitbit", "garmin"],
	},
	{
		id: "recovery",
		label: "Recovery",
		description: "Combined recovery context from HRV, sleep, and load.",
		providers: ["intervals_icu", "fitbit", "garmin", "oura", "whoop"],
	},
];

export const PROVIDER_LABELS: Record<DataProviderId, string> = {
	hevy: "Hevy",
	strava: "Strava",
	cronometer: "Cronometer",
	intervals_icu: "Intervals.icu",
	fitbit: "Fitbit",
	google_fit: "Google Fit",
	garmin: "Garmin",
	oura: "Oura",
	whoop: "Whoop",
	manual: "Manual entry",
};

const CATEGORY_IDS = new Set(HEALTH_CATEGORIES.map((category) => category.id));

export function normalizeHealthCategories(value: unknown): HealthDataCategory[] {
	const source = Array.isArray(value) ? value : [];
	const normalized = source.filter((item): item is HealthDataCategory => {
		return typeof item === "string" && CATEGORY_IDS.has(item as HealthDataCategory);
	});
	const unique = Array.from(new Set(normalized));
	return unique.length ? unique : ["nutrition"];
}

export function defaultProviderForCategory(category: HealthDataCategory): DataProviderId {
	return HEALTH_CATEGORIES.find((item) => item.id === category)?.providers[0] ?? "manual";
}

function providerAllowed(category: HealthDataCategory, provider: DataProviderId): boolean {
	return HEALTH_CATEGORIES.find((item) => item.id === category)?.providers.includes(provider) ?? false;
}

function idFor(userId: string, category: HealthDataCategory): string {
	return `${userId}:${category}`;
}

function defaultRangeDaysForCategory(category: HealthDataCategory): number {
	if (category === "hrv" || category === "sleep" || category === "recovery")
		return 7;
	if (category === "fitness_activities" || category === "gym_workouts") return 14;
	return 1;
}

function rangeStartDate(date: string, rangeDays: number): string {
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	parsed.setUTCDate(parsed.getUTCDate() - Math.max(rangeDays - 1, 0));
	return parsed.toISOString().slice(0, 10);
}

export async function listDataPreferences(
	env: Pick<Env, "ZORFIT_DB" | "COOKIE_ENCRYPTION_KEY">,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<DataPreference[]> {
	const userId = await ensureUser(env, session);
	const { results } = await env.ZORFIT_DB.prepare(
		`SELECT category, provider, fallback_provider, enabled
		 FROM user_data_preferences
		 WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{
			category: HealthDataCategory;
			provider: DataProviderId;
			fallback_provider: DataProviderId | null;
			enabled: number;
		}>();
	const saved = new Map((results ?? []).map((row) => [row.category, row]));
	return HEALTH_CATEGORIES.map((category) => {
		const row = saved.get(category.id);
		return {
			category: category.id,
			provider: row?.provider ?? defaultProviderForCategory(category.id),
			fallbackProvider: row?.fallback_provider ?? undefined,
			enabled: row ? row.enabled === 1 : true,
		};
	});
}

export async function upsertDataPreferences(
	env: Pick<Env, "ZORFIT_DB" | "COOKIE_ENCRYPTION_KEY">,
	session: Pick<Props, "login" | "name" | "email">,
	preferences: DataPreference[],
): Promise<void> {
	const userId = await ensureUser(env, session);
	const now = new Date().toISOString();
	for (const preference of preferences) {
		if (!CATEGORY_IDS.has(preference.category)) continue;
		const provider = providerAllowed(preference.category, preference.provider)
			? preference.provider
			: defaultProviderForCategory(preference.category);
		const fallback =
			preference.fallbackProvider && providerAllowed(preference.category, preference.fallbackProvider)
				? preference.fallbackProvider
				: null;
		await env.ZORFIT_DB.prepare(
			`INSERT INTO user_data_preferences
			   (id, user_id, category, provider, fallback_provider, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, category) DO UPDATE SET
			   provider = excluded.provider,
			   fallback_provider = excluded.fallback_provider,
			   enabled = excluded.enabled,
			   updated_at = excluded.updated_at`,
		)
			.bind(
				idFor(userId, preference.category),
				userId,
				preference.category,
				provider,
				fallback,
				preference.enabled ? 1 : 0,
				now,
				now,
			)
			.run();
	}
}

export function questionBankForCategories(categories: HealthDataCategory[]): string[] {
	const selected = new Set(categories);
	const questions = new Set<string>();
	const add = (items: string[]) => items.forEach((item) => questions.add(item));
	if (selected.has("hrv") && selected.has("sleep")) {
		add([
			"Why is my HRV lower today, and is sleep the likely reason?",
			"Should I train hard today based on sleep and HRV?",
			"What changed in recovery compared with my normal pattern?",
		]);
	}
	if (selected.has("nutrition") && selected.has("gym_workouts")) {
		add([
			"Did I eat enough protein for strength training?",
			"What should I eat for the rest of the day after my workout?",
			"Am I under-fueling my gym sessions?",
		]);
	}
	if (selected.has("hrv") && selected.has("fitness_activities")) {
		add([
			"Did training load affect my recovery?",
			"Was yesterday's workout too intense for my current recovery?",
			"Should I do intensity, zone 2, or rest today?",
		]);
	}
	if (selected.has("nutrition")) {
		add([
			"Summarize my nutrition and the top three fixes for today.",
			"What nutrients look low or high today?",
			"What is the best next meal based on what I already ate?",
		]);
	}
	if (selected.has("steps") || selected.has("fitness_activities")) {
		add([
			"Am I moving enough today compared with my recent pattern?",
			"What activity would be most useful for the rest of the day?",
		]);
	}
	if (questions.size === 0) {
		add([
			"What should I focus on today?",
			"What changed in my health data?",
			"Give me a practical summary and next action.",
		]);
	}
	return Array.from(questions).slice(0, 8);
}

async function serviceCredentials<T extends Record<string, string>>(
	env: Env,
	session: Pick<Props, "login" | "name" | "email">,
	serviceId: ZorFitServiceId,
): Promise<T | null> {
	return (await getServiceConnection<T>(env, session, serviceId))?.credentials ?? null;
}

async function collectCategoryData(
	env: Env,
	session: Pick<Props, "login" | "name" | "email">,
	category: HealthDataCategory,
	provider: DataProviderId,
	timezone: string,
	date: string,
	rangeDays: number,
): Promise<CategoryContext> {
	try {
		if (category === "nutrition" && provider === "cronometer") {
			const credentials = await serviceCredentials<Record<string, string>>(env, session, "cronometer");
			const username = credentials?.username || env.CRONOMETER_USERNAME;
			const password = credentials?.password || env.CRONOMETER_PASSWORD;
			if (!username || !password) {
				return { category, provider, status: "missing", note: "Cronometer credentials are not connected." };
			}
			const client = new CronometerClient({
				username,
				password,
				timezone,
				sessionCache: new KvCronometerSessionCache(env.OAUTH_KV),
			});
			if (rangeDays > 1) {
				const oldest = rangeStartDate(date, rangeDays);
				const start = new Date(`${oldest}T00:00:00Z`);
				const days = await Promise.all(
					Array.from({ length: rangeDays }, async (_, index) => {
						const day = new Date(start);
						day.setUTCDate(start.getUTCDate() + index);
						const dayString = day.toISOString().slice(0, 10);
						return client.getDailyNutrition(dayString).catch((error) => ({
							date: dayString,
							status: "error",
							note: error instanceof Error ? error.message : String(error),
						}));
					}),
				);
				return { category, provider, status: "ready", data: { date, days, today: days[days.length - 1] } };
			}
			return { category, provider, status: "ready", data: await client.getDailyNutrition(date) };
		}
		if (category === "gym_workouts" && provider === "hevy") {
			const credentials = await serviceCredentials<Record<string, string>>(env, session, "hevy");
			const apiKey = credentials?.apiKey || env.HEVY_API_KEY;
			if (!apiKey) return { category, provider, status: "missing", note: "Hevy API key is not connected." };
			const client = new HevyClient({ apiKey });
			return { category, provider, status: "ready", data: await client.getWorkouts({ pageSize: 10 }) };
		}
		if (category === "fitness_activities" && provider === "strava") {
			const credentials = await serviceCredentials<Record<string, string>>(env, session, "strava");
			const client = new StravaClient({
				accessToken: credentials?.accessToken || env.STRAVA_ACCESS_TOKEN,
				refreshToken: credentials?.refreshToken || env.STRAVA_REFRESH_TOKEN,
				clientId: credentials?.clientId || env.STRAVA_CLIENT_ID,
				clientSecret: credentials?.clientSecret || env.STRAVA_CLIENT_SECRET,
			});
			return { category, provider, status: "ready", data: await client.getRecentActivities(20) };
		}
		if (
			(provider === "intervals_icu" && (category === "fitness_activities" || category === "hrv" || category === "sleep" || category === "recovery"))
		) {
			const credentials = await serviceCredentials<Record<string, string>>(env, session, "intervals_icu");
			const client = new IntervalsClient({
				apiKey: credentials?.apiKey || env.INTERVALS_ICU_API_KEY,
				athleteId: credentials?.athleteId || env.INTERVALS_ICU_ATHLETE_ID,
			});
			const data =
				category === "fitness_activities"
					? await client.getRecentActivities({
							oldest: rangeStartDate(date, rangeDays),
							newest: date,
							limit: Math.max(rangeDays, 20),
						})
					: await client.getWellness({
							oldest: rangeStartDate(date, rangeDays),
							newest: date,
							limit: Math.max(rangeDays, 7),
						});
			return { category, provider, status: "ready", data };
		}
		if (provider === "fitbit" && (category === "sleep" || category === "steps" || category === "hrv" || category === "recovery" || category === "fitness_activities")) {
			const credentials = await serviceCredentials<Record<string, string>>(env, session, "fitbit");
			const client = new FitbitClient({
				accessToken: credentials?.accessToken || env.FITBIT_ACCESS_TOKEN,
				refreshToken: credentials?.refreshToken || env.FITBIT_REFRESH_TOKEN,
				clientId: credentials?.clientId || env.FITBIT_CLIENT_ID,
				clientSecret: credentials?.clientSecret || env.FITBIT_CLIENT_SECRET,
			});
			const data =
				category === "sleep"
					? await Promise.all(
							Array.from({ length: rangeDays }, (_, index) =>
								client.getSleep(rangeStartDate(date, rangeDays - index)).catch((error) => ({
									status: "error",
									note: error instanceof Error ? error.message : String(error),
								})),
							),
						)
					: category === "hrv" || category === "recovery"
						? await Promise.all(
								Array.from({ length: rangeDays }, (_, index) =>
									client
										.getHeartRate(rangeStartDate(date, rangeDays - index))
										.catch((error) => ({
											status: "error",
											note: error instanceof Error ? error.message : String(error),
										})),
								),
							)
						: await client.getActivitySummary(date);
			return { category, provider, status: "ready", data };
		}
		if (provider === "google_fit" && (category === "steps" || category === "sleep" || category === "hrv")) {
			const credentials = await serviceCredentials<Record<string, string>>(env, session, "google_fit");
			const start = new Date(`${rangeStartDate(date, rangeDays)}T00:00:00Z`).getTime();
			const end = new Date(`${date}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000;
			const typeMap: Record<HealthDataCategory, string[]> = {
				steps: ["com.google.step_count.delta"],
				sleep: ["com.google.sleep.segment"],
				hrv: ["com.google.heart_rate.bpm"],
				nutrition: [],
				gym_workouts: [],
				fitness_activities: [],
				recovery: [],
			};
			const client = new GoogleFitClient({
				accessToken: credentials?.accessToken || env.GOOGLE_FIT_ACCESS_TOKEN,
				refreshToken: credentials?.refreshToken || env.GOOGLE_FIT_REFRESH_TOKEN,
				clientId: credentials?.clientId || env.GOOGLE_FIT_CLIENT_ID,
				clientSecret: credentials?.clientSecret || env.GOOGLE_FIT_CLIENT_SECRET,
			});
			return {
				category,
				provider,
				status: "ready",
				data: await client.aggregate({
					startTimeMillis: start,
					endTimeMillis: end,
					dataTypeNames: typeMap[category],
				}),
			};
		}
		return {
			category,
			provider,
			status: "unsupported",
			note: `${PROVIDER_LABELS[provider]} is selectable for planning, but this category adapter is not active yet.`,
		};
	} catch (error) {
		return {
			category,
			provider,
			status: "error",
			note: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function collectHealthContext(
	env: Env,
	session: Pick<Props, "login" | "name" | "email">,
	args: {
		categories: HealthDataCategory[];
		timezone: string;
		date: string;
		rangeDays?: number;
	},
): Promise<HealthContextBundle> {
	const preferences = await listDataPreferences(env, session);
	const preferenceMap = new Map(preferences.map((item) => [item.category, item]));
	const categories = normalizeHealthCategories(args.categories);
	const contexts = await Promise.all(
		categories.map((category) => {
			const preference = preferenceMap.get(category);
			const provider = preference?.enabled
				? preference.provider
				: defaultProviderForCategory(category);
			return collectCategoryData(
				env,
				session,
				category,
				provider,
				args.timezone,
				args.date,
				args.rangeDays ?? defaultRangeDaysForCategory(category),
			);
		}),
	);
	return {
		date: args.date,
		timezone: args.timezone,
		rangeDays: Math.max(
			...categories.map((category) => args.rangeDays ?? defaultRangeDaysForCategory(category)),
		),
		categories: contexts,
	};
}
