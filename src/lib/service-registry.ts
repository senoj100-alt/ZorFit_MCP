import type { Props } from "../utils.js";
import {
	type ZorFitServiceId,
	listServiceConnections,
} from "./service-connections.js";

export interface ZorFitServiceStatus {
	id: ZorFitServiceId;
	label: string;
	configured: boolean;
	auth: "api_key" | "oauth" | "username_password";
	source: "user_d1" | "worker_secret" | "missing";
	notes: string;
}

export interface ZorFitServiceEnv {
	ZORFIT_DB: D1Database;
	COOKIE_ENCRYPTION_KEY: string;
	HEVY_API_KEY?: string;
	STRAVA_ACCESS_TOKEN?: string;
	STRAVA_REFRESH_TOKEN?: string;
	STRAVA_CLIENT_ID?: string;
	STRAVA_CLIENT_SECRET?: string;
	CRONOMETER_USERNAME?: string;
	CRONOMETER_PASSWORD?: string;
	INTERVALS_ICU_API_KEY?: string;
	INTERVALS_ICU_ATHLETE_ID?: string;
	FITBIT_CLIENT_ID?: string;
	FITBIT_CLIENT_SECRET?: string;
	FITBIT_ACCESS_TOKEN?: string;
	FITBIT_REFRESH_TOKEN?: string;
	GOOGLE_FIT_CLIENT_ID?: string;
	GOOGLE_FIT_CLIENT_SECRET?: string;
	GOOGLE_FIT_ACCESS_TOKEN?: string;
	GOOGLE_FIT_REFRESH_TOKEN?: string;
}

const SERVICES: Array<Omit<ZorFitServiceStatus, "configured" | "source">> = [
	{
		id: "hevy",
		label: "Hevy",
		auth: "api_key",
		notes: "Strength training, workouts, routines, and exercise history.",
	},
	{
		id: "strava",
		label: "Strava",
		auth: "oauth",
		notes: "Endurance activities, athlete profile, and activity history.",
	},
	{
		id: "cronometer",
		label: "Cronometer",
		auth: "username_password",
		notes: "Nutrition diary, macros, foods, fasting, and targets.",
	},
	{
		id: "intervals_icu",
		label: "Intervals.icu",
		auth: "api_key",
		notes: "Training load, wellness, activities, events, and gear.",
	},
	{
		id: "fitbit",
		label: "Fitbit",
		auth: "oauth",
		notes: "Fitbit profile, activity summaries, sleep, weight, and heart data.",
	},
	{
		id: "google_fit",
		label: "Google Fit",
		auth: "oauth",
		notes: "Google Fit aggregate activity, body, heart-rate, and sleep data.",
	},
];

function hasWorkerSecret(env: ZorFitServiceEnv, serviceId: ZorFitServiceId): boolean {
	switch (serviceId) {
		case "hevy":
			return Boolean(env.HEVY_API_KEY);
		case "strava":
			return Boolean(
				env.STRAVA_ACCESS_TOKEN &&
					env.STRAVA_REFRESH_TOKEN &&
					env.STRAVA_CLIENT_ID &&
					env.STRAVA_CLIENT_SECRET,
			);
		case "cronometer":
			return Boolean(env.CRONOMETER_USERNAME && env.CRONOMETER_PASSWORD);
		case "intervals_icu":
			return Boolean(env.INTERVALS_ICU_API_KEY && env.INTERVALS_ICU_ATHLETE_ID);
		case "fitbit":
			return Boolean(
				env.FITBIT_CLIENT_ID &&
					env.FITBIT_CLIENT_SECRET &&
					env.FITBIT_ACCESS_TOKEN &&
					env.FITBIT_REFRESH_TOKEN,
			);
		case "google_fit":
			return Boolean(
				env.GOOGLE_FIT_CLIENT_ID &&
					env.GOOGLE_FIT_CLIENT_SECRET &&
					env.GOOGLE_FIT_ACCESS_TOKEN &&
					env.GOOGLE_FIT_REFRESH_TOKEN,
			);
	}
}

export async function getZorFitServiceStatuses(
	env: ZorFitServiceEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<ZorFitServiceStatus[]> {
	const connections = await listServiceConnections(env, session);
	const configured = new Set(connections.map((connection) => connection.serviceId));

	return SERVICES.map((service) => {
		const userConfigured = configured.has(service.id);
		const workerConfigured = hasWorkerSecret(env, service.id);
		return {
			...service,
			configured: userConfigured || workerConfigured,
			source: userConfigured ? "user_d1" : workerConfigured ? "worker_secret" : "missing",
		};
	});
}
