import type { Env } from "../app.js";
import type { Props } from "../utils.js";
import {
	getAiConnection,
	getAiPreference,
	listAiConnectionSummaries,
} from "./ai-connections.js";
import {
	CronometerClient,
	KvCronometerSessionCache,
} from "./cronometer-client.js";
import {
	generateBasicNutritionInsight,
	generateBasicHealthInsight,
	generateHealthInsight,
	generateNutritionInsight,
} from "./llm-insights.js";
import {
	type DueNotificationSchedule,
	type DueUserMessageSchedule,
	getNotificationSchedule,
	getTelegramConnection,
	listDueNutritionSchedules,
	listDueUserMessageSchedules,
	logNotification,
	markUserMessageSlotSent,
	markNotificationSlotSent,
} from "./notifications.js";
import {
	collectHealthContext,
	normalizeHealthCategories,
} from "./data-routing.js";
import { getServiceConnection } from "./service-connections.js";
import { sendLongTelegramMessage } from "./telegram.js";

const TELEGRAM_SAFETY_FOOTER =
	"Not medical advice. Consult a qualified professional for health or nutrition decisions.";

function telegramInsightMessage(args: {
	title: string;
	date: string;
	question?: string;
	insight: string;
	dataCheck?: string;
}): string {
	return [
		`**${args.title}**`,
		`Date: ${args.date}`,
		args.question ? `Question: ${args.question}` : "",
		args.dataCheck ? `Data check: ${args.dataCheck}` : "",
		"",
		args.insight,
		"",
		TELEGRAM_SAFETY_FOOTER,
	]
		.filter((line) => line !== "")
		.join("\n");
}

function contextDataCheck(context: Awaited<ReturnType<typeof collectHealthContext>>): string {
	const ready = context.categories.filter((category) => category.status === "ready").length;
	const total = context.categories.length;
	const missing = context.categories
		.filter((category) => category.status !== "ready")
		.map((category) => category.category.replace(/_/g, " "))
		.slice(0, 3);
	return missing.length
		? `${ready}/${total} categories ready; missing ${missing.join(", ")}`
		: `${ready}/${total} categories ready`;
}

