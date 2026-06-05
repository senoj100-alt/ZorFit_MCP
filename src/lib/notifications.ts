import type { Props } from "../utils.js";
import { ensureUser } from "./service-connections.js";

export type MessagingChannel = "telegram";
export type NotificationTopic = "nutrition";
export type InsightMode = "today_so_far" | "previous_day" | "smart";
export const PROMPT_INSTRUCTIONS_LIMIT = 1000;

export interface NotificationEnv {
	ZORFIT_DB: D1Database;
	COOKIE_ENCRYPTION_KEY: string;
}

export interface TelegramConnection {
	channel: MessagingChannel;
	externalUserId?: string;
	externalUsername?: string;
	enabled: boolean;
	updatedAt: string;
}

export interface NotificationSchedule {
	channel: MessagingChannel;
	topic: NotificationTopic;
	enabled: boolean;
	timezone: string;
	times: string[];
	insightMode: InsightMode;
	promptInstructions?: string;
	lastSent: Record<string, string>;
	updatedAt: string;
}

export interface DueNotificationSchedule extends NotificationSchedule {
	userId: string;
	login: string;
	name: string;
	email: string;
	dueTime: string;
	localDate: string;
	slotKey: string;
}

function idFor(userId: string, channel: string, topic?: string): string {
	return topic ? `${userId}:${channel}:${topic}` : `${userId}:${channel}`;
}

export function normalizeNotificationTimes(times: unknown): string[] {
	const source = Array.isArray(times) ? times : [];
	const normalized = source
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
	return Array.from(new Set(normalized)).sort();
}

export function normalizeTimezone(timezone: unknown): string {
	const value =
		typeof timezone === "string" && timezone.trim()
			? timezone.trim()
			: "America/New_York";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
		return value;
	} catch {
		return "America/New_York";
	}
}

export function normalizeInsightMode(mode: unknown): InsightMode {
	if (mode === "today_so_far" || mode === "previous_day" || mode === "smart")
		return mode;
	return "smart";
}

export function normalizePromptInstructions(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, PROMPT_INSTRUCTIONS_LIMIT);
}

