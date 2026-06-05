import type { Props } from "../utils.js";
import { decryptApiKey, encryptApiKey } from "./key-storage.js";
import { ensureUser } from "./service-connections.js";

export type AiProviderId =
	| "openai"
	| "claude"
	| "gemini"
	| "nvidia_nim"
	| "openrouter"
	| "groq"
	| "google_ai_studio";

export interface AiConnectionEnv {
	ZORFIT_DB: D1Database;
	COOKIE_ENCRYPTION_KEY: string;
}

export interface AiConnectionSummary {
	provider: AiProviderId;
	baseUrl?: string;
	modelName: string;
	requestSettings: AiRequestSettings;
	enabled: boolean;
	updatedAt: string;
}

export interface AiConnection extends AiConnectionSummary {
	apiKey: string;
}

export interface AiPreference {
	defaultProvider: AiProviderId;
	updatedAt: string;
}

export type AiRequestSettings = Record<string, boolean | number | string>;

const ALLOWED_REQUEST_SETTINGS = new Set([
	"temperature",
	"top_p",
	"max_tokens",
	"max_completion_tokens",
	"include_reasoning",
	"reasoning_effort",
	"reasoning_format",
	"seed",
]);

function parseStoredRequestSettings(value: string | null): AiRequestSettings {
	if (!value) return {};
	try {
		return normalizeAiRequestSettings(JSON.parse(value));
	} catch {
		return {};
	}
}

export function normalizeAiRequestSettings(value: unknown): AiRequestSettings {
	if (value === undefined || value === null || value === "") return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Advanced request settings must be a JSON object.");
	}

	const input = value as Record<string, unknown>;
	const unknownKeys = Object.keys(input).filter(
		(key) => !ALLOWED_REQUEST_SETTINGS.has(key),
	);
	if (unknownKeys.length > 0) {
		throw new Error(
			`Unsupported advanced request setting${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
		);
	}

	const output: AiRequestSettings = {};
	for (const key of ["temperature", "top_p"] as const) {
		const candidate = input[key];
		if (candidate === undefined) continue;
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
			throw new Error(`${key} must be a number.`);
		}
		const maximum = key === "temperature" ? 2 : 1;
		if (candidate < 0 || candidate > maximum) {
			throw new Error(`${key} must be between 0 and ${maximum}.`);
		}
		output[key] = candidate;
	}
	for (const key of ["max_tokens", "max_completion_tokens"] as const) {
		const candidate = input[key];
		if (candidate === undefined) continue;
		if (
			!Number.isInteger(candidate) ||
			(candidate as number) < 1 ||
			(candidate as number) > 4000
		) {
			throw new Error(`${key} must be a whole number between 1 and 4000.`);
		}
		output[key] = candidate as number;
	}
	if (input.include_reasoning !== undefined) {
		if (typeof input.include_reasoning !== "boolean") {
			throw new Error("include_reasoning must be true or false.");
		}
		output.include_reasoning = input.include_reasoning;
	}
	if (input.reasoning_format !== undefined) {
		if (!["hidden", "raw", "parsed"].includes(String(input.reasoning_format))) {
			throw new Error('reasoning_format must be "hidden", "raw", or "parsed".');
		}
		output.reasoning_format = String(input.reasoning_format);
	}
	if (input.reasoning_effort !== undefined) {
		if (
			!["none", "default", "low", "medium", "high"].includes(
				String(input.reasoning_effort),
			)
		) {
			throw new Error(
				'reasoning_effort must be "none", "default", "low", "medium", or "high".',
			);
		}
		output.reasoning_effort = String(input.reasoning_effort);
	}
	if (input.seed !== undefined) {
		if (!Number.isInteger(input.seed))
			throw new Error("seed must be a whole number.");
		output.seed = input.seed as number;
	}
	return output;
}

export function recommendedAiRequestSettings(
	provider: AiProviderId,
	modelName: string,
): AiRequestSettings {
	const model = modelName.trim().toLowerCase();
	if (provider === "groq" && model.startsWith("openai/gpt-oss-")) {
		return {
			include_reasoning: false,
			reasoning_effort: "low",
			max_completion_tokens: 4000,
		};
	}
	if (provider === "groq" && model.startsWith("qwen/qwen3")) {
		return { reasoning_format: "hidden", max_completion_tokens: 4000 };
	}
	return {};
}

function idFor(userId: string, provider: AiProviderId): string {
	return `${userId}:ai:${provider}`;
}

export async function upsertAiConnection(
	env: AiConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	args: {
		provider: AiProviderId;
		apiKey: string;
		baseUrl?: string;
		modelName: string;
		requestSettings?: AiRequestSettings;
		enabled?: boolean;
	},
): Promise<void> {
	const userId = await ensureUser(env, session);
	const now = new Date().toISOString();
	const encrypted = await encryptApiKey(args.apiKey, env.COOKIE_ENCRYPTION_KEY);
	await env.ZORFIT_DB.prepare(
		`INSERT INTO user_ai_connections
		   (id, user_id, provider, encrypted_api_key, base_url, model_name, request_settings_json, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, provider) DO UPDATE SET
		   encrypted_api_key = excluded.encrypted_api_key,
		   base_url = excluded.base_url,
		   model_name = excluded.model_name,
		   request_settings_json = excluded.request_settings_json,
		   enabled = excluded.enabled,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			idFor(userId, args.provider),
			userId,
			args.provider,
			encrypted,
			args.baseUrl?.trim() || null,
			args.modelName.trim(),
			JSON.stringify(args.requestSettings ?? {}),
			args.enabled === false ? 0 : 1,
			now,
			now,
		)
		.run();
}