function compactInsightSummary(value: string): string {
	return value
		.replace(/<[^>]+>/g, "")
		.replace(/[*_`#>|-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 260);
}
type InsightSession = Pick<Props, "login" | "name" | "email">;

function sessionForDueSchedule(
	schedule: Pick<DueNotificationSchedule, "login" | "name" | "email">,
) {
	return {
		login: schedule.login,
		name: schedule.name,
		email: schedule.email,
		accessToken: "",
	};
}

function dateForInsight(
	schedule: Pick<
		DueNotificationSchedule,
		"localDate" | "dueTime" | "insightMode"
	>,
): string {
	if (schedule.insightMode === "previous_day") {
		const date = new Date(`${schedule.localDate}T00:00:00Z`);
		date.setUTCDate(date.getUTCDate() - 1);
		return date.toISOString().slice(0, 10);
	}
	if (schedule.insightMode === "smart" && schedule.dueTime < "08:00") {
		const date = new Date(`${schedule.localDate}T00:00:00Z`);
		date.setUTCDate(date.getUTCDate() - 1);
		return date.toISOString().slice(0, 10);
	}
	return schedule.localDate;
}

async function getCronometerNutrition(
	env: Env,
	session: InsightSession,
	timezone: string,
	date: string,
): Promise<unknown> {
	const connection = await getServiceConnection<Record<string, string>>(
		env,
		session,
		"cronometer",
	);
	const username = connection?.credentials.username || env.CRONOMETER_USERNAME;
	const password = connection?.credentials.password || env.CRONOMETER_PASSWORD;
	const client = new CronometerClient({
		username,
		password,
		timezone,
		sessionCache: new KvCronometerSessionCache(env.OAUTH_KV),
	});
	return client.getDailyNutrition(date);
}

async function getPreferredAiConnection(env: Env, session: InsightSession) {
	const [summaries, preference] = await Promise.all([
		listAiConnectionSummaries(env, session),
		getAiPreference(env, session),
	]);
	const preferred = preference
		? summaries.find(
				(summary) =>
					summary.provider === preference.defaultProvider && summary.enabled,
			)
		: undefined;
	const fallback = summaries.find((summary) => summary.enabled) ?? summaries[0];
	const selected = preferred ?? fallback;
	if (!selected) return null;
	return getAiConnection(env, session, selected.provider);
}

async function processDueSchedule(
	env: Env,
	schedule: DueNotificationSchedule,
): Promise<void> {
	const session = sessionForDueSchedule(schedule);
	const telegram = await getTelegramConnection(env, session);
	if (!telegram?.externalUserId || !telegram.enabled) {
		await logNotification(env, {
			userId: schedule.userId,
			channel: "telegram",
			topic: "nutrition",
			scheduledFor: schedule.slotKey,
			status: "skipped",
			errorMessage: "Telegram is not connected.",
		});
		await markNotificationSlotSent(env, schedule.userId, schedule.slotKey);
		return;
	}

	const date = dateForInsight(schedule);
	const nutrition = await getCronometerNutrition(
		env,
		session,
		schedule.timezone,
		date,
	);
	const aiConnection = await getPreferredAiConnection(env, session);
	const insight = aiConnection
		? await generateNutritionInsight(aiConnection, {
				date,
				mode: schedule.insightMode,
				nutrition,
				promptInstructions: schedule.promptInstructions,
			})
		: generateBasicNutritionInsight({
				date,
				mode: schedule.insightMode,
				nutrition,
				promptInstructions: schedule.promptInstructions,
			});
	const title =
		schedule.insightMode === "previous_day" || date < schedule.localDate
			? "ZorFit previous day nutrition"
			: "ZorFit nutrition check-in";
	const text = telegramInsightMessage({
		title,
		date,
		insight,
		dataCheck: "Cronometer nutrition retrieved for this insight.",
	});
	await sendLongTelegramMessage(env, {
		chatId: telegram.externalUserId,
		text,
	});
	await markNotificationSlotSent(env, schedule.userId, schedule.slotKey);
	await logNotification(env, {
		userId: schedule.userId,
		channel: "telegram",
		topic: "nutrition",
		scheduledFor: schedule.slotKey,
		status: "sent",
		messageTitle: title,
		messageSummary: compactInsightSummary(insight),
		messageText: text,
	});
}

async function processDueUserMessageSchedule(
	env: Env,
	schedule: DueUserMessageSchedule,
): Promise<void> {
	const session = sessionForDueSchedule(schedule);
	const telegram = await getTelegramConnection(env, session);
	if (!telegram?.externalUserId || !telegram.enabled) {
		await logNotification(env, {
			userId: schedule.userId,
			channel: "telegram",
			topic: "nutrition",
			scheduledFor: schedule.slotKey,
			status: "skipped",
			errorMessage: "Telegram is not connected.",
		});
		await markUserMessageSlotSent(env, schedule.id, schedule.slotKey);
		return;
	}

	const date = dateForInsight(schedule);
	const categories = normalizeHealthCategories(schedule.categories);
	const question =
		schedule.question ||
		"Give me a useful ZorFit insight from the selected health categories.";
	const context = await collectHealthContext(env, session, {
		categories,
		timezone: schedule.timezone,
		date,
	});
	const aiConnection = await getPreferredAiConnection(env, session);
	const input = {
		date,
		timezone: schedule.timezone,
		title: schedule.title,
		question,
		categories,
		context,
		promptInstructions: schedule.promptInstructions,
	};
	const insight = aiConnection
		? await generateHealthInsight(aiConnection, input)
		: generateBasicHealthInsight(input);
	const text = telegramInsightMessage({
		title: schedule.title,
		date,
		question,
		insight,
		dataCheck: contextDataCheck(context),
	});
	await sendLongTelegramMessage(env, {
		chatId: telegram.externalUserId,
		text,
	});
	await markUserMessageSlotSent(env, schedule.id, schedule.slotKey);
	await logNotification(env, {
		userId: schedule.userId,
		channel: "telegram",
		topic: "nutrition",
		scheduledFor: schedule.slotKey,
		status: "sent",
		scheduleId: schedule.id,
		messageTitle: schedule.title,
		messageSummary: compactInsightSummary(insight),
		messageText: text,
	});
}

function localDateAndTime(
	timezone: string,
	now = new Date(),
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

export async function sendTestNutritionInsight(
	env: Env,
	session: InsightSession,
	now = new Date(),
): Promise<void> {
	const [telegram, schedule] = await Promise.all([
		getTelegramConnection(env, session),
		getNotificationSchedule(env, session),
	]);
	if (!telegram?.externalUserId || !telegram.enabled) {
		throw new Error(
			"Telegram is not connected. Connect Telegram before sending a test insight.",
		);
	}
	const timezone = schedule?.timezone ?? "America/New_York";
	const local = localDateAndTime(timezone, now);
	const insightMode = schedule?.insightMode ?? "today_so_far";
	const testSchedule = {
		localDate: local.date,
		dueTime: local.time,
		insightMode,
	};
	const date = dateForInsight(testSchedule);
	const nutrition = await getCronometerNutrition(env, session, timezone, date);
	const aiConnection = await getPreferredAiConnection(env, session);
	const insightInput = {
		date,
		mode: insightMode,
		nutrition,
		promptInstructions: schedule?.promptInstructions,
	};
	const insight = aiConnection
		? await generateNutritionInsight(aiConnection, insightInput)
		: generateBasicNutritionInsight(insightInput);
	await sendLongTelegramMessage(env, {
		chatId: telegram.externalUserId,
		text: telegramInsightMessage({
			title: "ZorFit test nutrition insight",
			date,
			insight,
			dataCheck: "Cronometer nutrition retrieved for this test insight.",
		}),
	});
}

export async function processNutritionNotifications(
	env: Env,
	now = new Date(),
): Promise<{ processed: number; failed: number }> {
	const [due, dueMessages] = await Promise.all([
		listDueNutritionSchedules(env, now),
		listDueUserMessageSchedules(env, now),
	]);
	let processed = 0;
	let failed = 0;
	for (const schedule of due) {
		try {
			await processDueSchedule(env, schedule);
			processed += 1;
		} catch (error) {
			failed += 1;
			await logNotification(env, {
				userId: schedule.userId,
				channel: "telegram",
				topic: "nutrition",
				scheduledFor: schedule.slotKey,
				status: "failed",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		}
	}
	for (const schedule of dueMessages) {
		try {
			await processDueUserMessageSchedule(env, schedule);
			processed += 1;
		} catch (error) {
			failed += 1;
			await logNotification(env, {
				userId: schedule.userId,
				channel: "telegram",
				topic: "nutrition",
				scheduledFor: schedule.slotKey,
				status: "failed",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { processed, failed };
}