export async function getTelegramConnection(
	env: NotificationEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<TelegramConnection | null> {
	const userId = await ensureUser(env, session);
	const row = await env.ZORFIT_DB.prepare(
		`SELECT channel, external_user_id, external_username, enabled, updated_at
		 FROM user_messaging_connections
		 WHERE user_id = ? AND channel = 'telegram'`,
	)
		.bind(userId)
		.first<{
			channel: MessagingChannel;
			external_user_id: string | null;
			external_username: string | null;
			enabled: number;
			updated_at: string;
		}>();
	if (!row) return null;
	return {
		channel: row.channel,
		externalUserId: row.external_user_id ?? undefined,
		externalUsername: row.external_username ?? undefined,
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
	};
}

export async function upsertTelegramConnection(
	env: NotificationEnv,
	userId: string,
	args: {
		externalUserId: string;
		externalUsername?: string;
		enabled?: boolean;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await env.ZORFIT_DB.prepare(
		`INSERT INTO user_messaging_connections
		   (id, user_id, channel, external_user_id, external_username, enabled, created_at, updated_at)
		 VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, channel) DO UPDATE SET
		   external_user_id = excluded.external_user_id,
		   external_username = excluded.external_username,
		   enabled = excluded.enabled,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			idFor(userId, "telegram"),
			userId,
			args.externalUserId,
			args.externalUsername ?? null,
			args.enabled === false ? 0 : 1,
			now,
			now,
		)
		.run();
}

export async function createTelegramLinkCode(
	env: NotificationEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<string> {
	const userId = await ensureUser(env, session);
	const bytes = crypto.getRandomValues(new Uint8Array(9));
	const code = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
	await env.ZORFIT_DB.prepare(
		"INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
	)
		.bind(code, userId, expiresAt)
		.run();
	return code;
}

export async function consumeTelegramLinkCode(
	env: NotificationEnv,
	code: string,
): Promise<string | null> {
	const row = await env.ZORFIT_DB.prepare(
		`SELECT user_id, expires_at, used_at
		 FROM telegram_link_codes
		 WHERE code = ?`,
	)
		.bind(code)
		.first<{ user_id: string; expires_at: number; used_at: string | null }>();
	if (!row || row.used_at || row.expires_at < Math.floor(Date.now() / 1000))
		return null;
	await env.ZORFIT_DB.prepare(
		"UPDATE telegram_link_codes SET used_at = ? WHERE code = ?",
	)
		.bind(new Date().toISOString(), code)
		.run();
	return row.user_id;
}

export async function getNotificationSchedule(
	env: NotificationEnv,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<NotificationSchedule | null> {
	const userId = await ensureUser(env, session);
	const row = await env.ZORFIT_DB.prepare(
		`SELECT channel, topic, enabled, timezone, times_json, insight_mode, prompt_instructions, last_sent_json, updated_at
		 FROM user_notification_schedules
		 WHERE user_id = ? AND channel = 'telegram' AND topic = 'nutrition'`,
	)
		.bind(userId)
		.first<{
			channel: MessagingChannel;
			topic: NotificationTopic;
			enabled: number;
			timezone: string;
			times_json: string;
			insight_mode: InsightMode;
			prompt_instructions: string | null;
			last_sent_json: string;
			updated_at: string;
		}>();
	if (!row) return null;
	return {
		channel: row.channel,
		topic: row.topic,
		enabled: row.enabled === 1,
		timezone: row.timezone,
		times: normalizeNotificationTimes(JSON.parse(row.times_json || "[]")),
		insightMode: normalizeInsightMode(row.insight_mode),
		promptInstructions: normalizePromptInstructions(row.prompt_instructions),
		lastSent: JSON.parse(row.last_sent_json || "{}") as Record<string, string>,
		updatedAt: row.updated_at,
	};
}

export async function upsertNotificationSchedule(
	env: NotificationEnv,
	session: Pick<Props, "login" | "name" | "email">,
	args: {
		enabled: boolean;
		timezone: string;
		times: string[];
		insightMode: InsightMode;
		promptInstructions?: string;
	},
): Promise<void> {
	const userId = await ensureUser(env, session);
	const now = new Date().toISOString();
	await env.ZORFIT_DB.prepare(
		`INSERT INTO user_notification_schedules
		   (id, user_id, channel, topic, enabled, timezone, times_json, insight_mode, prompt_instructions, last_sent_json, created_at, updated_at)
		 VALUES (?, ?, 'telegram', 'nutrition', ?, ?, ?, ?, ?, '{}', ?, ?)
		 ON CONFLICT(user_id, channel, topic) DO UPDATE SET
		   enabled = excluded.enabled,
		   timezone = excluded.timezone,
		   times_json = excluded.times_json,
		   insight_mode = excluded.insight_mode,
		   prompt_instructions = excluded.prompt_instructions,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			idFor(userId, "telegram", "nutrition"),
			userId,
			args.enabled ? 1 : 0,
			normalizeTimezone(args.timezone),
			JSON.stringify(normalizeNotificationTimes(args.times)),
			normalizeInsightMode(args.insightMode),
			normalizePromptInstructions(args.promptInstructions) ?? null,
			now,
			now,
		)
		.run();
}

function localParts(
	now: Date,
	timezone: string,
): { date: string; time: string } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? "";
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		time: `${get("hour")}:${get("minute")}`,
	};
}

function isWithinCronWindow(
	localTime: string,
	scheduledTime: string,
	windowMinutes = 15,
): boolean {
	const [nowHour, nowMinute] = localTime.split(":").map(Number);
	const [slotHour, slotMinute] = scheduledTime.split(":").map(Number);
	const nowTotal = nowHour * 60 + nowMinute;
	const slotTotal = slotHour * 60 + slotMinute;
	const delta = nowTotal - slotTotal;
	return delta >= 0 && delta < windowMinutes;
}

