import type { Props } from "../utils.js";
import { decryptApiKey, encryptApiKey } from "./key-storage.js";

export type ZorFitServiceId =
	| "hevy"
	| "strava"
	| "cronometer"
	| "intervals_icu"
	| "fitbit"
	| "google_fit";

export type ServiceAuthType = "api_key" | "oauth" | "username_password";

export interface ServiceConnectionRecord<T extends Record<string, unknown> = Record<string, unknown>> {
	serviceId: ZorFitServiceId;
	authType: ServiceAuthType;
	credentials: T;
	scopes?: string[];
	expiresAt?: number;
	updatedAt?: string;
}

export interface ServiceConnectionEnv {
	ZORFIT_DB: D1Database;
	COOKIE_ENCRYPTION_KEY: string;
}

function userIdForSession(session: Pick<Props, "login">): string {
	return `github:${session.login}`;
}

function idFor(userId: string, serviceId: ZorFitServiceId): string {
	return `${userId}:${serviceId}`;
}

export async function ensureUser(
	env: ServiceConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<string> {
	const userId = userIdForSession(session);
	const now = new Date().toISOString();
	await env.ZORFIT_DB.prepare(
		`INSERT INTO users (id, github_login, display_name, email, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   github_login = excluded.github_login,
		   display_name = excluded.display_name,
		   email = excluded.email,
		   updated_at = excluded.updated_at`,
	)
		.bind(userId, session.login, session.name ?? null, session.email ?? null, now, now)
		.run();
	return userId;
}

export async function upsertServiceConnection(
	env: ServiceConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	args: {
		serviceId: ZorFitServiceId;
		authType: ServiceAuthType;
		credentials: Record<string, unknown>;
		scopes?: string[];
		expiresAt?: number;
	},
): Promise<void> {
	const userId = await ensureUser(env, session);
	const now = new Date().toISOString();
	const encrypted = await encryptApiKey(
		JSON.stringify(args.credentials),
		env.COOKIE_ENCRYPTION_KEY,
	);

	await env.ZORFIT_DB.prepare(
		`INSERT INTO service_connections
		   (id, user_id, service_id, auth_type, encrypted_credentials, scopes, expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, service_id) DO UPDATE SET
		   auth_type = excluded.auth_type,
		   encrypted_credentials = excluded.encrypted_credentials,
		   scopes = excluded.scopes,
		   expires_at = excluded.expires_at,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			idFor(userId, args.serviceId),
			userId,
			args.serviceId,
			args.authType,
			encrypted,
			args.scopes ? JSON.stringify(args.scopes) : null,
			args.expiresAt ?? null,
			now,
			now,
		)
		.run();
}

export async function getServiceConnection<T extends Record<string, unknown> = Record<string, unknown>>(
	env: ServiceConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	serviceId: ZorFitServiceId,
): Promise<ServiceConnectionRecord<T> | null> {
	const userId = await ensureUser(env, session);
	const row = await env.ZORFIT_DB.prepare(
		`SELECT service_id, auth_type, encrypted_credentials, scopes, expires_at, updated_at
		 FROM service_connections
		 WHERE user_id = ? AND service_id = ?`,
	)
		.bind(userId, serviceId)
		.first<{
			service_id: ZorFitServiceId;
			auth_type: ServiceAuthType;
			encrypted_credentials: string;
			scopes: string | null;
			expires_at: number | null;
			updated_at: string;
		}>();

	if (!row) return null;

	const decrypted = await decryptApiKey(
		row.encrypted_credentials,
		env.COOKIE_ENCRYPTION_KEY,
	);

	return {
		serviceId: row.service_id,
		authType: row.auth_type,
		credentials: JSON.parse(decrypted) as T,
		scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
		expiresAt: row.expires_at ?? undefined,
		updatedAt: row.updated_at,
	};
}

export async function listServiceConnections(
	env: ServiceConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<Array<Pick<ServiceConnectionRecord, "serviceId" | "authType" | "scopes" | "expiresAt" | "updatedAt">>> {
	const userId = await ensureUser(env, session);
	const { results } = await env.ZORFIT_DB.prepare(
		`SELECT service_id, auth_type, scopes, expires_at, updated_at
		 FROM service_connections
		 WHERE user_id = ?
		 ORDER BY service_id ASC`,
	)
		.bind(userId)
		.all<{
			service_id: ZorFitServiceId;
			auth_type: ServiceAuthType;
			scopes: string | null;
			expires_at: number | null;
			updated_at: string;
		}>();

	return (results ?? []).map((row) => ({
		serviceId: row.service_id,
		authType: row.auth_type,
		scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
		expiresAt: row.expires_at ?? undefined,
		updatedAt: row.updated_at,
	}));
}

export async function deleteServiceConnection(
	env: ServiceConnectionEnv,
	session: Pick<Props, "login" | "name" | "email">,
	serviceId: ZorFitServiceId,
): Promise<void> {
	const userId = await ensureUser(env, session);
	await env.ZORFIT_DB.prepare(
		"DELETE FROM service_connections WHERE user_id = ? AND service_id = ?",
	)
		.bind(userId, serviceId)
		.run();
}