export async function getAiConnection(
	env: AiConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	provider: AiProviderId,
): Promise<AiConnection | null> {
	const userId = await ensureUser(env, session);
	const row = await env.ZORFIT_DB.prepare(
		`SELECT provider, encrypted_api_key, base_url, model_name, request_settings_json, enabled, updated_at
		 FROM user_ai_connections
		 WHERE user_id = ? AND provider = ?`,
	)
		.bind(userId, provider)
		.first<{
			provider: AiProviderId;
			encrypted_api_key: string;
			base_url: string | null;
			model_name: string;
			request_settings_json: string | null;
			enabled: number;
			updated_at: string;
		}>();
	if (!row) return null;
	return {
		provider: row.provider,
		apiKey: await decryptApiKey(
			row.encrypted_api_key,
			env.COOKIE_ENCRYPTION_KEY,
		),
		baseUrl: row.base_url ?? undefined,
		modelName: row.model_name,
		requestSettings: parseStoredRequestSettings(row.request_settings_json),
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
	};
}

export async function listAiConnectionSummaries(
	env: AiConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<AiConnectionSummary[]> {
	const userId = await ensureUser(env, session);
	const { results } = await env.ZORFIT_DB.prepare(
		`SELECT provider, base_url, model_name, request_settings_json, enabled, updated_at
		 FROM user_ai_connections
		 WHERE user_id = ?
		 ORDER BY provider ASC`,
	)
		.bind(userId)
		.all<{
			provider: AiProviderId;
			base_url: string | null;
			model_name: string;
			request_settings_json: string | null;
			enabled: number;
			updated_at: string;
		}>();
	return (results ?? []).map((row) => ({
		provider: row.provider,
		baseUrl: row.base_url ?? undefined,
		modelName: row.model_name,
		requestSettings: parseStoredRequestSettings(row.request_settings_json),
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
	}));
}

export async function deleteAiConnection(
	env: AiConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	provider: AiProviderId,
): Promise<void> {
	const userId = await ensureUser(env, session);
	await env.ZORFIT_DB.prepare(
		"DELETE FROM user_ai_connections WHERE user_id = ? AND provider = ?",
	)
		.bind(userId, provider)
		.run();
	await env.ZORFIT_DB.prepare(
		"DELETE FROM user_ai_preferences WHERE user_id = ? AND default_provider = ?",
	)
		.bind(userId, provider)
		.run();
}

export async function getAiPreference(
	env: AiConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<AiPreference | null> {
	const userId = await ensureUser(env, session);
	const row = await env.ZORFIT_DB.prepare(
		`SELECT default_provider, updated_at
		 FROM user_ai_preferences
		 WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{ default_provider: AiProviderId; updated_at: string }>();
	if (!row) return null;
	return {
		defaultProvider: row.default_provider,
		updatedAt: row.updated_at,
	};
}

export async function upsertAiPreference(
	env: AiConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	defaultProvider: AiProviderId,
): Promise<void> {
	const userId = await ensureUser(env, session);
	const now = new Date().toISOString();
	await env.ZORFIT_DB.prepare(
		`INSERT INTO user_ai_preferences (user_id, default_provider, created_at, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   default_provider = excluded.default_provider,
		   updated_at = excluded.updated_at`,
	)
		.bind(userId, defaultProvider, now, now)
		.run();
}