export async function listDueNutritionSchedules(
	env: NotificationEnv,
	now = new Date(),
): Promise<DueNotificationSchedule[]> {
	const { results } = await env.ZORFIT_DB.prepare(
		`SELECT
		   s.user_id, u.github_login, u.display_name, u.email,
		   s.channel, s.topic, s.enabled, s.timezone, s.times_json, s.insight_mode, s.prompt_instructions, s.last_sent_json, s.updated_at
		 FROM user_notification_schedules s
		 JOIN users u ON u.id = s.user_id
		 WHERE s.channel = 'telegram' AND s.topic = 'nutrition' AND s.enabled = 1`,
	).all<{
		user_id: string;
		github_login: string;
		display_name: string | null;
		email: string | null;
		channel: MessagingChannel;
		topic: NotificationTopic;
		enabled: number;
		timezone: string;
		times_json: string;
		insight_mode: InsightMode;
		prompt_instructions: string | null;
		last_sent_json: string;
		updated_at: string;
	}>();

	const due: DueNotificationSchedule[] = [];
	for (const row of results ?? []) {
		const timezone = normalizeTimezone(row.timezone);
		const parts = localParts(now, timezone);
		const times = normalizeNotificationTimes(
			JSON.parse(row.times_json || "[]"),
		);
		const lastSent = JSON.parse(row.last_sent_json || "{}") as Record<
			string,
			string
		>;
		for (const time of times) {
			if (!isWithinCronWindow(parts.time, time)) continue;
			const slotKey = `${parts.date}:${time}`;
			if (lastSent[slotKey]) continue;
			due.push({
				userId: row.user_id,
				login: row.github_login,
				name: row.display_name ?? row.github_login,
				email: row.email ?? "",
				channel: row.channel,
				topic: row.topic,
				enabled: row.enabled === 1,
				timezone,
				times,
				insightMode: normalizeInsightMode(row.insight_mode),
				promptInstructions: normalizePromptInstructions(
					row.prompt_instructions,
				),
				lastSent,
				updatedAt: row.updated_at,
				dueTime: time,
				localDate: parts.date,
				slotKey,
			});
		}
	}
	return due;
}

export async function markNotificationSlotSent(
	env: NotificationEnv,
	userId: string,
	slotKey: string,
): Promise<void> {
	const row = await env.ZORFIT_DB.prepare(
		`SELECT last_sent_json
		 FROM user_notification_schedules
		 WHERE user_id = ? AND channel = 'telegram' AND topic = 'nutrition'`,
	)
		.bind(userId)
		.first<{ last_sent_json: string }>();
	const lastSent = row?.last_sent_json
		? (JSON.parse(row.last_sent_json) as Record<string, string>)
		: {};
	lastSent[slotKey] = new Date().toISOString();
	await env.ZORFIT_DB.prepare(
		`UPDATE user_notification_schedules
		 SET last_sent_json = ?, updated_at = ?
		 WHERE user_id = ? AND channel = 'telegram' AND topic = 'nutrition'`,
	)
		.bind(JSON.stringify(lastSent), new Date().toISOString(), userId)
		.run();
}

export async function logNotification(
	env: NotificationEnv,
	args: {
		userId: string;
		channel: MessagingChannel;
		topic: NotificationTopic;
		scheduledFor: string;
		status: "sent" | "skipped" | "failed";
		errorMessage?: string;
	},
): Promise<void> {
	await env.ZORFIT_DB.prepare(
		`INSERT INTO user_notification_logs
		   (id, user_id, channel, topic, scheduled_for, sent_at, status, error_message)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			args.userId,
			args.channel,
			args.topic,
			args.scheduledFor,
			args.status === "sent" ? new Date().toISOString() : null,
			args.status,
			args.errorMessage ?? null,
		)
		.run();
}
