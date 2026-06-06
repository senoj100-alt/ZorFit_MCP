import { Hono } from "hono";
import type { Env, Variables } from "../app.js";
import {
	type AiProviderId,
	deleteAiConnection,
	getAiConnection,
	getAiPreference,
	listAiConnectionSummaries,
	normalizeAiRequestSettings,
	recommendedAiRequestSettings,
	upsertAiPreference,
	upsertAiConnection,
} from "../lib/ai-connections.js";
import {
	consumeTelegramLinkCode,
	MESSAGE_QUESTION_LIMIT,
	PROMPT_INSTRUCTIONS_LIMIT,
	createTelegramLinkCode,
	deleteUserMessageSchedule,
	getNotificationSchedule,
	getTelegramConnection,
	listNotificationLogs,
	listUserMessageSchedules,
	normalizeInsightMode,
	normalizeMessageQuestion,
	normalizeNotificationTimes,
	normalizePromptInstructions,
	normalizeTimezone,
	upsertUserMessageSchedule,
	upsertNotificationSchedule,
	upsertTelegramConnection,
	type UserMessageSchedule,
	type NotificationLogEntry,
} from "../lib/notifications.js";
import {
	HEALTH_CATEGORIES,
	PROVIDER_LABELS,
	collectHealthContext,
	listDataPreferences,
	normalizeHealthCategories,
	questionBankForCategories,
	upsertDataPreferences,
	type CategoryContext,
	type HealthContextBundle,
	type HealthDataCategory,
} from "../lib/data-routing.js";
import { sendTestNutritionInsight } from "../lib/scheduled-nutrition.js";
import { getZorFitServiceStatuses } from "../lib/service-registry.js";
import { ensureUser } from "../lib/service-connections.js";
import {
	sendLongTelegramMessage,
	sendTelegramMessage,
} from "../lib/telegram.js";
import {
	generateBasicHealthInsight,
	generateHealthInsight,
} from "../lib/llm-insights.js";
import { ZORFIT_BRAND, ZORFIT_THEME_CSS } from "../lib/zorfit-theme.js";
import type { Props } from "../utils.js";
import { renderZorFitLandingPage } from "./zorfit-landing.js";

const utilityRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

utilityRoutes.get("/health", (c) => {
	return c.json({
		status: "healthy",
		name: "ZorFit_MCP",
		transport: "streamable-http",
		version: "1.0.0",
		oauth: "enabled",
	});
});

utilityRoutes.get("/stats", async (c) => {
	try {
		const kv = c.env.OAUTH_KV;
		const [userKeys, sessionKeys, approvalKeys] = await Promise.all([
			kv.list({ prefix: "hevy_key:" }),
			kv.list({ prefix: "session:" }),
			kv.list({ prefix: "approval:" }),
		]);

		return c.json({
			total_users: userKeys.keys.length,
			active_sessions: sessionKeys.keys.length,
			pending_approvals: approvalKeys.keys.length,
		});
	} catch (error) {
		console.error("Error fetching stats:", error);
		return c.json(
			{
				error: "Failed to fetch stats",
				total_users: 0,
				active_sessions: 0,
				pending_approvals: 0,
			},
			500,
		);
	}
});

utilityRoutes.get("/signup", (c) => {
	const githubReady = Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET);
	const googleReady = Boolean(
		c.env.GOOGLE_LOGIN_CLIENT_ID && c.env.GOOGLE_LOGIN_CLIENT_SECRET,
	);
	const githubAction = githubReady
		? `<a class="button primary" href="/connections">Continue with GitHub</a>`
		: `<span class="button disabled">GitHub sign-in needs setup</span>`;
	const googleAction = googleReady
		? `<a class="button google" href="/auth/google?return_to=/connections">Continue with Google</a>`
		: `<span class="button disabled">Google sign-in needs setup</span>`;

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Sign up - ZorFit_MCP</title>
	<style>
		${ZORFIT_THEME_CSS}
		body {
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
		}
		main {
			width: min(620px, 100%);
			padding: 30px;
			border: 1px solid rgba(245, 242, 236, 0.12);
			border-radius: 8px;
			background: linear-gradient(180deg, rgba(245, 242, 236, 0.07), rgba(245, 242, 236, 0.035));
			box-shadow: 0 34px 90px rgba(0, 0, 0, 0.32);
		}
		.brand { margin-bottom: 28px; }
		h1 {
			margin: 0 0 12px;
			font-size: clamp(2.5rem, 9vw, 4.8rem);
			line-height: 0.95;
		}
		p {
			margin: 0;
			color: var(--muted);
			line-height: 1.65;
		}
		.actions {
			display: grid;
			gap: 12px;
			margin-top: 28px;
		}
		.actions .button {
			min-height: 50px;
		}
		.note {
			margin-top: 18px;
			font-size: 0.92rem;
		}
		.back {
			display: inline-block;
			margin-top: 24px;
			color: var(--green);
			font-weight: 750;
			text-decoration: none;
		}
	</style>
</head>
<body>
	<main>
		<a class="brand" href="/">
			${ZORFIT_BRAND}
		</a>
		<h1>Create your ZorFit account.</h1>
		<p>Choose a sign-in method, then connect your fitness sources from the dashboard.</p>
		<div class="actions">
			${githubAction}
			${googleAction}
		</div>
		<p class="note">Sign-in activates after the OAuth client IDs and secrets are added to this ZorFit Cloudflare Worker.</p>
		<a class="back" href="/">Back to homepage</a>
	</main>
</body>
</html>`;

	return c.html(html);
});

utilityRoutes.get("/signin", (c) => {
	return c.redirect("/signup");
});

type SettingsCard = {
	id: string;
	label: string;
	status: string;
	description: string;
	href: string;
	guidance?: string[];
};

type SourceSettingsCard = SettingsCard & {
	authType: "api_key" | "oauth" | "username_password" | "coming_soon";
	fields: string[];
	helpText: string;
	helpUrl?: string;
	helpLabel?: string;
};

const SOURCE_SETTINGS: SourceSettingsCard[] = [
	{
		id: "hevy",
		label: "Hevy",
		status: "Live",
		description: "Strength training, workouts, routines, and exercise history.",
		href: "/settings/source/hevy",
		authType: "api_key",
		fields: ["apiKey"],
		helpText: "Add your Hevy API key from Hevy developer settings.",
		helpUrl: "https://hevy.com/settings?developer",
		helpLabel: "Open Hevy settings",
	},
	{
		id: "strava",
		label: "Strava",
		status: "Ready",
		description:
			"Endurance activities, activity detail, HR, pace, and power when available.",
		href: "/settings/source/strava",
		authType: "oauth",
		fields: ["accessToken", "refreshToken"],
		helpText:
			"Paste Strava OAuth tokens for now. Full OAuth connect can be added later.",
		helpUrl: "https://www.strava.com/settings/api",
		helpLabel: "Open Strava API settings",
	},
	{
		id: "cronometer",
		label: "Cronometer",
		status: "Live",
		description: "Nutrition diary, macros, foods, and daily nutrition targets.",
		href: "/settings/source/cronometer",
		authType: "username_password",
		fields: ["username", "password"],
		helpText:
			"Add your Cronometer username/email and password for nutrition sync.",
		helpUrl: "https://cronometer.com/login/",
		helpLabel: "Open Cronometer",
	},
	{
		id: "intervals_icu",
		label: "Intervals.icu",
		status: "Live",
		description: "Training load, wellness, activities, events, and gear.",
		href: "/settings/source/intervals_icu",
		authType: "api_key",
		fields: ["apiKey", "athleteId"],
		helpText: "Use your Intervals.icu API key and athlete ID.",
		helpUrl: "https://intervals.icu/settings",
		helpLabel: "Open Intervals.icu settings",
	},
	{
		id: "fitbit",
		label: "Fitbit",
		status: "OAuth",
		description: "Activity, sleep, weight, heart data, and recovery signals.",
		href: "/settings/source/fitbit",
		authType: "oauth",
		fields: ["accessToken", "refreshToken"],
		helpText:
			"Use OAuth connect when app credentials are configured, or paste Fitbit tokens.",
		helpUrl: "https://dev.fitbit.com/apps",
		helpLabel: "Open Fitbit apps",
	},
	{
		id: "google_fit",
		label: "Google Fit",
		status: "OAuth",
		description:
			"Activity, body, heart-rate, and sleep aggregates from Google Fit.",
		href: "/settings/source/google_fit",
		authType: "oauth",
		fields: ["accessToken", "refreshToken"],
		helpText:
			"Use OAuth connect when app credentials are configured, or paste Google Fit tokens.",
		helpUrl: "https://console.cloud.google.com/apis/credentials",
		helpLabel: "Open Google credentials",
	},
	{
		id: "garmin",
		label: "Garmin",
		status: "Planned",
		description:
			"Activities, HRV, sleep, stress, training, and wearable health metrics.",
		href: "/settings/source/garmin",
		authType: "coming_soon",
		fields: [],
		helpText:
			"Garmin requires official developer/partner access. This is a placeholder.",
	},
	{
		id: "oura",
		label: "Oura",
		status: "Planned",
		description:
			"Sleep, readiness, HRV, resting heart rate, and recovery trends.",
		href: "/settings/source/oura",
		authType: "coming_soon",
		fields: [],
		helpText: "Oura support can be added as a future recovery source.",
	},
	{
		id: "whoop",
		label: "Whoop",
		status: "Planned",
		description: "Recovery, strain, sleep, HRV, and daily readiness context.",
		href: "/settings/source/whoop",
		authType: "coming_soon",
		fields: [],
		helpText: "Whoop support can be added as a future recovery source.",
	},
];

const LLM_SETTINGS: SettingsCard[] = [
	{
		id: "openai",
		label: "OpenAI",
		status: "Recommended",
		description: "Use your OpenAI key for nutrition and training insights.",
		href: "/settings/llm/openai",
		guidance: [
			"Model examples: gpt-4o-mini, gpt-4.1-mini",
			"Base URL: https://api.openai.com/v1",
			"Cost tier: cheap for gpt-4o-mini style daily summaries.",
		],
	},
	{
		id: "claude",
		label: "Claude / Anthropic",
		status: "Mid cost",
		description: "Use your Anthropic key for careful, concise insight writing.",
		href: "/settings/llm/claude",
		guidance: [
			"Model examples: claude-3-5-haiku-latest, claude-3-5-sonnet-latest",
			"Base URL: https://api.anthropic.com",
			"Cost tier: Haiku is cheaper; Sonnet costs more but writes stronger analysis.",
		],
	},
	{
		id: "gemini",
		label: "Gemini / Google AI Studio",
		status: "Free tier",
		description: "Use Google AI Studio API keys for Gemini-family ZorFit insights.",
		href: "/settings/llm/gemini",
		guidance: [
			"Model examples: gemini-1.5-flash, gemini-2.0-flash",
			"Get keys from Google AI Studio.",
			"Cost tier: often has a useful free/low-cost path for beta testing.",
		],
	},
	{
		id: "nvidia_nim",
		label: "NVIDIA NIM",
		status: "Planned",
		description: "Use NVIDIA-hosted open models with your own API key.",
		href: "/settings/llm/nvidia_nim",
		guidance: [
			"Model examples: meta/llama-3.1-70b-instruct, qwen/qwen2.5-coder-32b-instruct",
			"Copy the model ID exactly from NVIDIA Build.",
			"Cost tier: depends on NIM credits/account plan.",
		],
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		status: "Planned",
		description: "Use OpenRouter to choose from many hosted models.",
		href: "/settings/llm/openrouter",
		guidance: [
			"Model examples: openai/gpt-4o-mini, anthropic/claude-3.5-sonnet, qwen/qwen-2.5-72b-instruct",
			"Base URL: https://openrouter.ai/api/v1",
			"Cost tier: varies by selected model; useful for power users.",
		],
	},
	{
		id: "groq",
		label: "Groq",
		status: "Fast",
		description: "Use Groq-hosted fast inference models for short insights.",
		href: "/settings/llm/groq",
		guidance: [
			"Model examples: llama-3.1-8b-instant, llama-3.3-70b-versatile, openai/gpt-oss-120b",
			"Base URL: https://api.groq.com/openai/v1",
			"Cost tier: free/cheap tiers can work, but large reasoning models may hit token limits.",
		],
	},
];

const MESSAGING_SETTINGS: SettingsCard[] = [
	{
		id: "telegram",
		label: "Telegram",
		status: "Planned",
		description:
			"Receive nutrition check-ins and future AI insights in Telegram.",
		href: "/settings/messaging/telegram",
	},
];

function settingsShell(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title} - ZorFit_MCP</title>
	<style>
		${ZORFIT_THEME_CSS}
		.shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
		nav {
			position: sticky;
			top: 0;
			z-index: 10;
			border-bottom: 1px solid rgba(245, 242, 236, 0.08);
			background: rgba(10, 10, 10, 0.82);
			backdrop-filter: blur(18px);
		}
		nav .shell {
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: 72px;
			gap: 18px;
		}
		.nav-links, .actions {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 10px;
		}
		button.danger { color: var(--red); }
		button:disabled { cursor: not-allowed; opacity: 0.52; }
		main { padding: 58px 0 76px; }
		.hero {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(280px, 0.42fr);
			gap: 30px;
			align-items: end;
			margin-bottom: 30px;
		}
		.eyebrow {
			color: var(--green);
			font-size: 0.76rem;
			font-weight: 820;
			letter-spacing: 0.12em;
			text-transform: uppercase;
		}
		h1 {
			margin: 14px 0 16px;
			font-size: clamp(3rem, 7vw, 6rem);
			line-height: 0.9;
		}
		h2, h3 { margin: 0; letter-spacing: 0; }
		p { color: var(--muted); line-height: 1.65; }
		.lede { max-width: 680px; margin: 0; font-size: 1.08rem; }
		.panel, .card {
			border: 1px solid rgba(245, 242, 236, 0.11);
			border-radius: 8px;
			background: linear-gradient(180deg, rgba(245, 242, 236, 0.065), rgba(245, 242, 236, 0.03));
		}
		.panel { padding: 18px; }
		.section { margin-top: 30px; }
		.section-head {
			display: flex;
			justify-content: space-between;
			align-items: end;
			gap: 18px;
			margin-bottom: 14px;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
			gap: 14px;
		}
		.card {
			display: flex;
			flex-direction: column;
			min-height: 210px;
			padding: 18px;
		}
		.card p { margin: 10px 0 18px; font-size: 0.94rem; }
		.guidance {
			display: grid;
			gap: 7px;
			margin: 0 0 18px;
			padding: 0;
			list-style: none;
		}
		.guidance li {
			color: var(--muted);
			font-size: 0.82rem;
			line-height: 1.45;
		}
		.status {
			display: inline-flex;
			align-self: flex-start;
			align-items: center;
			min-height: 25px;
			padding: 0 10px;
			border: 1px solid rgba(245, 242, 236, 0.12);
			border-radius: 999px;
			background: rgba(245, 242, 236, 0.05);
			color: var(--green);
			font-size: 0.72rem;
			font-weight: 820;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}
		.card .button { margin-top: auto; }
		label {
			display: block;
			margin: 14px 0 7px;
			color: var(--soft);
			font-size: 0.82rem;
			font-weight: 780;
		}
		input, select, textarea {
			width: 100%;
			min-height: 44px;
			border: 1px solid rgba(245, 242, 236, 0.12);
			border-radius: 8px;
			background: rgba(245, 242, 236, 0.06);
			color: var(--text);
			padding: 10px 12px;
			font: inherit;
		}
		textarea { min-height: 94px; resize: vertical; }
		textarea.large-textarea { min-height: 220px; }
		.field-meta {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			margin: 14px 0 7px;
		}
		.field-meta label { margin: 0; }
		.count {
			color: var(--muted);
			font-size: 0.8rem;
			font-weight: 760;
		}
		.row {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 12px;
		}
		.helper {
			margin-top: 14px;
			padding: 12px;
			border: 1px solid rgba(255, 92, 26, 0.28);
			border-radius: 8px;
			background: rgba(255, 92, 26, 0.065);
			color: var(--muted);
			font-size: 0.9rem;
		}
		.qr-link-panel {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 16px;
			align-items: center;
		}
		.qr-link-panel img {
			width: 156px;
			height: 156px;
			padding: 8px;
			border-radius: 8px;
			background: #fff;
		}
		.qr-link-panel p { margin: 0 0 10px; }
		.qr-link-panel .button { margin-top: 6px; }
		form .actions, .panel > .actions { margin-top: 18px; }
		.section > .actions { margin: 0 0 14px; }
		.time-row { align-items: end; margin-top: 10px; }
		.checkbox-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
			gap: 10px;
			margin-top: 10px;
		}
		.check-card {
			display: flex;
			align-items: flex-start;
			gap: 10px;
			min-height: 72px;
			padding: 12px;
			border: 1px solid rgba(245, 242, 236, 0.1);
			border-radius: 8px;
			background: rgba(245, 242, 236, 0.04);
		}
		.check-card input {
			width: auto;
			min-height: auto;
			margin-top: 4px;
		}
		.check-card span {
			display: block;
			color: var(--text);
			font-weight: 780;
		}
		.check-card small {
			display: block;
			margin-top: 3px;
			color: var(--muted);
			line-height: 1.35;
		}
		.schedule-card {
			margin-top: 16px;
			padding: 18px;
		}
		.schedule-card.collapsed .schedule-body {
			display: none;
		}
		.schedule-head {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			align-items: flex-start;
			margin-bottom: 12px;
		}
		.schedule-head button {
			min-height: 34px;
			padding: 7px 10px;
		}
		.schedule-title {
			display: grid;
			gap: 7px;
		}
		.schedule-title-row {
			display: flex;
			align-items: center;
			gap: 10px;
			flex-wrap: wrap;
		}
		.schedule-title h3 {
			font-size: 1.15rem;
			line-height: 1.2;
		}
		.question-bank {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 10px;
		}
		.question-bank button {
			min-height: 34px;
			padding: 7px 10px;
			font-size: 0.78rem;
		}
		.chat-window {
			display: grid;
			gap: 12px;
			min-height: 340px;
			align-content: start;
			padding: 16px;
			border: 1px solid rgba(245, 242, 236, 0.1);
			border-radius: 8px;
			background: rgba(0, 0, 0, 0.22);
		}
		.chat-message {
			max-width: 86%;
			padding: 12px 14px;
			border-radius: 8px;
			background: rgba(245, 242, 236, 0.06);
			color: var(--soft);
			white-space: pre-wrap;
			line-height: 1.55;
		}
		.chat-message.user {
			justify-self: end;
			background: rgba(180, 255, 44, 0.12);
		}
		.score-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 14px;
		}
		.score-card {
			position: relative;
			padding: 16px;
			min-height: 150px;
		}
		.score-card strong {
			display: block;
			color: var(--muted);
			font-size: 0.78rem;
			font-weight: 820;
			letter-spacing: 0.1em;
			text-transform: uppercase;
		}
		.score-value {
			margin-top: 14px;
			color: var(--green);
			font-size: 2.8rem;
			font-weight: 920;
			line-height: 0.9;
		}
		.score-card p { margin: 12px 0 0; font-size: 0.9rem; }
		.score-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
		}
		.score-help {
			position: relative;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 24px;
			height: 24px;
			border: 1px solid rgba(245, 242, 236, 0.16);
			border-radius: 999px;
			color: var(--green);
			font-size: 0.8rem;
			font-weight: 900;
			cursor: help;
		}
		.score-tooltip {
			position: absolute;
			top: 34px;
			right: 0;
			z-index: 4;
			display: none;
			width: min(320px, calc(100vw - 64px));
			padding: 12px;
			border: 1px solid rgba(245, 242, 236, 0.14);
			border-radius: 8px;
			background: #111;
			box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
			color: var(--muted);
			font-size: 0.8rem;
			font-weight: 640;
			letter-spacing: 0;
			line-height: 1.45;
			text-transform: none;
		}
		.score-help:hover .score-tooltip,
		.score-help:focus .score-tooltip {
			display: block;
		}
		.score-tooltip ul {
			margin: 0;
			padding-left: 16px;
		}
		.score-tooltip li { margin: 4px 0; }
		.motivation {
			margin-top: 18px;
			padding: 18px;
			border: 1px solid rgba(180, 255, 44, 0.24);
			border-radius: 8px;
			background: rgba(180, 255, 44, 0.075);
		}
		.motivation h3 { margin-bottom: 8px; }
		.motivation p { margin: 0; }
		.timeline {
			position: relative;
			display: grid;
			gap: 18px;
			margin-top: 20px;
			padding: 4px 0;
		}
		.timeline::before {
			content: "";
			position: absolute;
			left: 10px;
			top: 10px;
			bottom: 10px;
			width: 2px;
			background: rgba(245, 242, 236, 0.14);
		}
		.timeline-item {
			position: relative;
			padding-left: 36px;
		}
		.timeline-dot {
			position: absolute;
			left: 4px;
			top: 5px;
			width: 14px;
			height: 14px;
			border: 2px solid #0a0a0a;
			border-radius: 999px;
			background: var(--green);
			box-shadow: 0 0 0 3px rgba(180, 255, 44, 0.14);
		}
		.timeline-dot.pending {
			background: var(--orange);
			box-shadow: 0 0 0 3px rgba(255, 92, 26, 0.13);
		}
		.timeline-dot.empty {
			background: rgba(245, 242, 236, 0.45);
			box-shadow: none;
		}
		.timeline-time {
			color: var(--green);
			font-size: 0.76rem;
			font-weight: 840;
			letter-spacing: 0.1em;
			text-transform: uppercase;
		}
		.timeline-title {
			margin: 3px 0 5px;
			color: var(--text);
			font-size: 1.05rem;
			font-weight: 860;
		}
		.timeline-summary {
			margin: 0;
			color: var(--muted);
			line-height: 1.55;
		}
		.timeline-badge {
			display: inline-flex;
			margin-left: 8px;
			color: var(--muted);
			font-size: 0.7rem;
			font-weight: 820;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}
		.controls-grid, .kpi-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
			gap: 14px;
		}
		.controls-grid .check-card { min-height: 58px; }
		.kpi-card {
			padding: 16px;
			min-height: 160px;
		}
		.kpi-card strong {
			color: var(--muted);
			font-size: 0.76rem;
			font-weight: 840;
			letter-spacing: 0.1em;
			text-transform: uppercase;
		}
		.kpi-value {
			margin-top: 12px;
			color: var(--text);
			font-size: 2.35rem;
			font-weight: 920;
			line-height: 0.95;
		}
		.kpi-card p { margin: 10px 0 0; font-size: 0.88rem; }
		.kpi-trend {
			display: inline-flex;
			margin-top: 12px;
			color: var(--green);
			font-size: 0.78rem;
			font-weight: 820;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}
		.feature-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
			gap: 14px;
		}
		.feature-card {
			padding: 18px;
			min-height: 190px;
		}
		.feature-card h3 {
			margin-top: 10px;
			font-size: 1.25rem;
		}
		.feature-card p {
			margin: 10px 0 0;
			font-size: 0.94rem;
		}
		.feature-card .status {
			margin-bottom: 4px;
		}
		.freshness {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 14px 16px;
			border: 1px solid rgba(200, 245, 66, 0.22);
			border-radius: 8px;
			background: rgba(200, 245, 66, 0.07);
		}
		.freshness span {
			color: var(--green);
			font-family: "Space Mono", monospace;
			font-size: 0.78rem;
			font-weight: 820;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}
		.progress-list {
			display: grid;
			gap: 14px;
		}
		.progress-row {
			display: grid;
			grid-template-columns: minmax(130px, 0.45fr) minmax(160px, 1fr) auto;
			gap: 12px;
			align-items: center;
		}
		.progress-row strong,
		.progress-row small {
			display: block;
		}
		.progress-row small {
			margin-top: 4px;
			color: var(--muted);
			font-size: 0.78rem;
			line-height: 1.35;
		}
		.progress-track {
			height: 10px;
			overflow: hidden;
			border-radius: 999px;
			background: rgba(245, 242, 236, 0.09);
		}
		.progress-track span {
			display: block;
			height: 100%;
			border-radius: inherit;
			background: linear-gradient(90deg, var(--green), var(--amber));
		}
		.metric-value {
			color: var(--green);
			font-family: "Space Mono", monospace;
			font-size: 0.9rem;
			font-weight: 820;
			white-space: nowrap;
		}
		.bar-chart {
			display: grid;
			grid-template-columns: repeat(7, minmax(20px, 1fr));
			align-items: end;
			gap: 10px;
			height: 210px;
			padding-top: 10px;
		}
		.bar-column {
			display: grid;
			grid-template-rows: 1fr auto;
			gap: 8px;
			height: 100%;
		}
		.bar-column i {
			align-self: end;
			min-height: 12px;
			border-radius: 8px 8px 0 0;
			background: linear-gradient(180deg, var(--green), rgba(200, 245, 66, 0.32));
		}
		.bar-column small,
		.chart-legend {
			color: var(--muted);
			font-family: "Space Mono", monospace;
			font-size: 0.72rem;
			text-align: center;
		}
		.score-ring {
			display: grid;
			width: min(220px, 100%);
			aspect-ratio: 1;
			margin: 0 auto;
			place-items: center;
			border-radius: 999px;
			background:
				radial-gradient(circle at center, var(--panel) 0 58%, transparent 59%),
				conic-gradient(var(--green) var(--score), rgba(245, 242, 236, 0.1) 0);
		}
		.score-ring strong {
			display: block;
			color: var(--text);
			font-size: 2.4rem;
			text-align: center;
		}
		.score-ring span {
			display: block;
			width: 140px;
			color: var(--muted);
			font-size: 0.86rem;
			line-height: 1.35;
			text-align: center;
		}
		.chart-panel svg {
			width: 100%;
			height: auto;
			overflow: visible;
		}
		.chart-panel text {
			fill: var(--muted);
			font-family: "Space Mono", monospace;
			font-size: 12px;
		}
		.chart-grid-line {
			stroke: rgba(245, 242, 236, 0.1);
			stroke-width: 1;
		}
		.pattern-list {
			display: grid;
			gap: 12px;
		}
		.pattern-card {
			padding: 16px;
			border: 1px solid rgba(245, 242, 236, 0.1);
			border-radius: 8px;
			background: rgba(245, 242, 236, 0.04);
		}
		.pattern-card strong,
		.pattern-card small {
			display: block;
		}
		.pattern-card small {
			color: var(--green);
			font-family: "Space Mono", monospace;
			font-size: 0.72rem;
			font-weight: 820;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}
		.report-preview {
			overflow: auto;
			margin: 0;
			padding: 16px;
			border: 1px solid rgba(245, 242, 236, 0.1);
			border-radius: 8px;
			background: rgba(0, 0, 0, 0.25);
			color: var(--muted);
			font: 0.92rem/1.6 "Space Mono", monospace;
		}
		#message { min-height: 24px; margin-top: 14px; color: var(--green); font-weight: 760; }
		footer {
			padding: 36px 0;
			border-top: 1px solid rgba(245, 242, 236, 0.08);
			color: var(--muted);
		}
		footer .shell {
			display: flex;
			justify-content: space-between;
			gap: 18px;
			flex-wrap: wrap;
		}
		@media (max-width: 760px) {
			.hero, .row, .qr-link-panel { grid-template-columns: 1fr; }
			nav .shell { align-items: flex-start; flex-direction: column; padding: 14px 0; }
			h1 { font-size: clamp(3rem, 18vw, 4.2rem); }
			.progress-row { grid-template-columns: 1fr; }
			.metric-value { white-space: normal; }
		}
	</style>
</head>
<body>
	<nav>
		<div class="shell">
			<a class="brand" href="/">
				${ZORFIT_BRAND}
			</a>
			<div class="nav-links">
				<a class="button" href="/my-day">My day</a>
				<a class="button" href="/my-week">My week</a>
				<a class="button" href="/my-fitness">Fitness</a>
				<a class="button" href="/settings">Settings</a>
				<a class="button" href="/connections">Connections</a>
				<a class="button" href="/coach">Coach chat</a>
				<a class="button" href="/diagnostics">Diagnostics</a>
				<a class="button" href="/reports">Reports</a>
			</div>
		</div>
	</nav>
	${body}
	<footer>
		<div class="shell">
			<span>ZorFit settings</span>
			<span>Credentials are encrypted when active saving is enabled.</span>
		</div>
	</footer>
</body>
</html>`;
}

function renderSettingsCards(cards: SettingsCard[]): string {
	return cards
		.map(
			(card) => `<a class="card" href="${card.href}">
				<span class="status">${card.status}</span>
				<h3>${card.label}</h3>
				<p>${card.description}</p>
				${card.guidance?.length ? `<ul class="guidance">${card.guidance.map((item) => `<li>${item}</li>`).join("")}</ul>` : ""}
				<span class="button">Manage</span>
			</a>`,
		)
		.join("");
}

function statusLabel(source?: "user_d1" | "worker_secret" | "missing"): string {
	if (source === "user_d1") return "Connected";
	if (source === "worker_secret") return "Server connected";
	return "Not connected";
}

async function getSettingsSession(c: {
	req: { header: (name: string) => string | undefined };
	env: Env;
}): Promise<Props | null> {
	const sessionCookie = c.req.header("Cookie");
	const sessionToken = sessionCookie?.match(/session=([^;]+)/)?.[1];
	if (!sessionToken) return null;
	const sessionData = await c.env.OAUTH_KV.get(
		`session:${sessionToken}`,
		"json",
	);
	if (
		!sessionData ||
		typeof sessionData !== "object" ||
		!("login" in sessionData)
	)
		return null;
	return sessionData as Props;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function timezoneOffsetLabel(timeZone: string, now = new Date()): string {
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			timeZoneName: "shortOffset",
		});
		return (
			formatter.formatToParts(now).find((part) => part.type === "timeZoneName")
				?.value ?? "GMT"
		);
	} catch {
		return "GMT";
	}
}

function timezoneOptions(selected: string): string {
	const fallback = [
		"UTC",
		"America/New_York",
		"America/Chicago",
		"America/Denver",
		"America/Los_Angeles",
		"America/Toronto",
		"Europe/London",
		"Europe/Berlin",
		"Asia/Dubai",
		"Asia/Kolkata",
		"Asia/Singapore",
		"Asia/Tokyo",
		"Australia/Sydney",
	];
	const intlWithSupportedValues = Intl as typeof Intl & {
		supportedValuesOf?: (key: "timeZone") => string[];
	};
	const zones =
		typeof intlWithSupportedValues.supportedValuesOf === "function"
			? intlWithSupportedValues.supportedValuesOf("timeZone")
			: fallback;
	return Array.from(new Set([selected, ...zones]))
		.filter(Boolean)
		.map((zone) => {
			const label = `${zone.replace(/_/g, " ")} (${timezoneOffsetLabel(zone)})`;
			return `<option value="${escapeHtml(zone)}" ${zone === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
		})
		.join("");
}

async function getPreferredAiConnectionForSession(env: Env, session: Props) {
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

function localDateForTimezone(timezone: string, now = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: normalizeTimezone(timezone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

function localDateTimeForTimezone(
	timezone: string,
	now = new Date(),
): { date: string; time: string } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: normalizeTimezone(timezone),
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

function minutesFromTime(time: string): number {
	const [hour, minute] = time.split(":").map(Number);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
	return hour * 60 + minute;
}

function categoryLabel(category: string): string {
	return (
		HEALTH_CATEGORIES.find((item) => item.id === category)?.label ??
		category.replace(/_/g, " ")
	);
}

function configuredCategories(
	schedules: UserMessageSchedule[],
): HealthDataCategory[] {
	const selected = schedules.flatMap((schedule) => schedule.categories);
	const known = selected.filter((category): category is HealthDataCategory =>
		HEALTH_CATEGORIES.some((item) => item.id === category),
	);
	return Array.from(
		new Set([
			...known,
			"nutrition",
			"hrv",
			"sleep",
			"fitness_activities",
			"gym_workouts",
			"steps",
			"recovery",
		] satisfies HealthDataCategory[]),
	);
}

function contextFor(
	context: HealthContextBundle,
	category: HealthDataCategory,
): CategoryContext | undefined {
	return context.categories.find((item) => item.category === category);
}

function scoreBand(score: number): string {
	if (score >= 85) return "Strong";
	if (score >= 70) return "On track";
	if (score >= 55) return "Needs attention";
	return "Set up data";
}

function boundedScore(score: number): number {
	return Math.max(0, Math.min(100, Math.round(score)));
}

function safeRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numberFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function arrayFrom(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const record = safeRecord(value);
	if (!record) return [];
	if (Array.isArray(record.days)) return record.days;
	if (Array.isArray(record.data)) return record.data;
	if (Array.isArray(record.items)) return record.items;
	if (Array.isArray(record.results)) return record.results;
	if (Array.isArray(record.activities)) return record.activities;
	if (Array.isArray(record.workouts)) return record.workouts;
	return [];
}

function valueByKeyPattern(
	value: unknown,
	pattern: RegExp,
	seen = new Set<unknown>(),
): number | undefined {
	if (!value || typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = valueByKeyPattern(item, pattern, seen);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (pattern.test(key)) {
			const direct = numberFrom(child);
			if (direct !== undefined) return direct;
		}
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = valueByKeyPattern(child, pattern, seen);
		if (found !== undefined) return found;
	}
	return undefined;
}

function average(values: number[]): number | undefined {
	const clean = values.filter((value) => Number.isFinite(value));
	if (!clean.length) return undefined;
	return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function percentDelta(current: number | undefined, baseline: number | undefined): number | undefined {
	if (current === undefined || baseline === undefined || baseline === 0)
		return undefined;
	return ((current - baseline) / baseline) * 100;
}

function trendPhrase(delta: number | undefined, unit = "%"): string {
	if (delta === undefined) return "trend unavailable";
	const rounded = Math.round(delta);
	if (rounded === 0) return `flat vs baseline`;
	return `${rounded > 0 ? "+" : ""}${rounded}${unit} vs baseline`;
}

function trendLabel(delta: number | undefined, lowerIsBetter = false): string {
	if (delta === undefined || Math.abs(delta) < 3) return "staying flat";
	const improving = lowerIsBetter ? delta < 0 : delta > 0;
	return improving ? "trending better" : "trending down";
}

function formatMetric(value: number | undefined, suffix = ""): string {
	if (value === undefined || Number.isNaN(value)) return "No data";
	return `${Math.round(value * 10) / 10}${suffix}`;
}

function coefficientOfVariation(values: number[]): number | undefined {
	const mean = average(values);
	if (mean === undefined || mean === 0) return undefined;
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
	return (Math.sqrt(variance) / mean) * 100;
}

interface ScorePreferences {
	nutritionWeight: number;
	readinessWeight: number;
	fitnessWeight: number;
	proteinTargetG: number;
	sugarLimitG: number;
	fiberTargetG: number;
	sleepTargetHours: number;
}

const DEFAULT_SCORE_PREFERENCES: ScorePreferences = {
	nutritionWeight: 35,
	readinessWeight: 35,
	fitnessWeight: 30,
	proteinTargetG: 100,
	sugarLimitG: 25,
	fiberTargetG: 25,
	sleepTargetHours: 7,
};

async function getScorePreferences(
	env: Env,
	session: Pick<Props, "login" | "name" | "email">,
): Promise<ScorePreferences> {
	const userId = await ensureUser(env, session);
	const row = await env.ZORFIT_DB.prepare(
		`SELECT nutrition_weight, readiness_weight, fitness_weight, protein_target_g, sugar_limit_g, fiber_target_g, sleep_target_hours
		 FROM user_score_preferences
		 WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{
			nutrition_weight: number;
			readiness_weight: number;
			fitness_weight: number;
			protein_target_g: number;
			sugar_limit_g: number;
			fiber_target_g: number;
			sleep_target_hours: number;
		}>();
	if (!row) return DEFAULT_SCORE_PREFERENCES;
	return {
		nutritionWeight: row.nutrition_weight,
		readinessWeight: row.readiness_weight,
		fitnessWeight: row.fitness_weight,
		proteinTargetG: row.protein_target_g,
		sugarLimitG: row.sugar_limit_g,
		fiberTargetG: row.fiber_target_g,
		sleepTargetHours: row.sleep_target_hours,
	};
}

async function upsertScorePreferences(
	env: Env,
	session: Pick<Props, "login" | "name" | "email">,
	preferences: ScorePreferences,
): Promise<void> {
	const userId = await ensureUser(env, session);
	await env.ZORFIT_DB.prepare(
		`INSERT INTO user_score_preferences
		   (user_id, nutrition_weight, readiness_weight, fitness_weight, protein_target_g, sugar_limit_g, fiber_target_g, sleep_target_hours, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   nutrition_weight = excluded.nutrition_weight,
		   readiness_weight = excluded.readiness_weight,
		   fitness_weight = excluded.fitness_weight,
		   protein_target_g = excluded.protein_target_g,
		   sugar_limit_g = excluded.sugar_limit_g,
		   fiber_target_g = excluded.fiber_target_g,
		   sleep_target_hours = excluded.sleep_target_hours,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			userId,
			preferences.nutritionWeight,
			preferences.readinessWeight,
			preferences.fitnessWeight,
			preferences.proteinTargetG,
			preferences.sugarLimitG,
			preferences.fiberTargetG,
			preferences.sleepTargetHours,
			new Date().toISOString(),
		)
		.run();
}

interface MacroDay {
	date?: string;
	calories?: number;
	protein?: number;
	carbs?: number;
	fat?: number;
	sugar?: number;
	fiber?: number;
}

function macroDayFrom(value: unknown): MacroDay | null {
	const record = safeRecord(value);
	if (!record) return null;
	const macros = safeRecord(record.macroSummary) ?? safeRecord(record.summary);
	if (!macros) return null;
	return {
		date: typeof record.date === "string" ? record.date : undefined,
		calories: numberFrom(macros.calories_kcal ?? macros.calories ?? macros.energy),
		protein: numberFrom(macros.protein_g ?? macros.protein ?? macros.proteinG),
		carbs: numberFrom(macros.carbs_g ?? macros.carbs ?? macros.carbohydrates),
		fat: numberFrom(macros.fat_g ?? macros.fat ?? macros.fatG),
		sugar: numberFrom(macros.sugar_g ?? macros.sugar ?? macros.sugars),
		fiber: numberFrom(macros.fiber_g ?? macros.fiber),
	};
}

function nutritionDays(context: HealthContextBundle): MacroDay[] {
	const nutrition = contextFor(context, "nutrition");
	const data = nutrition?.data;
	const rows = arrayFrom(data);
	if (rows.length) return rows.map(macroDayFrom).filter(Boolean) as MacroDay[];
	const single = macroDayFrom(data);
	return single ? [single] : [];
}

function nutritionMacroLine(context: HealthContextBundle): string | null {
	const days = nutritionDays(context);
	const day = days[days.length - 1];
	if (!day) return null;
	const parts = [
		day.calories !== undefined ? `${Math.round(day.calories)} kcal` : "",
		day.protein !== undefined ? `${Math.round(day.protein)}g protein` : "",
		day.carbs !== undefined ? `${Math.round(day.carbs)}g carbs` : "",
		day.fat !== undefined ? `${Math.round(day.fat)}g fat` : "",
		day.sugar !== undefined ? `${Math.round(day.sugar)}g sugar` : "",
	].filter(Boolean);
	return parts.length ? parts.join(" · ") : null;
}

interface ScoreBreakdown {
	score: number;
	details: string[];
}

interface ScoreSummary {
	overall: ScoreBreakdown;
	nutrition: ScoreBreakdown;
	readiness: ScoreBreakdown;
	fitness: ScoreBreakdown;
}

function nutritionScore(
	context: HealthContextBundle,
	preferences: ScorePreferences,
): ScoreBreakdown {
	const nutrition = contextFor(context, "nutrition");
	if (nutrition?.status !== "ready") {
		return {
			score: 42,
			details: ["Cronometer data is missing, unavailable, or not routed to nutrition."],
		};
	}
	const days = nutritionDays(context).filter(
		(day) => day.calories !== undefined || day.protein !== undefined,
	);
	if (!days.length) {
		return {
			score: 58,
			details: ["Cronometer responded, but no calorie or macro totals were found."],
		};
	}
	const today = days[days.length - 1] as MacroDay;
	const previous = days.slice(0, -1);
	const baselineProtein = average(previous.map((day) => day.protein ?? Number.NaN));
	const baselineSugar = average(previous.map((day) => day.sugar ?? Number.NaN));
	const baselineCalories = average(previous.map((day) => day.calories ?? Number.NaN));
	const proteinDelta = percentDelta(today.protein, baselineProtein);
	const sugarDelta = percentDelta(today.sugar, baselineSugar);
	let score = 68;
	const details = [
		`7-day nutrition window found ${days.length}/7 logged day${days.length === 1 ? "" : "s"}.`,
	];
	score += Math.min(10, Math.max(-12, (days.length - 4) * 3));
	if (today.protein !== undefined) {
		if (
			today.protein >= preferences.proteinTargetG ||
			(baselineProtein && today.protein >= baselineProtein * 0.9)
		) {
			score += 9;
			details.push(`Protein is ${Math.round(today.protein)}g, ${trendPhrase(proteinDelta)}.`);
		} else {
			score -= 9;
			details.push(`Protein is ${Math.round(today.protein)}g, below the ${preferences.proteinTargetG}g target/recent baseline.`);
		}
	} else {
		score -= 8;
		details.push("Protein total is missing.");
	}
	if (today.sugar !== undefined) {
		if (
			today.sugar <= preferences.sugarLimitG ||
			(baselineSugar && today.sugar <= baselineSugar * 1.05)
		) {
			score += 7;
			details.push(`Sugar is ${Math.round(today.sugar)}g, controlled against the 7-day baseline.`);
		} else {
			score -= today.sugar > 50 ? 12 : 7;
			details.push(`Sugar is ${Math.round(today.sugar)}g, above the ${preferences.sugarLimitG}g limit and ${trendPhrase(sugarDelta)}.`);
		}
	}
	if (today.fiber !== undefined) {
		if (today.fiber >= preferences.fiberTargetG) {
			score += 5;
			details.push(`Fiber is ${Math.round(today.fiber)}g, in a strong range.`);
		} else {
			score -= 4;
			details.push(`Fiber is ${Math.round(today.fiber)}g; target is ${preferences.fiberTargetG}g.`);
		}
	}
	if (today.calories !== undefined && baselineCalories) {
		const calorieDelta = Math.abs(percentDelta(today.calories, baselineCalories) ?? 0);
		score += calorieDelta <= 35 ? 4 : -6;
		details.push(`Calories are ${Math.round(today.calories)} kcal, ${trendPhrase(percentDelta(today.calories, baselineCalories))}.`);
	}
	return { score: boundedScore(score), details };
}

function metricSeries(
	context: HealthContextBundle,
	category: HealthDataCategory,
	pattern: RegExp,
): number[] {
	const source = contextFor(context, category);
	return arrayFrom(source?.data)
		.map((item) => valueByKeyPattern(item, pattern))
		.filter((value): value is number => value !== undefined);
}

function readinessScore(
	context: HealthContextBundle,
	preferences: ScorePreferences,
): ScoreBreakdown {
	const hrv = [
		...metricSeries(context, "hrv", /^(hrv|hrv_rmssd|rmssd|hrv_sdnn)$/i),
		...metricSeries(context, "recovery", /^(hrv|hrv_rmssd|rmssd|hrv_sdnn)$/i),
	];
	const sleepSeconds = [
		...metricSeries(context, "sleep", /sleep.*(sec|duration|total)|total_sleep|sleep_secs/i),
		...metricSeries(context, "recovery", /sleep.*(sec|duration|total)|total_sleep|sleep_secs/i),
	];
	const restingHr = [
		...metricSeries(context, "hrv", /resting.*hr|resting.*heart|resting_heartrate|restingHR/i),
		...metricSeries(context, "recovery", /resting.*hr|resting.*heart|resting_heartrate|restingHR/i),
	];
	const latestHrv = hrv[hrv.length - 1];
	const hrvBaseline = average(hrv.slice(0, -1));
	const latestSleepHours =
		sleepSeconds[sleepSeconds.length - 1] !== undefined
			? (sleepSeconds[sleepSeconds.length - 1] as number) / 3600
			: undefined;
	const sleepBaselineSeconds = average(sleepSeconds.slice(0, -1));
	const sleepBaselineHours =
		sleepBaselineSeconds !== undefined ? sleepBaselineSeconds / 3600 : undefined;
	const latestRestingHr = restingHr[restingHr.length - 1];
	const restingHrBaseline = average(restingHr.slice(0, -1));
	let score = hrv.length || sleepSeconds.length ? 68 : 48;
	const details = [
		`Readiness uses ${hrv.length} HRV point${hrv.length === 1 ? "" : "s"} and ${sleepSeconds.length} sleep point${sleepSeconds.length === 1 ? "" : "s"} from the recent window.`,
	];
	const hrvDelta = percentDelta(latestHrv, hrvBaseline);
	if (latestHrv !== undefined && hrvDelta !== undefined) {
		if (hrvDelta >= 5) score += 14;
		else if (hrvDelta >= -5) score += 6;
		else if (hrvDelta < -12) score -= 16;
		else score -= 8;
		details.push(`HRV latest ${Math.round(latestHrv)} ms, ${trendPhrase(hrvDelta)}.`);
	} else {
		score -= 5;
		details.push("HRV trend is incomplete.");
	}
	if (latestSleepHours !== undefined) {
		if (latestSleepHours >= preferences.sleepTargetHours) score += 11;
		else if (latestSleepHours >= preferences.sleepTargetHours - 1) score += 2;
		else score -= 12;
		const sleepDelta = percentDelta(latestSleepHours, sleepBaselineHours);
		details.push(`Sleep latest ${latestSleepHours.toFixed(1)}h vs ${preferences.sleepTargetHours}h target, ${trendPhrase(sleepDelta)}.`);
	} else {
		score -= 5;
		details.push("Sleep duration trend is incomplete.");
	}
	const restingDelta = percentDelta(latestRestingHr, restingHrBaseline);
	if (latestRestingHr !== undefined && restingDelta !== undefined) {
		score += restingDelta <= 3 ? 5 : -7;
		details.push(`Resting HR latest ${Math.round(latestRestingHr)} bpm, ${trendPhrase(restingDelta)}.`);
	}
	return { score: boundedScore(score), details };
}

function activityLoadFrom(value: unknown): number | undefined {
	return (
		valueByKeyPattern(value, /training.*load|icu.*load|suffer|strain|trimp/i) ??
		valueByKeyPattern(value, /kilojoule|calorie|moving.*time|elapsed.*time|distance/i)
	);
}

function fitnessScore(context: HealthContextBundle): ScoreBreakdown {
	const activities = [
		...arrayFrom(contextFor(context, "fitness_activities")?.data),
		...arrayFrom(contextFor(context, "gym_workouts")?.data),
		...arrayFrom(contextFor(context, "steps")?.data),
	];
	if (!activities.length) {
		return {
			score: 50,
			details: ["No recent activity, gym, or steps data was returned by routed sources."],
		};
	}
	const loads = activities
		.map(activityLoadFrom)
		.filter((value): value is number => value !== undefined && value > 0);
	const latestLoad = loads[loads.length - 1];
	const baselineLoad = average(loads.slice(0, -1));
	const loadDelta = percentDelta(latestLoad, baselineLoad);
	let score = 62;
	const details = [
		`Fitness uses ${activities.length} recent activity/workout record${activities.length === 1 ? "" : "s"}.`,
	];
	if (activities.length >= 5) score += 12;
	else if (activities.length >= 3) score += 8;
	else score -= 6;
	if (latestLoad !== undefined && loadDelta !== undefined) {
		if (loadDelta > 80) score -= 8;
		else if (loadDelta >= -25 && loadDelta <= 50) score += 8;
		else score += 2;
		details.push(`Latest load proxy ${Math.round(latestLoad)}, ${trendPhrase(loadDelta)}.`);
	} else {
		details.push("Training load proxy is limited, so activity count is weighted more heavily.");
	}
	return { score: boundedScore(score), details };
}

function scoreSummary(
	context: HealthContextBundle,
	preferences: ScorePreferences,
): ScoreSummary {
	const nutrition = nutritionScore(context, preferences);
	const readiness = readinessScore(context, preferences);
	const fitness = fitnessScore(context);
	const totalWeight =
		preferences.nutritionWeight +
		preferences.readinessWeight +
		preferences.fitnessWeight;
	const overallValue =
		totalWeight > 0
			? (nutrition.score * preferences.nutritionWeight +
					readiness.score * preferences.readinessWeight +
					fitness.score * preferences.fitnessWeight) /
				totalWeight
			: (nutrition.score + readiness.score + fitness.score) / 3;
	return {
		nutrition,
		readiness,
		fitness,
		overall: {
			score: boundedScore(overallValue),
			details: [
				`Weighted score = nutrition ${preferences.nutritionWeight}% (${nutrition.score}), readiness ${preferences.readinessWeight}% (${readiness.score}), fitness ${preferences.fitnessWeight}% (${fitness.score}).`,
				"Each component uses the recent routed data window where available.",
			],
		},
	};
}

interface KpiCard {
	label: string;
	value: string;
	bottomLine: string;
	trend: string;
}

function renderKpiCard(card: KpiCard): string {
	return `<article class="panel kpi-card">
		<strong>${escapeHtml(card.label)}</strong>
		<div class="kpi-value">${escapeHtml(card.value)}</div>
		<p>${escapeHtml(card.bottomLine)}</p>
		<span class="kpi-trend">${escapeHtml(card.trend)}</span>
	</article>`;
}

function myDayKpis(context: HealthContextBundle): KpiCard[] {
	const rhr = [
		...metricSeries(context, "hrv", /resting.*hr|resting.*heart|resting_heartrate|restingHR/i),
		...metricSeries(context, "recovery", /resting.*hr|resting.*heart|resting_heartrate|restingHR/i),
	];
	const hrv = [
		...metricSeries(context, "hrv", /^(hrv|hrv_rmssd|rmssd|hrv_sdnn)$/i),
		...metricSeries(context, "recovery", /^(hrv|hrv_rmssd|rmssd|hrv_sdnn)$/i),
	];
	const sleepSeconds = [
		...metricSeries(context, "sleep", /sleep.*(sec|duration|total)|total_sleep|sleep_secs/i),
		...metricSeries(context, "recovery", /sleep.*(sec|duration|total)|total_sleep|sleep_secs/i),
	];
	const sleepHours = sleepSeconds.map((value) => value / 3600);
	const rhrDelta = percentDelta(rhr[rhr.length - 1], average(rhr.slice(0, -1)));
	const hrvDelta = percentDelta(hrv[hrv.length - 1], average(hrv.slice(0, -1)));
	const sleepDelta = percentDelta(
		sleepHours[sleepHours.length - 1],
		average(sleepHours.slice(0, -1)),
	);
	return [
		{
			label: "Resting heart rate",
			value: formatMetric(rhr[rhr.length - 1], " bpm"),
			bottomLine: `7-day avg ${formatMetric(average(rhr), " bpm")}`,
			trend: trendLabel(rhrDelta, true),
		},
		{
			label: "HRV",
			value: formatMetric(hrv[hrv.length - 1], " ms"),
			bottomLine: `7-day avg ${formatMetric(average(hrv), " ms")} · CV ${formatMetric(coefficientOfVariation(hrv), "%")}`,
			trend: trendLabel(hrvDelta),
		},
		{
			label: "Sleep time",
			value: formatMetric(sleepHours[sleepHours.length - 1], "h"),
			bottomLine: `7-day avg ${formatMetric(average(sleepHours), "h")}`,
			trend: trendLabel(sleepDelta),
		},
	];
}

function cronometerScoreValue(value: unknown, pattern: RegExp): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = cronometerScoreValue(item, pattern);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (pattern.test(key)) {
			const direct = numberFrom(child);
			if (direct !== undefined) return direct;
			const nested = valueByKeyPattern(child, /score|percent|value|amount/i);
			if (nested !== undefined) return nested;
		}
		const found = cronometerScoreValue(child, pattern);
		if (found !== undefined) return found;
	}
	return undefined;
}

function cronometerScoreCards(context: HealthContextBundle): KpiCard[] {
	const nutritionDaysList = nutritionDays(context);
	const latest = nutritionDaysList[nutritionDaysList.length - 1];
	const nutrition = contextFor(context, "nutrition");
	const data = safeRecord(nutrition?.data);
	const today = safeRecord(data?.today) ?? safeRecord(nutrition?.data);
	const scoreSource = safeRecord(today?.nutritionScores) ?? safeRecord(data?.nutritionScores);
	const definitions: Array<[string, RegExp]> = [
		["Overall", /overall|complete|score/i],
		["Minerals", /mineral/i],
		["Vitamins", /vitamin/i],
		["Antioxidants", /antioxidant/i],
		["Electrolytes", /electrolyte|sodium|potassium/i],
	];
	return definitions
		.map(([label, pattern]) => {
			const score = cronometerScoreValue(scoreSource, pattern);
			if (score === undefined) return null;
			return {
				label: `Cronometer ${label}`,
				value: formatMetric(score, score <= 1 ? "" : "%"),
				bottomLine: latest?.date ? `Latest nutrition score for ${latest.date}` : "Latest nutrition score",
				trend: "from Cronometer",
			} satisfies KpiCard;
		})
		.filter(Boolean) as KpiCard[];
}

function motivationalMessage(scores: ScoreSummary): string {
	if (scores.overall.score >= 80) {
		return "You are stacking good signals today. Keep the next decision simple: fuel well, move with intent, and protect tonight's sleep.";
	}
	if (scores.overall.score >= 65) {
		return "Today is still very steerable. One solid meal, one focused training choice, and one clean recovery habit can move the whole day up.";
	}
	return "No panic, just precision. Tighten the next four hours: hydrate, get protein in, take an easy walk, and make the next log count.";
}

interface MyDayTimelineItem {
	time: string;
	title: string;
	summary: string;
	status: "sent" | "pending" | "empty" | "event";
}

interface TimelineOptions {
	includeSentMessages: boolean;
	includeYesterdaySummary: boolean;
	includeEventTimeline: boolean;
}

function timelineSummaryFor(
	schedule: UserMessageSchedule,
	sent: boolean,
	log?: NotificationLogEntry,
): string {
	if (log?.messageSummary) return log.messageSummary;
	const categories = schedule.categories.length
		? schedule.categories.map(categoryLabel).join(", ")
		: "selected health data";
	if (sent) {
		return `Sent using ${categories}. Summary capture starts with newly delivered ZorFit messages.`;
	}
	return `Scheduled using ${categories}.`;
}

function buildMyDayTimeline(
	schedules: UserMessageSchedule[],
	logs: NotificationLogEntry[],
	context: HealthContextBundle,
	date: string,
	currentTime: string,
	options: TimelineOptions,
): MyDayTimelineItem[] {
	const currentMinutes = minutesFromTime(currentTime);
	const logMap = new Map(logs.map((log) => [log.scheduledFor, log]));
	const items: MyDayTimelineItem[] = options.includeSentMessages
		? schedules
		.filter((schedule) => schedule.enabled)
		.flatMap((schedule) =>
			schedule.times
				.filter((time) => minutesFromTime(time) <= currentMinutes)
				.map((time) => {
					const slotKey = `${schedule.id}:${date}:${time}`;
					const sent = Boolean(schedule.lastSent[slotKey]);
					const log = logMap.get(slotKey);
					return {
						time,
						title: log?.messageTitle || schedule.title || "ZorFit insight",
						summary: timelineSummaryFor(schedule, sent, log),
						status: sent ? "sent" : "pending",
					} satisfies MyDayTimelineItem;
				}),
		)
		: [];
	if (options.includeYesterdaySummary) {
		const days = nutritionDays(context);
		const yesterday = days.length > 1 ? days[days.length - 2] : undefined;
		items.push({
			time: "06:00",
			title: "Yesterday summary",
			summary: yesterday
				? [
						yesterday.calories !== undefined ? `${Math.round(yesterday.calories)} kcal` : "",
						yesterday.protein !== undefined ? `${Math.round(yesterday.protein)}g protein` : "",
						yesterday.sugar !== undefined ? `${Math.round(yesterday.sugar)}g sugar` : "",
					]
						.filter(Boolean)
						.join(" · ") || "Previous nutrition day found, but macro totals were incomplete."
				: "Previous-day summary needs at least two logged Cronometer days.",
			status: "event",
		});
	}
	if (options.includeEventTimeline) {
		const macro = nutritionMacroLine(context);
		items.push(
			{
				time: "06:30",
				title: "Wake up",
				summary: "Morning readiness check: review sleep, HRV, and resting heart rate before choosing training intensity.",
				status: "event",
			},
			{
				time: "09:00",
				title: "Breakfast summary",
				summary: macro
					? `Nutrition logged today: ${macro}.`
					: "Breakfast/mealtime details appear once Cronometer entries are available.",
				status: "event",
			},
			{
				time: "13:00",
				title: "Lunch summary",
				summary: "Use this checkpoint to review protein, fiber, sugar, and calories before the afternoon.",
				status: "event",
			},
			{
				time: "17:00",
				title: "Snacks summary",
				summary: "Afternoon snack checkpoint: keep sugar controlled and close protein or micronutrient gaps.",
				status: "event",
			},
			{
				time: "19:00",
				title: "Workout summary",
				summary: "Training checkpoint: activity and gym summaries will appear here as sources provide events.",
				status: "event",
			},
			{
				time: "20:30",
				title: "Dinner summary",
				summary: "Dinner checkpoint: finish protein, fiber, hydration, and recovery basics for the day.",
				status: "event",
			},
		);
	}
	items.sort((a, b) => minutesFromTime(a.time) - minutesFromTime(b.time));
	const visibleItems = items.filter(
		(item) => item.status !== "event" || minutesFromTime(item.time) <= currentMinutes,
	);
	if (visibleItems.length) return visibleItems;
	return [
		{
			time: currentTime,
			title: "Your day starts here",
			summary:
				"Create scheduled messages in Settings to turn morning briefs, meals, workouts, and recovery check-ins into this timeline.",
			status: "empty",
		},
	];
}

function renderScoreCard(label: string, breakdown: ScoreBreakdown): string {
	return `<article class="panel score-card">
		<div class="score-head">
			<strong>${escapeHtml(label)}</strong>
			<span class="score-help" tabindex="0" aria-label="${escapeHtml(label)} calculation details">?
				<span class="score-tooltip"><ul>${breakdown.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul></span>
			</span>
		</div>
		<div class="score-value">${breakdown.score}</div>
		<p>${escapeHtml(scoreBand(breakdown.score))}</p>
	</article>`;
}

function renderTimelineItem(item: MyDayTimelineItem): string {
	const badge =
		item.status === "sent"
			? "sent"
			: item.status === "pending"
				? "pending"
				: item.status === "event"
					? "event"
					: "setup";
	return `<article class="timeline-item">
		<span class="timeline-dot ${item.status}"></span>
		<div class="timeline-time">${escapeHtml(item.time)}<span class="timeline-badge">${badge}</span></div>
		<h3 class="timeline-title">${escapeHtml(item.title)}</h3>
		<p class="timeline-summary">${escapeHtml(item.summary)}</p>
	</article>`;
}

type WeeklyLoadPoint = {
	label: string;
	load: number;
	protein: number;
	recovery: number;
};

type TrendPoint = {
	label: string;
	atl: number;
	ctl: number;
	tsb: number;
	protein: number;
	weight: number;
	targetWeight: number;
};

function renderFreshnessPanel(label = "Generated from current request"): string {
	return `<div class="freshness">
		<span>${escapeHtml(label)}</span>
		<a class="button" href="">Refresh</a>
	</div>`;
}

function renderBarChart(points: WeeklyLoadPoint[], key: keyof WeeklyLoadPoint): string {
	const values = points
		.map((point) => (typeof point[key] === "number" ? point[key] : 0))
		.filter((value): value is number => typeof value === "number");
	const max = Math.max(...values, 1);
	return `<div class="bar-chart" aria-label="${escapeHtml(String(key))} by day">
		${points
			.map((point) => {
				const value = typeof point[key] === "number" ? point[key] : 0;
				return `<div class="bar-column">
					<i style="height: ${Math.max(8, Math.round((value / max) * 100))}%"></i>
					<small>${escapeHtml(point.label)}</small>
				</div>`;
			})
			.join("")}
	</div>`;
}

function linePoints(values: number[], min: number, max: number, width: number, height: number): string {
	const xStep = (width - 80) / Math.max(values.length - 1, 1);
	const span = Math.max(max - min, 1);
	return values
		.map((value, index) => {
			const x = 40 + index * xStep;
			const y = 24 + (1 - (value - min) / span) * (height - 58);
			return `${x},${y}`;
		})
		.join(" ");
}

function renderLineChart(
	points: TrendPoint[],
	series: Array<{ key: keyof TrendPoint; label: string; color: string; dashed?: boolean }>,
	min: number,
	max: number,
): string {
	const width = 720;
	const height = 260;
	return `<div class="chart-panel">
		<div class="chart-legend">${series.map((item) => `${escapeHtml(item.label)}`).join(" · ")}</div>
		<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(series.map((item) => item.label).join(", "))} trend">
			${[42, 84, 126, 168, 210]
				.map((y) => `<line class="chart-grid-line" x1="24" x2="696" y1="${y}" y2="${y}"></line>`)
				.join("")}
			${series
				.map((item) => {
					const values = points.map((point) => Number(point[item.key]));
					return `<polyline points="${linePoints(values, min, max, width, height)}" fill="none" stroke="${item.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" ${item.dashed ? `stroke-dasharray="8 8"` : ""}></polyline>`;
				})
				.join("")}
			${points
				.map((point, index) => `<text x="${40 + index * 128}" y="248" text-anchor="middle">${escapeHtml(point.label)}</text>`)
				.join("")}
		</svg>
	</div>`;
}

function firstMetricSeries(
	context: HealthContextBundle,
	categories: HealthDataCategory[],
	patterns: RegExp[],
): number[] {
	for (const pattern of patterns) {
		const values = categories.flatMap((category) => metricSeries(context, category, pattern));
		if (values.length) return values;
	}
	return [];
}

function labelForIndex(index: number, total: number): string {
	if (total <= 7) {
		return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index] ?? `D${index + 1}`;
	}
	return `W${index + 1}`;
}

function realWeeklyLoad(context: HealthContextBundle): WeeklyLoadPoint[] {
	const activities = [
		...arrayFrom(contextFor(context, "fitness_activities")?.data),
		...arrayFrom(contextFor(context, "gym_workouts")?.data),
		...arrayFrom(contextFor(context, "steps")?.data),
	];
	const nutrition = nutritionDays(context);
	const recovery = firstMetricSeries(context, ["recovery", "hrv"], [
		/recovery.*score|readiness.*score|score/i,
		/^(hrv|hrv_rmssd|rmssd|hrv_sdnn)$/i,
	]);
	const loadValues = activities
		.map(activityLoadFrom)
		.filter((value): value is number => value !== undefined && value > 0);
	const count = Math.max(loadValues.length, nutrition.length, recovery.length);
	if (!count) return [];
	const start = Math.max(0, count - 7);
	return Array.from({ length: Math.min(7, count - start) }, (_, index) => {
		const sourceIndex = start + index;
		const nutritionDay = nutrition[sourceIndex] ?? nutrition[nutrition.length - Math.min(7, count - start) + index];
		return {
			label: nutritionDay?.date?.slice(5) ?? labelForIndex(index, Math.min(7, count - start)),
			load: Math.round(loadValues[sourceIndex] ?? 0),
			protein: Math.round(nutritionDay?.protein ?? 0),
			recovery: Math.round(recovery[sourceIndex] ?? 0),
		};
	});
}

function renderGoalTracking(
	context: HealthContextBundle,
	preferences: ScorePreferences,
): string {
	const goals: Array<{ label: string; value: string; target: string; progress: number; drift: string }> = [];
	const days = nutritionDays(context);
	const proteinValues = days
		.map((day) => day.protein)
		.filter((value): value is number => value !== undefined);
	const proteinAverage = average(proteinValues);
	if (proteinAverage !== undefined) {
		goals.push({
			label: "Weekly protein",
			value: `${Math.round(proteinAverage)}g avg`,
			target: `${preferences.proteinTargetG}g`,
			progress: Math.min(100, Math.round((proteinAverage / preferences.proteinTargetG) * 100)),
			drift: `${proteinValues.length} logged day${proteinValues.length === 1 ? "" : "s"}`,
		});
	}
	const loadValues = [
		...arrayFrom(contextFor(context, "fitness_activities")?.data),
		...arrayFrom(contextFor(context, "gym_workouts")?.data),
	].map(activityLoadFrom).filter((value): value is number => value !== undefined && value > 0);
	const latestLoad = loadValues[loadValues.length - 1];
	const loadBaseline = average(loadValues.slice(0, -1));
	if (latestLoad !== undefined) {
		goals.push({
			label: "Training load",
			value: `${Math.round(latestLoad)} latest`,
			target: loadBaseline !== undefined ? `${Math.round(loadBaseline)} baseline` : "baseline pending",
			progress: loadBaseline ? Math.min(100, Math.round((latestLoad / Math.max(loadBaseline, 1)) * 70)) : 50,
			drift: trendPhrase(percentDelta(latestLoad, loadBaseline)),
		});
	}
	const weightValues = firstMetricSeries(context, ["nutrition", "recovery"], [
		/body.*weight|weight_kg|weight_lb|weight/i,
	]);
	const latestWeight = weightValues[weightValues.length - 1];
	const weightBaseline = average(weightValues.slice(0, -1));
	if (latestWeight !== undefined) {
		goals.push({
			label: "Body weight",
			value: formatMetric(latestWeight),
			target: "target not set",
			progress: 50,
			drift: trendPhrase(percentDelta(latestWeight, weightBaseline)),
		});
	}
	if (!goals.length) {
		return `<p>No real goal data is available yet. Connect Cronometer for protein targets, Intervals.icu or Strava for load, and a weight source for body composition.</p>`;
	}
	return `<div class="progress-list">
		${goals
			.map(
				(goal) => `<div class="progress-row">
					<div>
						<strong>${escapeHtml(goal.label)}</strong>
						<small>${escapeHtml(goal.value)} · ${escapeHtml(goal.target)}</small>
					</div>
					<div class="progress-track"><span style="width: ${goal.progress}%"></span></div>
					<span class="metric-value">${escapeHtml(goal.drift)}</span>
				</div>`,
			)
			.join("")}
	</div>`;
}

function renderPreWorkoutBrief(readinessScore: number): string {
	const sessionGuidance =
		readinessScore >= 75
			? "Train as planned, cap hard sets before form breaks."
			: readinessScore >= 62
				? "Keep the session, but lower total volume by 10-15%."
				: "Swap high intensity for technique, mobility, or zone 2.";
	return `<div class="feature-grid">
		<article class="panel feature-card">
			<span class="status">30-60 min before</span>
			<h3>Pre-workout brief</h3>
			<p>${escapeHtml(sessionGuidance)} Readiness score is ${readinessScore}, so the coach should bias toward useful work over bravado.</p>
		</article>
		<article class="panel feature-card">
			<span class="status">Fuel note</span>
			<h3>Protein plus fast carbs</h3>
			<p>Target 30g protein and 35-45g carbs before training. Post-session, add sodium and keep dinner aligned with the deficit.</p>
		</article>
	</div>`;
}

function renderPatternCards(context: HealthContextBundle): string {
	const loadValues = [
		...arrayFrom(contextFor(context, "fitness_activities")?.data),
		...arrayFrom(contextFor(context, "gym_workouts")?.data),
	].map(activityLoadFrom).filter((value): value is number => value !== undefined && value > 0);
	const hrv = firstMetricSeries(context, ["hrv", "recovery"], [
		/^(hrv|hrv_rmssd|rmssd|hrv_sdnn)$/i,
	]);
	const days = nutritionDays(context);
	const candidates: Array<{ title: string; meta: string; text: string }> = [];
	if (loadValues.length >= 4 && hrv.length >= 4) {
		const latestLoad = loadValues[loadValues.length - 1];
		const loadBaseline = average(loadValues.slice(0, -1));
		const latestHrv = hrv[hrv.length - 1];
		const hrvBaseline = average(hrv.slice(0, -1));
		candidates.push({
			title: "Training load vs recovery",
			meta: `Candidate pattern · ${Math.min(loadValues.length, hrv.length)} real points`,
			text: `Latest load is ${trendPhrase(percentDelta(latestLoad, loadBaseline))}; latest HRV is ${trendPhrase(percentDelta(latestHrv, hrvBaseline))}. More history is needed before calling this reliable.`,
		});
	}
	if (days.length >= 4) {
		const proteinValues = days
			.map((day) => day.protein)
			.filter((value): value is number => value !== undefined);
		const calories = days
			.map((day) => day.calories)
			.filter((value): value is number => value !== undefined);
		if (proteinValues.length >= 4) {
			candidates.push({
				title: "Protein consistency",
				meta: `Candidate pattern · ${proteinValues.length} Cronometer days`,
				text: `Average protein is ${formatMetric(average(proteinValues), "g")}. Average calories are ${formatMetric(average(calories), " kcal")}.`,
			});
		}
	}
	if (!candidates.length) {
		return `<div class="pattern-card">
			<small>Waiting for history</small>
			<strong>Pattern detection will wake up after 4-8 weeks of routed data.</strong>
			<p>Connect Cronometer, Intervals.icu, Strava, Hevy, HRV, and sleep data. Once the window is wide enough, ZorFit can start calling real correlations instead of one-off guesses.</p>
		</div>`;
	}
	return `<div class="pattern-list">
		${candidates
			.map(
				(pattern) => `<article class="pattern-card">
					<small>${escapeHtml(pattern.meta)}</small>
					<strong>${escapeHtml(pattern.title)}</strong>
					<p>${escapeHtml(pattern.text)}</p>
				</article>`,
			)
			.join("")}
	</div>`;
}

function renderMorningBrief(context: HealthContextBundle, scores: ScoreSummary): string {
	const macro = nutritionMacroLine(context);
	const nutritionReady = contextFor(context, "nutrition")?.status === "ready";
	return `<div class="feature-grid">
		<article class="panel feature-card">
			<span class="status">Morning briefing</span>
			<h3>Yesterday, readiness, priority.</h3>
			<p>${escapeHtml(macro ? `Current nutrition read: ${macro}. ` : "Nutrition read is not available yet. ")}Overall score is ${scores.overall.score}; priority action is ${escapeHtml(motivationalMessage(scores))}</p>
		</article>
		<article class="panel feature-card">
			<span class="status">Missed check-in nudge</span>
			<h3>One message, configurable off.</h3>
			<p>${nutritionReady ? "Cronometer returned data for this routed window, so no nutrition check-in nudge is needed from this page state." : "Cronometer data is missing for this routed window, so a single noon check-in nudge would be eligible if enabled."}</p>
		</article>
	</div>`;
}

type Answerability = "ready" | "partial" | "not_ready";

interface QuestionDiagnostic {
	question: string;
	answerability: Answerability;
	confidence: "High" | "Medium" | "Low";
	coveragePercent: number;
	requiredCategories: HealthDataCategory[];
	available: string[];
	missing: string[];
	assumptions: string[];
	fixes: Array<{ label: string; href: string }>;
	safePreview: string;
}

function categoriesForQuestion(question: string): HealthDataCategory[] {
	const normalized = question.toLowerCase();
	const categories = new Set<HealthDataCategory>();
	const add = (items: HealthDataCategory[]) => items.forEach((item) => categories.add(item));
	if (/hrv|recovery|readiness|rest|sleep|strain|train hard|training hard/i.test(normalized)) {
		add(["hrv", "sleep", "recovery", "fitness_activities"]);
	}
	if (/protein|calorie|macro|nutrition|meal|fuel|food|cronometer|deficit/i.test(normalized)) {
		add(["nutrition"]);
	}
	if (/workout|lift|run|ride|training load|atl|ctl|tsb|hevy|strava|intervals/i.test(normalized)) {
		add(["fitness_activities", "gym_workouts", "recovery"]);
	}
	if (/weight|body fat|body composition|scale|cut|six-pack|six pack/i.test(normalized)) {
		add(["nutrition", "recovery"]);
	}
	if (/report|weekly|pattern|trend|why did|what caused|cause|rca/i.test(normalized)) {
		add(["nutrition", "hrv", "sleep", "fitness_activities", "gym_workouts", "recovery"]);
	}
	if (!categories.size) add(["nutrition", "fitness_activities", "recovery"]);
	return Array.from(categories);
}

function buildQuestionDiagnostic(
	question: string,
	context: HealthContextBundle,
	requiredCategoriesOverride?: HealthDataCategory[],
): QuestionDiagnostic {
	const requiredCategories = requiredCategoriesOverride?.length
		? requiredCategoriesOverride
		: categoriesForQuestion(question);
	const required = requiredCategories.map((category) => ({
		category,
		context: contextFor(context, category),
	}));
	const available = required
		.filter((item) => item.context?.status === "ready")
		.map((item) => `${categoryLabel(item.category)} via ${PROVIDER_LABELS[item.context?.provider ?? "manual"]}`);
	const missing = required
		.filter((item) => item.context?.status !== "ready")
		.map((item) => {
			const provider = item.context?.provider ? PROVIDER_LABELS[item.context.provider] : "No provider";
			const note = item.context?.note ? `: ${item.context.note}` : "";
			return `${categoryLabel(item.category)} (${provider}, ${item.context?.status ?? "missing"}${note})`;
		});
	const coveragePercent = Math.round((available.length / Math.max(required.length, 1)) * 100);
	const answerability: Answerability =
		coveragePercent >= 85 ? "ready" : coveragePercent >= 35 ? "partial" : "not_ready";
	const confidence = answerability === "ready" ? "High" : answerability === "partial" ? "Medium" : "Low";
	const assumptions =
		answerability === "ready"
			? ["ZorFit can answer using current routed source data, but should still mention uncertainty and avoid medical advice."]
			: [
					`ZorFit would answer with ${coveragePercent}% of required evidence.`,
					"Any coach response should name missing inputs instead of filling gaps.",
				];
	const fixes = [
		{ label: "Connections", href: "/connections" },
		{ label: "Data routing", href: "/settings/data-routing" },
		{ label: "Scoring", href: "/settings/scoring" },
	];
	const safePreview =
		answerability === "ready"
			? "Ready to answer with connected evidence. The response should cite the available categories and keep recommendations practical."
			: answerability === "partial"
				? "Partial answer only. ZorFit can give a cautious answer, but should say which data is missing."
				: "Not enough data to answer accurately. ZorFit should ask the user to connect or route missing sources first.";
	return {
		question,
		answerability,
		confidence,
		coveragePercent,
		requiredCategories,
		available,
		missing,
		assumptions,
		fixes,
		safePreview,
	};
}

function renderQuestionDiagnostic(diagnostic: QuestionDiagnostic): string {
	const statusLabel =
		diagnostic.answerability === "ready"
			? "Ready to answer"
			: diagnostic.answerability === "partial"
				? "Partial answer only"
				: "Not enough data";
	return `<section class="section" id="question-diagnostic">
		<div class="section-head">
			<div>
				<span class="eyebrow">Question diagnostics</span>
				<h2>${statusLabel}.</h2>
			</div>
			<p>${diagnostic.coveragePercent}% evidence coverage · ${diagnostic.confidence} confidence</p>
		</div>
		<div class="grid">
			<article class="panel">
				<span class="status">Question</span>
				<h3>${escapeHtml(diagnostic.question)}</h3>
				<p>${escapeHtml(diagnostic.safePreview)}</p>
			</article>
			<article class="panel">
				<span class="status">Required data</span>
				<ul class="guidance">${diagnostic.requiredCategories.map((category) => `<li>${escapeHtml(categoryLabel(category))}</li>`).join("")}</ul>
			</article>
			<article class="panel">
				<span class="status">Available evidence</span>
				${diagnostic.available.length ? `<ul class="guidance">${diagnostic.available.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>No required evidence is currently ready.</p>"}
			</article>
			<article class="panel">
				<span class="status">Missing or weak evidence</span>
				${diagnostic.missing.length ? `<ul class="guidance">${diagnostic.missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>No required categories are missing.</p>"}
			</article>
			<article class="panel">
				<span class="status">Assumptions</span>
				<ul class="guidance">${diagnostic.assumptions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
			</article>
			<article class="panel">
				<span class="status">Fix this answer</span>
				<div class="actions">${diagnostic.fixes.map((fix) => `<a class="button" href="${fix.href}">${escapeHtml(fix.label)}</a>`).join("")}</div>
			</article>
		</div>
	</section>`;
}

const AI_PROVIDER_DEFAULTS: Record<
	AiProviderId,
	{ baseUrl: string; model: string; help: string }
> = {
	openai: {
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
		help: "Use the model name from the OpenAI model picker. OpenAI-compatible proxies can override the base URL.",
	},
	claude: {
		baseUrl: "https://api.anthropic.com",
		model: "claude-3-5-haiku-latest",
		help: "Use an Anthropic Console API key. Model names usually begin with claude-.",
	},
	gemini: {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		model: "gemini-1.5-flash",
		help: "Use a Google AI Studio API key. The model field should be only the model name, not a full URL.",
	},
	nvidia_nim: {
		baseUrl: "https://integrate.api.nvidia.com/v1",
		model: "meta/llama-3.1-70b-instruct",
		help: "NVIDIA NIM model IDs include the publisher path. Copy the ID exactly from NVIDIA Build, for example qwen/qwen2.5-coder-32b-instruct.",
	},
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		model: "openai/gpt-4o-mini",
		help: "OpenRouter model IDs include the provider path, for example anthropic/claude-3.5-sonnet.",
	},
	groq: {
		baseUrl: "https://api.groq.com/openai/v1",
		model: "llama-3.1-8b-instant",
		help: "Groq model names are listed in the Groq console. Keep the base URL as the OpenAI-compatible endpoint.",
	},
	google_ai_studio: {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		model: "gemini-1.5-flash",
		help: "This uses the same Gemini API shape as Google AI Studio. Paste the API key from AI Studio.",
	},
};

utilityRoutes.get("/settings", async (c) => {
	const session = await getSettingsSession(c);
	const [serviceStatuses, aiSummaries, telegram] = session
		? await Promise.all([
				getZorFitServiceStatuses(c.env, session),
				listAiConnectionSummaries(c.env, session),
				getTelegramConnection(c.env, session),
			])
		: [[], [], null] as const;
	const connectedSources = serviceStatuses.filter((status) => status.configured).length;
	const connectedAi = aiSummaries.filter((summary) => summary.enabled).length;
	const telegramReady = Boolean(telegram?.enabled && telegram.externalUserId);
	const nextStep = !session
		? { label: "Sign in to start setup", href: "/signin" }
		: connectedSources === 0
			? { label: "Connect your first source", href: "/settings/sources" }
			: connectedAi === 0
				? { label: "Add an AI provider", href: "/settings/ai" }
				: !telegramReady
					? { label: "Connect Telegram", href: "/settings/messages" }
					: { label: "Ask your first question", href: "/coach" };
	const categories: SettingsCard[] = [
		{
			id: "sources",
			label: "Fitness Apps & Wearables",
			status: "Data sources",
			description:
				"Connect health apps, nutrition trackers, training platforms, and wearable devices.",
			href: "/settings/sources",
		},
		{
			id: "routing",
			label: "Data Routing",
			status: "Routing",
			description:
				"Choose where ZorFit should read HRV, sleep, nutrition, steps, workouts, and recovery from.",
			href: "/settings/data-routing",
		},
		{
			id: "ai",
			label: "AI Connections",
			status: "BYOK",
			description:
				"Add your own LLM API keys for future ZorFit nutrition and training insights.",
			href: "/settings/ai",
		},
		{
			id: "messages",
			label: "Messages",
			status: "Check-ins",
			description:
				"Connect Telegram and future messaging channels for scheduled insight delivery.",
			href: "/settings/messages",
		},
		{
			id: "scoring",
			label: "Score Formula",
			status: "Configurable",
			description:
				"Set score weights and personal nutrition, sleep, and recovery targets used on My Day.",
			href: "/settings/scoring",
		},
	];
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Setup hub</span>
				<h1>Connect what ZorFit needs to coach.</h1>
				<p class="lede">${session ? `${connectedSources} source${connectedSources === 1 ? "" : "s"} connected · ${connectedAi} AI key${connectedAi === 1 ? "" : "s"} · Telegram ${telegramReady ? "connected" : "not set"}.` : "Sign in to see source, AI, and Telegram setup status."}</p>
			</div>
			<div class="panel">
				<strong>Recommended next step</strong>
				<p>${escapeHtml(nextStep.label)}</p>
				<a class="button primary" href="${nextStep.href}">Continue setup</a>
			</div>
		</section>
		<section class="section">
			<div class="actions"><a class="button" href="/">Back to home</a></div>
			<div class="grid">${renderSettingsCards(categories)}</div>
		</section>
	</main>`;
	return c.html(settingsShell("Settings", body));
});

utilityRoutes.get("/settings/scoring", async (c) => {
	const session = await getSettingsSession(c);
	const preferences = session
		? await getScorePreferences(c.env, session)
		: DEFAULT_SCORE_PREFERENCES;
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Score formula</span>
				<h1>Configure how My Day is scored.</h1>
				<p class="lede">Tune the weights and targets ZorFit uses for overall score, nutrition score, readiness score, and the tooltip explanations.</p>
			</div>
			<div class="panel">
				<strong>${session ? `Signed in as @${escapeHtml(session.login)}` : "Sign in required"}</strong>
				<p>${session ? "Changes apply to the My Day dashboard immediately after saving." : "Sign in before saving scoring preferences."}</p>
			</div>
		</section>
		<section class="section">
			<div class="actions"><a class="button" href="/settings">Back to settings</a><a class="button" href="/my-day">Open My Day</a></div>
			<form class="panel" id="scoreForm">
				<div class="actions">
					<button type="button" data-preset="balanced">Balanced</button>
					<button type="button" data-preset="athlete">Athlete</button>
					<button type="button" data-preset="weight_loss">Weight loss</button>
					<span class="status" id="weightTotal">Weights total 100%</span>
				</div>
				<div class="row">
					<div>
						<label>Nutrition weight</label>
						<input name="nutritionWeight" type="range" min="0" max="100" value="${preferences.nutritionWeight}">
					</div>
					<div>
						<label>Readiness weight</label>
						<input name="readinessWeight" type="range" min="0" max="100" value="${preferences.readinessWeight}">
					</div>
				</div>
				<div class="row">
					<div>
						<label>Fitness weight</label>
						<input name="fitnessWeight" type="range" min="0" max="100" value="${preferences.fitnessWeight}">
					</div>
					<div>
						<label>Sleep target hours</label>
						<input name="sleepTargetHours" type="number" min="3" max="12" step="0.25" value="${preferences.sleepTargetHours}">
					</div>
				</div>
				<div class="row">
					<div>
						<label>Protein target, grams</label>
						<input name="proteinTargetG" type="number" min="0" max="400" value="${preferences.proteinTargetG}">
					</div>
					<div>
						<label>Sugar limit, grams</label>
						<input name="sugarLimitG" type="number" min="0" max="300" value="${preferences.sugarLimitG}">
					</div>
				</div>
				<label>Fiber target, grams</label>
				<input name="fiberTargetG" type="number" min="0" max="120" value="${preferences.fiberTargetG}">
				<div class="helper">Overall score uses your three weights proportionally. Nutrition uses protein, sugar, fiber, logging consistency, and calorie stability. Readiness uses HRV, sleep, and resting heart rate trends.</div>
				<div class="actions"><button class="primary" type="submit" ${session ? "" : "disabled"}>Save score formula</button></div>
				<div id="message"></div>
			</form>
		</section>
	</main>
	<script>
		const presets = {
			balanced: { nutritionWeight: 35, readinessWeight: 35, fitnessWeight: 30, proteinTargetG: 100, sugarLimitG: 25, fiberTargetG: 25, sleepTargetHours: 7 },
			athlete: { nutritionWeight: 25, readinessWeight: 40, fitnessWeight: 35, proteinTargetG: 130, sugarLimitG: 35, fiberTargetG: 30, sleepTargetHours: 7.5 },
			weight_loss: { nutritionWeight: 45, readinessWeight: 30, fitnessWeight: 25, proteinTargetG: 120, sugarLimitG: 25, fiberTargetG: 30, sleepTargetHours: 7 }
		};
		function updateWeightTotal() {
			const form = document.getElementById("scoreForm");
			const total = ["nutritionWeight", "readinessWeight", "fitnessWeight"].reduce((sum, name) => sum + Number(form.elements[name].value || 0), 0);
			document.getElementById("weightTotal").textContent = "Weights total " + total + "%";
		}
		document.getElementById("scoreForm")?.addEventListener("input", updateWeightTotal);
		document.querySelectorAll("[data-preset]").forEach((button) => {
			button.addEventListener("click", () => {
				const form = document.getElementById("scoreForm");
				const preset = presets[button.dataset.preset];
				Object.entries(preset).forEach(([key, value]) => { form.elements[key].value = value; });
				updateWeightTotal();
			});
		});
		document.getElementById("scoreForm")?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const payload = Object.fromEntries(new FormData(form).entries());
			const total = Number(payload.nutritionWeight || 0) + Number(payload.readinessWeight || 0) + Number(payload.fitnessWeight || 0);
			if (total > 0 && total !== 100) {
				payload.nutritionWeight = Math.round((Number(payload.nutritionWeight || 0) / total) * 100);
				payload.readinessWeight = Math.round((Number(payload.readinessWeight || 0) / total) * 100);
				payload.fitnessWeight = Math.max(0, 100 - Number(payload.nutritionWeight) - Number(payload.readinessWeight));
			}
			const response = await fetch("/api/score-preferences", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = await response.json().catch(() => ({}));
			document.getElementById("message").textContent = response.ok ? "Saved score formula." : (data.error || "Could not save score formula.");
		});
		updateWeightTotal();
	</script>`;
	return c.html(settingsShell("Score Formula", body));
});

utilityRoutes.get("/settings/sources", async (c) => {
	const session = await getSettingsSession(c);
	const statusMap = new Map<
		string,
		{ source: "user_d1" | "worker_secret" | "missing" }
	>();
	if (session) {
		const statuses = await getZorFitServiceStatuses(c.env, session);
		for (const status of statuses) statusMap.set(status.id, status);
	}
	const cards = SOURCE_SETTINGS.map((source) => {
		const status = statusMap.get(source.id);
		const isComingSoon = source.authType === "coming_soon";
		const authLabel =
			source.authType === "oauth"
				? "OAuth"
				: source.authType === "api_key"
					? "API key"
					: source.authType === "username_password"
						? "Username + password"
						: "Planned";
		const setupTime =
			source.id === "strava" || source.id === "hevy" || source.id === "intervals_icu"
				? "~2 min setup"
				: source.id === "cronometer"
					? "~1 min setup"
					: source.authType === "oauth"
						? "Requires app/OAuth setup"
						: "Future connector";
		return {
			...source,
			status: isComingSoon
				? "Coming soon"
				: session
					? statusLabel(status?.source)
					: authLabel,
			guidance: [
				`Auth type: ${authLabel}`,
				`Estimated setup: ${setupTime}`,
				source.authType === "oauth"
					? "OAuth sources may require provider app approval before public use."
					: source.helpText,
			],
		};
	});
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Fitness apps and wearables</span>
				<h1>Connect data sources.</h1>
				<p class="lede">Add credentials for fitness apps, wearables, nutrition trackers, and training platforms. Valid saved credentials show as connected.</p>
			</div>
			<div class="panel">
				<strong>${session ? `Signed in as @${session.login}` : "Sign in required"}</strong>
				<p>${session ? "Connection status reflects your encrypted account credentials plus server-level credentials." : "Sign in to view live connection status and save credentials."}</p>
			</div>
		</section>
		<section class="section">
			<div class="actions"><a class="button" href="/settings">Back to settings</a></div>
			<div class="grid">${renderSettingsCards(cards)}</div>
		</section>
	</main>`;
	return c.html(settingsShell("Fitness Apps & Wearables", body));
});

utilityRoutes.get("/settings/data-routing", async (c) => {
	const session = await getSettingsSession(c);
	const preferences = session ? await listDataPreferences(c.env, session) : [];
	const preferenceMap = new Map(preferences.map((item) => [item.category, item]));
	const rows = HEALTH_CATEGORIES.map((category) => {
		const preference = preferenceMap.get(category.id);
		const options = category.providers
			.map(
				(provider) =>
					`<option value="${provider}" ${provider === preference?.provider ? "selected" : ""}>${escapeHtml(PROVIDER_LABELS[provider])}</option>`,
			)
			.join("");
		const fallbackOptions = [
			`<option value="">No fallback</option>`,
			...category.providers.map(
				(provider) =>
					`<option value="${provider}" ${provider === preference?.fallbackProvider ? "selected" : ""}>${escapeHtml(PROVIDER_LABELS[provider])}</option>`,
			),
		].join("");
		return `<div class="panel routing-row" data-category="${category.id}">
			<div class="row">
				<div>
					<label>${escapeHtml(category.label)}</label>
					<p>${escapeHtml(category.description)}</p>
				</div>
				<div>
					<label for="provider-${category.id}">Primary source</label>
					<select id="provider-${category.id}" name="provider">${options}</select>
					<label for="fallback-${category.id}">Fallback source</label>
					<select id="fallback-${category.id}" name="fallbackProvider">${fallbackOptions}</select>
					<label>
						<input name="enabled" type="checkbox" ${preference?.enabled === false ? "" : "checked"} style="width:auto; min-height:auto; margin-right:8px;">
						Use this category in ZorFit insights
					</label>
				</div>
			</div>
		</div>`;
	}).join("");
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Data routing</span>
				<h1>Choose where each signal comes from.</h1>
				<p class="lede">ZorFit uses these preferences when Telegram messages and Coach Chat need HRV, sleep, nutrition, steps, gym workouts, activities, or recovery data.</p>
			</div>
			<div class="panel">
				<strong>${session ? `Signed in as @${escapeHtml(session.login)}` : "Sign in required"}</strong>
				<p>${session ? "Selections are saved per user. Connect provider credentials first for live data." : "Sign in before saving data routing preferences."}</p>
			</div>
		</section>
		<form id="routingForm">
			<div class="actions"><a class="button" href="/settings">Back to settings</a></div>
			${rows}
			<div class="actions">
				<button class="primary" type="submit" ${session ? "" : "disabled"}>Save data routing</button>
				<a class="button" href="/settings/messages">Configure messages</a>
			</div>
			<div id="message"></div>
		</form>
	</main>
	<script>
		document.getElementById("routingForm")?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const preferences = Array.from(document.querySelectorAll(".routing-row")).map((row) => ({
				category: row.dataset.category,
				provider: row.querySelector('select[name="provider"]').value,
				fallbackProvider: row.querySelector('select[name="fallbackProvider"]').value || undefined,
				enabled: row.querySelector('input[name="enabled"]').checked,
			}));
			const response = await fetch("/api/data-preferences", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ preferences }),
			});
			const data = await response.json().catch(() => ({}));
			document.getElementById("message").textContent = response.ok ? "Saved data routing." : (data.error || "Could not save data routing.");
		});
	</script>`;
	return c.html(settingsShell("Data Routing", body));
});

utilityRoutes.get("/settings/ai", async (c) => {
	const session = await getSettingsSession(c);
	const connected = new Set<AiProviderId>();
	const summaries = session
		? await listAiConnectionSummaries(c.env, session)
		: [];
	const preference = session ? await getAiPreference(c.env, session) : null;
	const defaultProvider = preference?.defaultProvider;
	if (session) {
		for (const connection of summaries) {
			if (connection.enabled) connected.add(connection.provider);
		}
	}
	const cards = LLM_SETTINGS.map((provider) => ({
		...provider,
		status: session
			? defaultProvider === provider.id
				? "Default"
				: connected.has(provider.id as AiProviderId)
					? "Connected"
					: "Setup pending"
			: "Sign in required",
	}));
	const connectedOptions = summaries
		.filter((summary) => summary.enabled)
		.map((summary) => {
			const label =
				LLM_SETTINGS.find((provider) => provider.id === summary.provider)
					?.label ?? summary.provider;
			return `<option value="${summary.provider}" ${summary.provider === defaultProvider ? "selected" : ""}>${escapeHtml(label)} - ${escapeHtml(summary.modelName)}</option>`;
		})
		.join("");
	const selectedSummary = summaries.find(
		(summary) => summary.provider === defaultProvider,
	);
	const preferencePanel = session
		? `<form class="panel" id="aiPreferenceForm">
			<strong>Default AI model</strong>
			<p>This model will be used for Telegram nutrition insights and future ZorFit AI summaries.</p>
			${
				connectedOptions
					? `<label for="defaultProvider">Use this connected model</label>
					<select id="defaultProvider" name="defaultProvider">${connectedOptions}</select>
					<div class="helper">${selectedSummary ? `Current default: ${escapeHtml(selectedSummary.modelName)}` : "Choose one connected provider as your default model."}</div>
					<div class="actions">
						<button class="primary" type="submit">Save default model</button>
					</div>`
					: `<div class="helper">Add an AI provider first. Then choose your default model here.</div>`
			}
			<div id="preferenceMessage"></div>
		</form>
		<script>
			document.getElementById("aiPreferenceForm")?.addEventListener("submit", async (event) => {
				event.preventDefault();
				const form = event.currentTarget;
				const provider = form.elements.defaultProvider?.value;
				if (!provider) return;
				const response = await fetch("/api/ai-preferences", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ defaultProvider: provider }),
				});
				const data = await response.json().catch(() => ({}));
				document.getElementById("preferenceMessage").textContent = response.ok ? "Saved default AI model." : (data.error || "Could not save default model.");
			});
		</script>`
		: "";
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">AI connections</span>
				<h1>Bring your own model key.</h1>
				<p class="lede">Choose an LLM provider for future ZorFit nutrition insights, Telegram summaries, and training explanations.</p>
			</div>
			<div class="panel">
				<strong>${session ? `Signed in as @${escapeHtml(session.login)}` : "Sign in required"}</strong>
				<p>${session ? "API keys are encrypted per user. Model names are shown with examples on each provider card." : "Sign in before saving LLM API details."}</p>
			</div>
		</section>
		${preferencePanel}
		<section class="section">
			<div class="actions"><a class="button" href="/settings">Back to settings</a></div>
			<div class="grid">${renderSettingsCards(cards)}</div>
		</section>
	</main>`;
	return c.html(settingsShell("AI Connections", body));
});

utilityRoutes.get("/settings/messages", async (c) => {
	const session = await getSettingsSession(c);
	const telegram = session ? await getTelegramConnection(c.env, session) : null;
	const cards = MESSAGING_SETTINGS.map((service) => ({
		...service,
		status: session
			? telegram?.enabled
				? "Connected"
				: "Setup pending"
			: "Sign in required",
	}));
	const allCards = [
		...cards,
		{
			id: "whatsapp",
			label: "WhatsApp",
			status: "Future",
			description:
				"Placeholder for future WhatsApp delivery after the Telegram flow is stable.",
			href: "/settings/messages",
			guidance: ["Future channel", "Likely requires WhatsApp Business API setup."],
		},
	];
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Messages</span>
				<h1>Send insights where users already are.</h1>
				<p class="lede">Connect Telegram, then create multiple scheduled messages. Each message can choose the data categories ZorFit should fetch before asking your selected AI model.</p>
			</div>
			<div class="panel">
				<strong>${telegram?.enabled ? "Telegram connected" : "Telegram first"}</strong>
				<p>${telegram?.enabled ? "Scheduled insight messages can now send to Telegram." : "The setup flow uses a bot deep link and short-lived code. Users do not need to paste chat IDs."}</p>
			</div>
		</section>
		<section class="section">
			<div class="actions"><a class="button" href="/settings">Back to settings</a></div>
			<div class="grid">${renderSettingsCards(allCards)}</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Preview</span>
					<h2>What users receive.</h2>
				</div>
				<p>Scheduled messages use the same concise format before they are delivered to Telegram.</p>
			</div>
			<div class="panel">
				<pre class="report-preview">ZorFit nutrition check-in

Date: 2026-06-06
Data check: Cronometer nutrition retrieved for this insight.

Protein is behind target and sugar is high for this time of day.
Next meal: lean protein, fiber, and steady carbs. Skip the extra sweet snack.

Not medical advice. Consult a qualified professional for health or nutrition decisions.</pre>
				<div class="actions">
					<a class="button primary" href="/settings/messaging/telegram">Configure Telegram</a>
				</div>
			</div>
		</section>
	</main>`;
	return c.html(settingsShell("Messages", body));
});

utilityRoutes.get("/settings/source/:id", (c) => {
	const id = c.req.param("id");
	const source = SOURCE_SETTINGS.find((item) => item.id === id);
	if (!source) return c.text("Unknown source", 404);
	const isActive = source.authType !== "coming_soon";
	const fields = source.fields
		.map((field) => {
			const type = /password|secret|token|key/i.test(field)
				? "password"
				: "text";
			const label = field
				.replace(/([A-Z])/g, " $1")
				.replace(/^./, (char) => char.toUpperCase());
			return `<label for="${field}">${label}</label><input id="${field}" name="${field}" type="${type}" autocomplete="off" placeholder="${label}">`;
		})
		.join("");
	const helpLink = source.helpUrl
		? `<a class="button" href="${source.helpUrl}" target="_blank" rel="noreferrer">${source.helpLabel ?? "Open provider"}</a>`
		: "";
	const oauthLink = ["fitbit", "google_fit"].includes(source.id)
		? `<a class="button" href="/connect/${source.id}">OAuth connect</a>`
		: "";
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Fitness source</span>
				<h1>${source.label}</h1>
				<p class="lede">${source.description}</p>
			</div>
			<div class="panel">
				<strong>${source.status}</strong>
				<p>${source.helpText}</p>
			</div>
		</section>
		<form class="panel" id="sourceForm">
			${fields || `<div class="helper">This provider is planned. Credential fields will appear after the integration is approved and ready.</div>`}
			<div class="actions">
				<button class="primary" type="submit" ${isActive ? "" : "disabled"}>Save ${source.label}</button>
				${oauthLink}
				${helpLink}
				<a class="button" href="/settings/sources">Back to fitness sources</a>
			</div>
			<div id="message"></div>
		</form>
	</main>
	<script>
		const source = ${JSON.stringify(source)};
		const form = document.getElementById("sourceForm");
		const message = document.getElementById("message");
		form?.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (source.authType === "coming_soon") return;
			const credentials = {};
			for (const field of source.fields) {
				const value = form.elements[field]?.value?.trim();
				if (value) credentials[field] = value;
			}
			const response = await fetch("/api/connections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ serviceId: source.id, authType: source.authType, credentials }),
			});
			const data = await response.json().catch(() => ({}));
			message.textContent = response.ok ? "Saved connection." : (data.error || "Could not save connection. Sign in first if needed.");
		});
	</script>`;
	return c.html(settingsShell(source.label, body));
});

utilityRoutes.get("/settings/llm/:id", async (c) => {
	const id = c.req.param("id");
	const provider = LLM_SETTINGS.find((item) => item.id === id);
	if (!provider) return c.text("Unknown LLM provider", 404);
	const session = await getSettingsSession(c);
	const connection = session
		? (await listAiConnectionSummaries(c.env, session)).find(
				(item) => item.provider === provider.id,
			)
		: null;
	const preference = session ? await getAiPreference(c.env, session) : null;
	const defaults = AI_PROVIDER_DEFAULTS[provider.id as AiProviderId];
	const savedRequestSettings = connection?.requestSettings ?? {};
	const requestSettings =
		Object.keys(savedRequestSettings).length > 0
			? savedRequestSettings
			: recommendedAiRequestSettings(
					provider.id as AiProviderId,
					connection?.modelName ?? defaults.model,
				);
	const guidance =
		provider.guidance?.map((item) => `<li>${escapeHtml(item)}</li>`).join("") ??
		"";
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">LLM provider</span>
				<h1>${provider.label}</h1>
				<p class="lede">${provider.description}</p>
			</div>
			<div class="panel">
				<strong>${connection?.enabled ? "Connected" : session ? "Setup pending" : "Sign in required"}</strong>
				<p>${escapeHtml(defaults.help)}</p>
			</div>
		</section>
		<form class="panel" id="aiForm">
			<label for="apiKey">API key</label>
			<textarea id="apiKey" name="apiKey" placeholder="${connection ? "Leave blank to keep the saved key" : `Paste ${provider.label} API key`}"></textarea>
			<div class="row">
				<div>
					<label for="model">Model</label>
					<input id="model" name="model" value="${escapeHtml(connection?.modelName ?? defaults.model)}" placeholder="${escapeHtml(defaults.model)}">
				</div>
				<div>
					<label for="baseUrl">Base URL</label>
					<input id="baseUrl" name="baseUrl" value="${escapeHtml(connection?.baseUrl ?? defaults.baseUrl)}" placeholder="${escapeHtml(defaults.baseUrl)}">
				</div>
			</div>
			<div class="helper">
				<ul class="guidance">${guidance}</ul>
				<div>Use the model name exactly as the provider displays it. For NVIDIA NIM and OpenRouter, that usually includes a provider prefix such as <strong>qwen/...</strong> or <strong>openai/...</strong>.</div>
			</div>
			<label for="requestSettings">Advanced request settings</label>
			<textarea id="requestSettings" name="requestSettings" spellcheck="false" placeholder="{}">${escapeHtml(JSON.stringify(requestSettings, null, 2))}</textarea>
			<div class="helper">
				Optional provider-specific JSON for token limits, temperature, and reasoning controls. ZorFit blocks model, messages, credentials, streaming, and unknown settings. Groq GPT-OSS models work best with <strong>include_reasoning: false</strong>, <strong>reasoning_effort: "low"</strong>, and <strong>max_completion_tokens: 4000</strong>.
			</div>
			<div class="actions">
				<button class="primary" type="submit" ${session ? "" : "disabled"}>Save ${provider.label}</button>
				<button type="button" id="makeDefault" ${connection ? "" : "disabled"}>${preference?.defaultProvider === provider.id ? "Default model" : "Use as default"}</button>
				<button type="button" id="deleteAi" class="danger" ${connection ? "" : "disabled"}>Delete saved key</button>
				<a class="button" href="/settings/ai">Back to AI connections</a>
			</div>
			<div id="message"></div>
		</form>
	</main>
	<script>
		const provider = ${JSON.stringify(provider.id)};
		const form = document.getElementById("aiForm");
		const message = document.getElementById("message");
		form?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const apiKey = form.elements.apiKey.value.trim();
			const modelName = form.elements.model.value.trim();
			const baseUrl = form.elements.baseUrl.value.trim();
			const requestSettingsJson = form.elements.requestSettings.value.trim();
			const response = await fetch("/api/ai-connections", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider, apiKey, modelName, baseUrl, requestSettingsJson, keepExistingKey: ${connection ? "true" : "false"} }),
			});
			const data = await response.json().catch(() => ({}));
			message.textContent = response.ok ? "Saved AI connection." : (data.error || "Could not save AI connection.");
		});
		document.getElementById("deleteAi")?.addEventListener("click", async () => {
			const response = await fetch("/api/ai-connections/" + provider, { method: "DELETE" });
			const data = await response.json().catch(() => ({}));
			message.textContent = response.ok ? "Deleted AI connection." : (data.error || "Could not delete AI connection.");
		});
		document.getElementById("makeDefault")?.addEventListener("click", async () => {
			const response = await fetch("/api/ai-preferences", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ defaultProvider: provider }),
			});
			const data = await response.json().catch(() => ({}));
			message.textContent = response.ok ? "Saved as default AI model." : (data.error || "Could not save default model.");
		});
		const modelInput = form?.elements.model;
		const requestSettingsInput = form?.elements.requestSettings;
		modelInput?.addEventListener("input", () => {
			if (provider !== "groq" || !modelInput.value.trim().toLowerCase().startsWith("openai/gpt-oss-")) return;
			const current = requestSettingsInput.value.trim();
			if (!current || current === "{}") {
				requestSettingsInput.value = JSON.stringify({ include_reasoning: false, reasoning_effort: "low", max_completion_tokens: 4000 }, null, 2);
			}
		});
	</script>`;
	return c.html(settingsShell(provider.label, body));
});

utilityRoutes.get("/settings/messaging/telegram", async (c) => {
	const session = await getSettingsSession(c);
	const telegram = session ? await getTelegramConnection(c.env, session) : null;
	const schedules = session ? await listUserMessageSchedules(c.env, session) : [];
	const telegramReady = Boolean(
		c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_BOT_USERNAME,
	);
	const telegramHelper = telegramReady
		? `Click Connect Telegram to open @${escapeHtml(c.env.TELEGRAM_BOT_USERNAME ?? "your_bot")} and link your account with a secure one-time code.`
		: "A Telegram bot token and bot username must be configured in Cloudflare before the deep link can be used in production.";
	const initialSchedules = schedules.length
		? schedules
		: [
				{
					id: "",
					title: "Morning recovery briefing",
					enabled: false,
					timezone: "America/New_York",
					times: ["06:00"],
					insightMode: "smart",
					categories: ["hrv", "sleep", "fitness_activities"],
					question:
						"Should I train hard today based on recovery and recent activity?",
					promptInstructions: "",
				},
			];
	const categoryChecks = (selected: string[]) =>
		HEALTH_CATEGORIES.map(
			(category) => `<label class="check-card">
				<input name="categories" type="checkbox" value="${category.id}" ${selected.includes(category.id) ? "checked" : ""}>
				<span>${escapeHtml(category.label)}<small>${escapeHtml(category.description)}</small></span>
			</label>`,
		).join("");
	const renderMessageCard = (schedule: (typeof initialSchedules)[number], index: number) => {
		const times = schedule.times.length ? schedule.times : ["10:00"];
		return `<form class="panel schedule-card" data-message-form data-id="${escapeHtml(schedule.id)}">
			<div class="schedule-head">
				<div class="schedule-title">
					<div class="schedule-title-row">
						<span class="status">${schedule.enabled ? "Enabled" : "Draft"}</span>
						<h3 data-message-title>${escapeHtml(schedule.title || `Message ${index + 1}`)}</h3>
					</div>
				</div>
				<div class="actions" style="margin-top:0;">
					<button type="button" data-toggle-message>Collapse</button>
					<button type="button" class="danger" data-delete-message>Delete</button>
				</div>
			</div>
			<div class="schedule-body">
				<label>
					<input name="enabled" type="checkbox" ${schedule.enabled ? "checked" : ""} style="width:auto; min-height:auto; margin-right:8px;">
					Enable this scheduled message
				</label>
				<label>Message name</label>
				<input name="title" value="${escapeHtml(schedule.title)}" placeholder="Morning recovery briefing">
				<div class="row">
					<div>
						<label>Timezone</label>
						<select name="timezone">${timezoneOptions(schedule.timezone)}</select>
					</div>
					<div>
						<label>Insight mode</label>
						<select name="insightMode">
							<option value="smart" ${schedule.insightMode === "smart" ? "selected" : ""}>Smart</option>
							<option value="today_so_far" ${schedule.insightMode === "today_so_far" ? "selected" : ""}>Today so far</option>
							<option value="previous_day" ${schedule.insightMode === "previous_day" ? "selected" : ""}>Previous day</option>
						</select>
					</div>
				</div>
				<label>Insight times</label>
				<div data-times>${times.map((time) => `<div class="row time-row"><input name="times" value="${escapeHtml(time)}" placeholder="HH:MM"><button type="button" data-remove-time>Remove</button></div>`).join("")}</div>
				<div class="actions"><button type="button" data-add-time>Add time</button></div>
				<label>Include data categories</label>
				<div class="checkbox-grid" data-categories>${categoryChecks(schedule.categories)}</div>
				<div class="helper">ZorFit uses your Data Routing settings to decide which provider supplies each selected category.</div>
				<label>Question or instruction</label>
				<textarea name="question" maxlength="${MESSAGE_QUESTION_LIMIT}" placeholder="Example: Should I train hard today based on recovery, sleep, and recent activity?">${escapeHtml(schedule.question ?? "")}</textarea>
				<div class="question-bank" data-question-bank></div>
				<div class="field-meta">
					<label>Style instructions</label>
					<span class="count" data-prompt-count>0/${PROMPT_INSTRUCTIONS_LIMIT}</span>
				</div>
				<textarea class="large-textarea" name="promptInstructions" maxlength="${PROMPT_INSTRUCTIONS_LIMIT}" placeholder="Example: Be direct but supportive. Include the not-medical-advice disclaimer.">${escapeHtml(schedule.promptInstructions ?? "")}</textarea>
				<div class="actions">
					<button class="primary" type="submit" ${session ? "" : "disabled"}>Save message</button>
					<button type="button" data-test-message ${session ? "" : "disabled"}>Send test now</button>
				</div>
				<div data-message-status id="message"></div>
			</div>
		</form>`;
	};
	const blankCard = renderMessageCard(
		{
			id: "",
			title: "New ZorFit insight",
			enabled: false,
			timezone: "America/New_York",
			times: ["10:00"],
			insightMode: "smart",
			categories: ["nutrition"],
			question: "Summarize what I should focus on next.",
			promptInstructions: "",
		},
		99,
	);
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Messaging</span>
				<h1>Telegram insight builder.</h1>
				<p class="lede">Create multiple scheduled messages. Each message chooses the health data categories ZorFit should fetch before asking your selected AI model.</p>
			</div>
			<div class="panel">
				<strong>${telegram?.enabled ? "Connected" : session ? "Ready to connect" : "Sign in required"}</strong>
				<p>${telegram?.externalUsername ? `Linked to @${escapeHtml(telegram.externalUsername)}.` : "Users click Connect Telegram, open the ZorFit bot, and link with a short-lived code. No chat ID paste required."}</p>
			</div>
		</section>
		<div class="panel">
			<div class="actions">
				<button class="primary" id="connectTelegram" type="button" ${session && telegramReady ? "" : "disabled"}>${telegram?.enabled ? "Reconnect Telegram" : "Connect Telegram"}</button>
				<a class="button" href="/settings/messages">Back to messages</a>
				<a class="button" href="/settings/data-routing">Data routing</a>
			</div>
			<div class="helper" id="telegramLinkMessage">${telegramHelper}</div>
		</div>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Scheduled messages</span>
					<h2>Build Telegram check-ins.</h2>
				</div>
				<div class="actions" style="margin-top:0;">
					<button type="button" id="collapseAllMessages">Collapse all</button>
					<button type="button" id="expandAllMessages">Expand all</button>
					<button class="primary" type="button" id="addMessage">+ New message</button>
				</div>
			</div>
			<div id="messageList">${initialSchedules.map(renderMessageCard).join("")}</div>
		</section>
	</main>
	<script>
		const promptLimit = ${PROMPT_INSTRUCTIONS_LIMIT};
		const questionLimit = ${MESSAGE_QUESTION_LIMIT};
		const blankCardHtml = ${JSON.stringify(blankCard)};
		const linkMessage = document.getElementById("telegramLinkMessage");
		document.getElementById("connectTelegram")?.addEventListener("click", async () => {
			const response = await fetch("/api/telegram/link-code", { method: "POST" });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				linkMessage.textContent = data.error || "Could not create Telegram link.";
				return;
			}
			const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(data.botUrl);
			linkMessage.innerHTML =
				'<div class="qr-link-panel">' +
					'<div>' +
						'<p><strong>Option 1: open on this device</strong></p>' +
						'<a class="button primary" href="' + data.botUrl + '" target="_blank" rel="noreferrer">Open Telegram</a>' +
						'<p style="margin-top:12px;"><strong>Option 2: scan from mobile</strong></p>' +
						'<p>Open your phone camera or Telegram QR scanner, scan the code, then tap Start to link your account.</p>' +
						'<p><a href="' + data.botUrl + '" target="_blank" rel="noreferrer">' + data.botUrl + '</a></p>' +
					'</div>' +
					'<img alt="Telegram link QR code" src="' + qrUrl + '">' +
				'</div>';
			window.open(data.botUrl, "_blank", "noopener,noreferrer");
		});
		function selectedCategories(form) {
			return Array.from(form.querySelectorAll('input[name="categories"]:checked')).map((input) => input.value);
		}
		async function refreshQuestionBank(form) {
			const bank = form.querySelector("[data-question-bank]");
			const response = await fetch("/api/question-bank", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ categories: selectedCategories(form) }),
			});
			const data = await response.json().catch(() => ({ questions: [] }));
			bank.innerHTML = (data.questions || []).map((question) => {
				const safe = question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
				return '<button type="button" data-question="' + safe + '">' + safe + '</button>';
			}).join("");
		}
		function payloadForForm(form) {
			return {
				id: form.dataset.id || undefined,
				title: form.elements.title.value.trim(),
				enabled: form.elements.enabled.checked,
				timezone: form.elements.timezone.value.trim(),
				insightMode: form.elements.insightMode.value,
				times: Array.from(form.querySelectorAll('input[name="times"]')).map((input) => input.value.trim()),
				categories: selectedCategories(form),
				question: form.elements.question.value.trim().slice(0, questionLimit),
				promptInstructions: form.elements.promptInstructions.value.trim(),
			};
		}
		function wireForm(form) {
			const prompt = form.elements.promptInstructions;
			const count = form.querySelector("[data-prompt-count]");
			const updateCount = () => { count.textContent = prompt.value.length + "/" + promptLimit; };
			prompt.addEventListener("input", updateCount);
			updateCount();
			const titleInput = form.elements.title;
			const titleDisplay = form.querySelector("[data-message-title]");
			titleInput?.addEventListener("input", () => {
				titleDisplay.textContent = titleInput.value.trim() || "Untitled message";
			});
			const setCollapsed = (collapsed) => {
				form.classList.toggle("collapsed", collapsed);
				const button = form.querySelector("[data-toggle-message]");
				if (button) button.textContent = collapsed ? "Expand" : "Collapse";
			};
			form.querySelector("[data-add-time]")?.addEventListener("click", () => {
				const row = document.createElement("div");
				row.className = "row time-row";
				row.innerHTML = '<input name="times" value="12:00" placeholder="HH:MM"><button type="button" data-remove-time>Remove</button>';
				form.querySelector("[data-times]").appendChild(row);
			});
			form.addEventListener("click", async (event) => {
				if (event.target.dataset?.removeTime !== undefined) event.target.closest(".time-row")?.remove();
				if (event.target.dataset?.question) form.elements.question.value = event.target.dataset.question;
				if (event.target.dataset?.toggleMessage !== undefined) {
					setCollapsed(!form.classList.contains("collapsed"));
				}
				if (event.target.dataset?.deleteMessage !== undefined) {
					if (!form.dataset.id) {
						form.remove();
						return;
					}
					const response = await fetch("/api/message-schedules/" + form.dataset.id, { method: "DELETE" });
					if (response.ok) {
						form.remove();
					} else {
						const data = await response.json().catch(() => ({}));
						form.querySelector("[data-message-status]").textContent = data.error || "Could not delete message.";
					}
				}
				if (event.target.dataset?.testMessage !== undefined) {
					const status = form.querySelector("[data-message-status]");
					event.target.disabled = true;
					status.textContent = "Generating and sending test message...";
					const response = await fetch("/api/telegram/test-message-insight", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payloadForForm(form)),
					});
					const data = await response.json().catch(() => ({}));
					status.textContent = response.ok ? "Test message sent to Telegram." : (data.error || "Could not send test message.");
					event.target.disabled = false;
				}
			});
			form.querySelector("[data-categories]")?.addEventListener("change", () => refreshQuestionBank(form));
			form.addEventListener("submit", async (event) => {
				event.preventDefault();
				const status = form.querySelector("[data-message-status]");
				const response = await fetch("/api/message-schedules", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payloadForForm(form)),
				});
				const data = await response.json().catch(() => ({}));
				if (response.ok) {
					form.dataset.id = data.id;
					status.textContent = "Saved message schedule.";
				} else {
					status.textContent = data.error || "Could not save message schedule.";
				}
			});
			refreshQuestionBank(form);
		}
		document.querySelectorAll("[data-message-form]").forEach(wireForm);
		document.getElementById("addMessage")?.addEventListener("click", () => {
			const wrapper = document.createElement("div");
			wrapper.innerHTML = blankCardHtml;
			const form = wrapper.firstElementChild;
			document.getElementById("messageList").appendChild(form);
			wireForm(form);
		});
		document.getElementById("collapseAllMessages")?.addEventListener("click", () => {
			document.querySelectorAll("[data-message-form]").forEach((form) => {
				form.classList.add("collapsed");
				const button = form.querySelector("[data-toggle-message]");
				if (button) button.textContent = "Expand";
			});
		});
		document.getElementById("expandAllMessages")?.addEventListener("click", () => {
			document.querySelectorAll("[data-message-form]").forEach((form) => {
				form.classList.remove("collapsed");
				const button = form.querySelector("[data-toggle-message]");
				if (button) button.textContent = "Collapse";
			});
		});
	</script>`;
	return c.html(settingsShell("Telegram", body));
});

utilityRoutes.get("/settings/messaging/:id", async (c) => {
	const id = c.req.param("id");
	const service = MESSAGING_SETTINGS.find((item) => item.id === id);
	if (!service) return c.text("Unknown messaging service", 404);
	const session = await getSettingsSession(c);
	const telegram = session ? await getTelegramConnection(c.env, session) : null;
	const schedule = session
		? await getNotificationSchedule(c.env, session)
		: null;
	const times = schedule?.times.length
		? schedule.times
		: ["06:00", "10:00", "15:00", "22:00"];
	const selectedTimezone = schedule?.timezone ?? "America/New_York";
	const telegramReady = Boolean(
		c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_BOT_USERNAME,
	);
	const telegramHelper = telegramReady
		? `Click Connect Telegram to open @${escapeHtml(c.env.TELEGRAM_BOT_USERNAME ?? "your_bot")} and link your account with a secure one-time code.`
		: "A Telegram bot token and bot username must be configured in Cloudflare before the deep link can be used in production.";
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Messaging</span>
				<h1>${service.label}</h1>
				<p class="lede">${service.description}</p>
			</div>
			<div class="panel">
				<strong>${telegram?.enabled ? "Connected" : session ? "Ready to connect" : "Sign in required"}</strong>
				<p>${telegram?.externalUsername ? `Linked to @${escapeHtml(telegram.externalUsername)}.` : "Users click Connect Telegram, open the ZorFit bot, and link with a short-lived code. No chat ID paste required."}</p>
			</div>
		</section>
		<div class="panel">
			<div class="actions">
				<button class="primary" id="connectTelegram" type="button" ${session && telegramReady ? "" : "disabled"}>${telegram?.enabled ? "Reconnect Telegram" : "Connect Telegram"}</button>
				<a class="button" href="/settings/messages">Back to messages</a>
			</div>
			<div class="helper" id="telegramLinkMessage">${telegramHelper}</div>
		</div>
		<form class="panel" id="scheduleForm">
			<label>
				<input id="enabled" name="enabled" type="checkbox" ${schedule?.enabled ? "checked" : ""} style="width:auto; min-height:auto; margin-right:8px;">
				Enable nutrition insight pushes
			</label>
			<div class="row">
				<div>
					<label for="timezone">Timezone</label>
					<select id="timezone" name="timezone">${timezoneOptions(selectedTimezone)}</select>
				</div>
				<div>
					<label for="insightMode">Insight mode</label>
					<input id="insightMode" name="insightMode" value="${escapeHtml(schedule?.insightMode ?? "smart")}" placeholder="smart">
				</div>
			</div>
			<label>Insight times</label>
			<div id="times">${times.map((time) => `<div class="row time-row"><input name="times" value="${escapeHtml(time)}" placeholder="HH:MM"><button type="button" data-remove-time>Remove</button></div>`).join("")}</div>
			<div class="field-meta">
				<label for="promptInstructions">Insight instructions</label>
				<span class="count" id="promptCount">0/${PROMPT_INSTRUCTIONS_LIMIT}</span>
			</div>
			<textarea class="large-textarea" id="promptInstructions" name="promptInstructions" maxlength="${PROMPT_INSTRUCTIONS_LIMIT}" placeholder="Example: Focus on protein and fiber. Keep it under 5 bullets. Avoid motivational language.">${escapeHtml(schedule?.promptInstructions ?? "")}</textarea>
			<div class="actions">
				<button type="button" id="addTime">Add time</button>
				<button class="primary" type="submit" ${session ? "" : "disabled"}>Save schedule</button>
				<button type="button" id="sendTestInsight" ${session ? "" : "disabled"}>Send test nutrition insight now</button>
			</div>
			<div class="helper">Instructions guide style and focus only. Every Telegram insight still includes a medical-advice disclaimer.</div>
			<div id="message"></div>
		</form>
	</main>
	<script>
		const linkMessage = document.getElementById("telegramLinkMessage");
		const promptInstructions = document.getElementById("promptInstructions");
		const promptCount = document.getElementById("promptCount");
		const promptLimit = ${PROMPT_INSTRUCTIONS_LIMIT};
		const updatePromptCount = () => {
			if (!promptInstructions || !promptCount) return;
			promptCount.textContent = promptInstructions.value.length + "/" + promptLimit;
		};
		promptInstructions?.addEventListener("input", updatePromptCount);
		updatePromptCount();
		document.getElementById("connectTelegram")?.addEventListener("click", async () => {
			const response = await fetch("/api/telegram/link-code", { method: "POST" });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				linkMessage.textContent = data.error || "Could not create Telegram link.";
				return;
			}
			const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(data.botUrl);
			linkMessage.innerHTML =
				'<div class="qr-link-panel">' +
					'<div>' +
						'<p><strong>Option 1: open on this device</strong></p>' +
						'<a class="button primary" href="' + data.botUrl + '" target="_blank" rel="noreferrer">Open Telegram</a>' +
						'<p style="margin-top:12px;"><strong>Option 2: scan from mobile</strong></p>' +
						'<p>Open your phone camera or Telegram QR scanner, scan the code, then tap Start to link your account.</p>' +
						'<p><a href="' + data.botUrl + '" target="_blank" rel="noreferrer">' + data.botUrl + '</a></p>' +
					'</div>' +
					'<img alt="Telegram link QR code" src="' + qrUrl + '">' +
				'</div>';
			window.open(data.botUrl, "_blank", "noopener,noreferrer");
		});
		const times = document.getElementById("times");
		document.getElementById("addTime")?.addEventListener("click", () => {
			const row = document.createElement("div");
			row.className = "row time-row";
			row.innerHTML = '<input name="times" value="12:00" placeholder="HH:MM"><button type="button" data-remove-time>Remove</button>';
			times.appendChild(row);
		});
		times?.addEventListener("click", (event) => {
			if (event.target.dataset?.removeTime !== undefined) event.target.closest(".time-row")?.remove();
		});
		document.getElementById("scheduleForm")?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const payload = {
				enabled: form.elements.enabled.checked,
				timezone: form.elements.timezone.value.trim(),
				insightMode: form.elements.insightMode.value.trim(),
				times: Array.from(form.querySelectorAll('input[name="times"]')).map((input) => input.value.trim()),
				promptInstructions: form.elements.promptInstructions.value.trim(),
			};
			const response = await fetch("/api/notification-schedule", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = await response.json().catch(() => ({}));
			document.getElementById("message").textContent = response.ok ? "Saved notification schedule." : (data.error || "Could not save schedule.");
		});
		document.getElementById("sendTestInsight")?.addEventListener("click", async (event) => {
			const button = event.currentTarget;
			button.disabled = true;
			document.getElementById("message").textContent = "Generating and sending test insight...";
			const response = await fetch("/api/telegram/test-nutrition-insight", { method: "POST" });
			const data = await response.json().catch(() => ({}));
			document.getElementById("message").textContent = response.ok ? "Test nutrition insight sent to Telegram." : (data.error || "Could not send test insight.");
			button.disabled = false;
		});
	</script>`;
	return c.html(settingsShell(service.label, body));
});

utilityRoutes.get("/coach", async (c) => {
	const session = await getSettingsSession(c);
	const categoryChecks = HEALTH_CATEGORIES.map(
		(category) => `<label class="check-card">
			<input name="categories" type="checkbox" value="${category.id}" ${["nutrition", "fitness_activities", "recovery"].includes(category.id) ? "checked" : ""}>
			<span>${escapeHtml(category.label)}<small>${escapeHtml(category.description)}</small></span>
		</label>`,
	).join("");
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Coach chat</span>
				<h1>Ask your training data anything.</h1>
				<p class="lede">Pick the health categories ZorFit should fetch, ask a question, and get an answer using your selected AI provider.</p>
			</div>
			<div class="panel">
				<strong>${session ? `Signed in as @${escapeHtml(session.login)}` : "Sign in required"}</strong>
				<p>${session ? "Coach Chat uses your Data Routing and AI Connection settings." : "Sign in before chatting with your ZorFit data."}</p>
			</div>
		</section>
		<section class="section">
			<div class="actions">
				<a class="button" href="/settings/data-routing">Data routing</a>
				<a class="button" href="/settings/ai">AI settings</a>
				<a class="button" href="/settings/messages">Messages</a>
				<a class="button" id="diagnoseQuestion" href="/diagnostics">Diagnose question</a>
			</div>
			<div class="panel">
				<label>Use these data categories</label>
				<div class="checkbox-grid" id="coachCategories">${categoryChecks}</div>
				<div class="question-bank" id="coachQuestionBank"></div>
				<div class="chat-window" id="chatWindow">
					<div class="chat-message">Select categories, choose a suggested question, or type your own.</div>
				</div>
				<form id="coachForm">
					<label for="coachQuestion">Question</label>
					<textarea id="coachQuestion" name="question" placeholder="Example: Why is recovery lower and what should I do today?"></textarea>
					<div class="actions">
						<button class="primary" type="submit" ${session ? "" : "disabled"}>Ask ZorFit</button>
					</div>
					<div id="message"></div>
				</form>
			</div>
		</section>
	</main>
	<script>
		const chatWindow = document.getElementById("chatWindow");
		const form = document.getElementById("coachForm");
		function selectedCategories() {
			return Array.from(document.querySelectorAll('#coachCategories input[name="categories"]:checked')).map((input) => input.value);
		}
		function appendMessage(text, role) {
			const div = document.createElement("div");
			div.className = "chat-message " + (role || "");
			div.textContent = text;
			chatWindow.appendChild(div);
			chatWindow.scrollTop = chatWindow.scrollHeight;
		}
		async function refreshBank() {
			const response = await fetch("/api/question-bank", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ categories: selectedCategories() }),
			});
			const data = await response.json().catch(() => ({ questions: [] }));
			document.getElementById("coachQuestionBank").innerHTML = (data.questions || []).map((question) => {
				const safe = question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
				return '<button type="button" data-question="' + safe + '">' + safe + '</button>';
			}).join("");
		}
		document.getElementById("coachCategories").addEventListener("change", refreshBank);
		document.getElementById("coachQuestionBank").addEventListener("click", (event) => {
			if (event.target.dataset?.question) {
				form.elements.question.value = event.target.dataset.question;
				updateDiagnosticLink();
			}
		});
		function updateDiagnosticLink() {
			const question = form.elements.question.value.trim();
			const params = new URLSearchParams();
			if (question) params.set("q", question);
			for (const category of selectedCategories()) params.append("category", category);
			document.getElementById("diagnoseQuestion").href = "/diagnostics" + (params.toString() ? "?" + params.toString() : "");
		}
		form.elements.question.addEventListener("input", updateDiagnosticLink);
		document.getElementById("coachCategories").addEventListener("change", updateDiagnosticLink);
		form?.addEventListener("submit", async (event) => {
			event.preventDefault();
			const question = form.elements.question.value.trim();
			if (!question) return;
			appendMessage(question, "user");
			form.elements.question.value = "";
			document.getElementById("message").textContent = "Fetching data and asking your AI model...";
			const response = await fetch("/api/coach-chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question, categories: selectedCategories() }),
			});
			const data = await response.json().catch(() => ({}));
			appendMessage(response.ok ? data.answer : (data.error || "Could not answer."), "");
			document.getElementById("message").textContent = "";
		});
		updateDiagnosticLink();
		refreshBank();
	</script>`;
	return c.html(settingsShell("Coach Chat", body));
});

utilityRoutes.get("/diagnostics", async (c) => {
	const session = await getSettingsSession(c);
	const question = normalizeMessageQuestion(
		c.req.query("q") || "Can ZorFit answer my health and training question accurately right now?",
	) ?? "Can ZorFit answer my health and training question accurately right now?";
	if (!session) {
		const body = `<main class="shell">
			<section class="hero">
				<div>
					<span class="eyebrow">Question diagnostics</span>
					<h1>Diagnose answer readiness.</h1>
					<p class="lede">Sign in to check whether ZorFit has the right data to answer a specific health, nutrition, recovery, or training question.</p>
				</div>
				<div class="panel">
					<strong>Sign in required</strong>
					<p>Diagnostics check your connected sources and data routing before answering.</p>
					<a class="button primary" href="/signin">Sign in</a>
				</div>
			</section>
		</main>`;
		return c.html(settingsShell("Diagnostics", body));
	}
	const timezone = normalizeTimezone(c.req.query("timezone") || "America/New_York");
	const date = localDateForTimezone(timezone);
	const selectedCategories = c.req.queries("category") ?? [];
	const requiredCategories = selectedCategories.length
		? normalizeHealthCategories(selectedCategories)
		: categoriesForQuestion(question);
	const context = await collectHealthContext(c.env, session, {
		categories: requiredCategories,
		timezone,
		date,
		rangeDays: /pattern|weekly|trend|cause|why/i.test(question) ? 42 : 7,
	});
	const diagnostic = buildQuestionDiagnostic(question, context, requiredCategories);
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Question diagnostics</span>
				<h1>Can ZorFit answer this?</h1>
				<p class="lede">Question-level RCA for @${escapeHtml(session.login)}. It checks required evidence, missing data, assumptions, and fix links before the coach answers.</p>
			</div>
			<div class="panel">
				<form method="GET">
					<label for="q">Question</label>
					<textarea id="q" name="q">${escapeHtml(question)}</textarea>
					<div class="actions"><button class="primary" type="submit">Run diagnostics</button><a class="button" href="/coach">Back to coach</a></div>
				</form>
			</div>
		</section>
		${renderQuestionDiagnostic(diagnostic)}
	</main>`;
	return c.html(settingsShell("Diagnostics", body));
});

utilityRoutes.get("/my-day", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) {
		const body = `<main class="shell">
			<section class="hero">
				<div>
					<span class="eyebrow">My day so far</span>
					<h1>Your day becomes a timeline.</h1>
					<p class="lede">Sign in to see message check-ins, nutrition notes, recovery signals, and workout moments in one running view.</p>
				</div>
				<div class="panel">
					<strong>Sign in required</strong>
					<p>Use Google or GitHub sign-in, then configure your message schedule.</p>
					<a class="button primary" href="/signin">Sign in</a>
				</div>
			</section>
		</main>`;
		return c.html(settingsShell("My Day So Far", body));
	}

	const schedules = await listUserMessageSchedules(c.env, session);
	const logsSince = new Date();
	logsSince.setUTCDate(logsSince.getUTCDate() - 3);
	const [logs, scorePreferences] = await Promise.all([
		listNotificationLogs(c.env, session, {
			sinceIso: logsSince.toISOString(),
			limit: 100,
		}),
		getScorePreferences(c.env, session),
	]);
	const timezone = normalizeTimezone(
		c.req.query("timezone") || schedules[0]?.timezone || "America/New_York",
	);
	const local = localDateTimeForTimezone(timezone);
	const timelineConfigured = c.req.query("timeline") === "1";
	const timelineOptions: TimelineOptions = {
		includeSentMessages: timelineConfigured ? c.req.query("sent") === "1" : true,
		includeYesterdaySummary: timelineConfigured
			? c.req.query("yesterday") === "1"
			: true,
		includeEventTimeline: timelineConfigured
			? c.req.query("events") === "1"
			: true,
	};
	const categories = configuredCategories(schedules);
	const context = await collectHealthContext(c.env, session, {
		categories,
		timezone,
		date: local.date,
		rangeDays: 7,
	});
	const scores = scoreSummary(context, scorePreferences);
	const timeline = buildMyDayTimeline(
		schedules,
		logs,
		context,
		local.date,
		local.time,
		timelineOptions,
	);
	const macroLine = nutritionMacroLine(context);
	const kpis = myDayKpis(context);
	const cronometerScores = cronometerScoreCards(context);
	const readySources = context.categories.filter(
		(category) => category.status === "ready",
	).length;
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">My day so far</span>
				<h1>Track the day as it happens.</h1>
				<p class="lede">A timeline of scheduled ZorFit check-ins, nutrition briefs, recovery reads, and workout nudges for ${escapeHtml(local.date)}.</p>
			</div>
			<div class="panel">
				<strong>Signed in as @${escapeHtml(session.login)}</strong>
				<p>${escapeHtml(timezone)} · ${escapeHtml(local.time)} local time</p>
				<div class="actions">
					<a class="button" href="/settings/messages">Edit messages</a>
					<a class="button" href="/settings/data-routing">Data routing</a>
					<a class="button" href="/settings/scoring">Score formula</a>
				</div>
			</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Scores</span>
					<h2>Today at a glance.</h2>
				</div>
				<p>${readySources} health categories returned data${macroLine ? ` · ${escapeHtml(macroLine)}` : ""}</p>
			</div>
			<div class="score-grid">
				${renderScoreCard("Overall score", scores.overall)}
				${renderScoreCard("Nutrition score", scores.nutrition)}
				${renderScoreCard("Readiness score", scores.readiness)}
				${renderScoreCard("Fitness score", scores.fitness)}
			</div>
			<div class="motivation">
				<h3>Coach note</h3>
				<p>${escapeHtml(motivationalMessage(scores))}</p>
			</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Targets</span>
					<h2>Goal drift.</h2>
				</div>
				<p>The coach can now show whether today moves the 1-3 active goals closer or farther away.</p>
			</div>
			<div class="panel">${renderGoalTracking(context, scorePreferences)}</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Pre-workout</span>
					<h2>Brief before the session.</h2>
				</div>
				<p>Use this as the 30-60 minute workout prompt when a scheduled session is detected.</p>
			</div>
			${renderPreWorkoutBrief(scores.readiness.score)}
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Messaging</span>
					<h2>Morning and missed check-ins.</h2>
				</div>
				<p>Extends the Telegram nutrition push into a fuller coach briefing.</p>
			</div>
			${renderMorningBrief(context, scores)}
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Vitals</span>
					<h2>Today at a glance.</h2>
				</div>
				<p>Key recovery metrics compared with the recent seven-day window.</p>
			</div>
			<div class="kpi-grid">${kpis.map(renderKpiCard).join("")}</div>
		</section>
		${
			cronometerScores.length
				? `<section class="section">
					<div class="section-head">
						<div>
							<span class="eyebrow">Cronometer</span>
							<h2>Nutrition quality scores.</h2>
						</div>
						<p>Shown when Cronometer returns nutrition score categories.</p>
					</div>
					<div class="kpi-grid">${cronometerScores.map(renderKpiCard).join("")}</div>
				</section>`
				: ""
		}
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Timeline</span>
					<h2>My day so far.</h2>
				</div>
				<p>Completed message slots appear here after the scheduler sends them. New sends show the generated summary instead of the original question.</p>
			</div>
			<form class="panel" method="GET">
				<input type="hidden" name="timeline" value="1">
				<div class="controls-grid">
					<label class="check-card">
						<input name="sent" type="checkbox" value="1" ${timelineOptions.includeSentMessages ? "checked" : ""}>
						<span>Include sent messages<small>Show Telegram messages and pending scheduled slots.</small></span>
					</label>
					<label class="check-card">
						<input name="yesterday" type="checkbox" value="1" ${timelineOptions.includeYesterdaySummary ? "checked" : ""}>
						<span>Include yesterday summary<small>Show a basic previous-day nutrition checkpoint.</small></span>
					</label>
					<label class="check-card">
						<input name="events" type="checkbox" value="1" ${timelineOptions.includeEventTimeline ? "checked" : ""}>
						<span>Include event timeline<small>Wake-up, meals, snack, workout, and dinner checkpoints.</small></span>
					</label>
				</div>
				<div class="actions"><button type="submit">Update timeline</button></div>
			</form>
			<div class="panel">
				<div class="timeline">
					${timeline.map(renderTimelineItem).join("")}
				</div>
			</div>
		</section>
	</main>`;
	return c.html(settingsShell("My Day So Far", body));
});

utilityRoutes.get("/my-week", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) {
		const body = `<main class="shell">
			<section class="hero">
				<div>
					<span class="eyebrow">Weekly review</span>
					<h1>Your week becomes a coach verdict.</h1>
					<p class="lede">Sign in to summarize load, nutrition consistency, recovery highs and lows, and learned patterns across the last 4-8 weeks.</p>
				</div>
				<div class="panel">
					<strong>Sign in required</strong>
					<p>Weekly review uses your connected training, nutrition, and recovery sources.</p>
					<a class="button primary" href="/signin">Sign in</a>
				</div>
			</section>
		</main>`;
		return c.html(settingsShell("My Week", body));
	}
	const timezone = normalizeTimezone(c.req.query("timezone") || "America/New_York");
	const date = localDateForTimezone(timezone);
	const [context, scorePreferences] = await Promise.all([
		collectHealthContext(c.env, session, {
			categories: [
				"nutrition",
				"hrv",
				"sleep",
				"fitness_activities",
				"gym_workouts",
				"steps",
				"recovery",
			],
			timezone,
			date,
			rangeDays: 42,
		}),
		getScorePreferences(c.env, session),
	]);
	const scores = scoreSummary(context, scorePreferences);
	const weeklyLoad = realWeeklyLoad(context);
	const recoveryDays = weeklyLoad.filter((point) => point.recovery > 0);
	const bestRecovery = recoveryDays.reduce<WeeklyLoadPoint | undefined>(
		(best, point) => (!best || point.recovery > best.recovery ? point : best),
		undefined,
	);
	const worstRecovery = recoveryDays.reduce<WeeklyLoadPoint | undefined>(
		(worst, point) => (!worst || point.recovery < worst.recovery ? point : worst),
		undefined,
	);
	const loadChart = weeklyLoad.some((point) => point.load > 0)
		? renderBarChart(weeklyLoad, "load")
		: `<p>No real training load records were returned by Intervals.icu, Strava, Hevy, or steps for this window.</p>`;
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Weekly review</span>
				<h1>Weekly review from connected data.</h1>
				<p class="lede">Auto-generated weekly summary for @${escapeHtml(session.login)} from routed source data for ${escapeHtml(date)}.</p>
			</div>
			<div class="panel">
				${renderFreshnessPanel()}
				<div class="actions">
					<a class="button primary" href="/reports">Export report</a>
					<a class="button" href="/my-day">Back to My Day</a>
				</div>
			</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Load and consistency</span>
					<h2>Seven-day read.</h2>
				</div>
				<p>Designed as the share-card source for retention and accountability.</p>
			</div>
			<div class="grid">
				<article class="panel">
					<h3>Training load trend</h3>
					${loadChart}
				</article>
				<article class="panel">
					<h3>Nutrition consistency</h3>
					<div class="score-ring" style="--score: ${scores.nutrition.score}%">
						<div><strong>${scores.nutrition.score}</strong><span>${escapeHtml(scoreBand(scores.nutrition.score))} from Cronometer/routed nutrition</span></div>
					</div>
				</article>
				${renderKpiCard({
					label: "Best recovery day",
					value: bestRecovery?.label ?? "No data",
					bottomLine: bestRecovery ? `${bestRecovery.recovery} recovery metric from routed data.` : "No recovery series returned by HRV/sleep/recovery sources.",
					trend: bestRecovery ? "from real source data" : "connect recovery",
				})}
				${renderKpiCard({
					label: "Lowest recovery day",
					value: worstRecovery?.label ?? "No data",
					bottomLine: worstRecovery ? `${worstRecovery.recovery} recovery metric from routed data.` : "No recovery series returned by HRV/sleep/recovery sources.",
					trend: worstRecovery ? "from real source data" : "connect recovery",
				})}
			</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Pattern detection</span>
					<h2>Not one-off insights.</h2>
				</div>
				<p>These are recurring correlations the coach can learn over 4-8 weeks.</p>
			</div>
			<div class="panel">${renderPatternCards(context)}</div>
		</section>
		<section class="section">
			<div class="motivation">
				<h3>One coach verdict</h3>
				<p>${escapeHtml(motivationalMessage(scores))}</p>
			</div>
		</section>
	</main>`;
	return c.html(settingsShell("My Week", body));
});

utilityRoutes.get("/my-fitness", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) {
		const body = `<main class="shell">
			<section class="hero">
				<div>
					<span class="eyebrow">Fitness trends</span>
					<h1>Connect sources to see real trends.</h1>
					<p class="lede">Training load, nutrition trend, and body composition only render after ZorFit can read your connected data.</p>
				</div>
				<div class="panel">
					<strong>Sign in required</strong>
					<p>Use Google or GitHub sign-in, then connect Intervals.icu, Cronometer, Strava, Hevy, or a weight source.</p>
					<a class="button primary" href="/signin">Sign in</a>
				</div>
			</section>
		</main>`;
		return c.html(settingsShell("My Fitness", body));
	}
	const timezone = normalizeTimezone(c.req.query("timezone") || "America/New_York");
	const date = localDateForTimezone(timezone);
	const [context, scorePreferences] = await Promise.all([
		collectHealthContext(c.env, session, {
			categories: ["nutrition", "fitness_activities", "gym_workouts", "recovery", "hrv", "sleep"],
			timezone,
			date,
			rangeDays: 42,
		}),
		getScorePreferences(c.env, session),
	]);
	const atl = firstMetricSeries(context, ["fitness_activities", "recovery"], [/^atl$|fatigue|acute.*load/i]);
	const ctl = firstMetricSeries(context, ["fitness_activities", "recovery"], [/^ctl$|fitness|chronic.*load/i]);
	const tsb = firstMetricSeries(context, ["fitness_activities", "recovery"], [/^tsb$|form|balance/i]);
	const loadSeriesLength = Math.max(atl.length, ctl.length, tsb.length);
	const loadTrendPoints: TrendPoint[] = Array.from({ length: Math.min(6, loadSeriesLength) }, (_, index) => {
		const offset = Math.max(0, loadSeriesLength - 6) + index;
		return {
			label: `W${index + 1}`,
			atl: Math.round(atl[offset] ?? 0),
			ctl: Math.round(ctl[offset] ?? 0),
			tsb: Math.round(tsb[offset] ?? 0),
			protein: 0,
			weight: 0,
			targetWeight: 0,
		};
	});
	const nutrition = nutritionDays(context);
	const proteinValues = nutrition
		.map((day) => day.protein)
		.filter((value): value is number => value !== undefined);
	const weightValues = firstMetricSeries(context, ["nutrition", "recovery"], [
		/body.*weight|weight_kg|weight_lb|weight/i,
	]);
	const weightTrendPoints: TrendPoint[] = weightValues.slice(-6).map((weight, index) => ({
		label: `W${index + 1}`,
		atl: 0,
		ctl: 0,
		tsb: 0,
		protein: 0,
		weight,
		targetWeight: weightValues.length ? weightValues[weightValues.length - 1] : weight,
	}));
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Fitness trends</span>
				<h1>Training, nutrition, body comp.</h1>
				<p class="lede">Signed in as @${escapeHtml(session.login)}. A cleaner coached read of Intervals.icu, Cronometer, and body composition signals without leaving ZorFit.</p>
			</div>
			<div class="panel">
				${renderFreshnessPanel("Generated from current request")}
				<p>Charts below are rendered only from data returned by connected ZorFit sources. Missing fields show as setup states.</p>
			</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Training load</span>
					<h2>ATL / CTL / TSB over six weeks.</h2>
				</div>
				<p>Native visibility for the load you already track mentally.</p>
			</div>
			<div class="panel">
				${
					loadTrendPoints.length && (atl.length || ctl.length || tsb.length)
						? renderLineChart(
								loadTrendPoints,
								[
									{ key: "atl", label: "ATL", color: "#c8f542" },
									{ key: "ctl", label: "CTL", color: "#f5f2ec" },
									{ key: "tsb", label: "TSB", color: "#ff5c1a" },
								],
								Math.min(-12, ...atl, ...ctl, ...tsb),
								Math.max(20, ...atl, ...ctl, ...tsb),
							)
						: `<p>No ATL / CTL / TSB fields were returned by the connected fitness source. Connect Intervals.icu or route fitness activities to a source that provides training-load fields.</p>`
				}
			</div>
		</section>
		<section class="section">
			<div class="grid">
				<article class="panel">
					<div class="section-head">
						<div>
							<span class="eyebrow">Nutrition trend</span>
							<h2>Protein vs target.</h2>
						</div>
					</div>
					<div class="progress-list">
						${
							proteinValues.length
								? proteinValues.slice(-7).map(
										(value, index) => `<div class="progress-row">
											<div><strong>${nutrition[nutrition.length - proteinValues.slice(-7).length + index]?.date ?? `D${index + 1}`}</strong><small>${Math.round(value)}g protein</small></div>
											<div class="progress-track"><span style="width: ${Math.min(100, Math.round((value / scorePreferences.proteinTargetG) * 100))}%"></span></div>
											<span class="metric-value">${scorePreferences.proteinTargetG}g target</span>
										</div>`,
									).join("")
								: `<p>No Cronometer protein trend was returned for this window.</p>`
						}
					</div>
				</article>
				<article class="panel">
					<div class="section-head">
						<div>
							<span class="eyebrow">Body composition</span>
							<h2>Weight trend.</h2>
						</div>
					</div>
					${
						weightTrendPoints.length
							? renderLineChart(
									weightTrendPoints,
									[
										{ key: "weight", label: "Weight", color: "#c8f542" },
										{ key: "targetWeight", label: "Latest", color: "#aaa49a", dashed: true },
									],
									Math.min(...weightValues) - 1,
									Math.max(...weightValues) + 1,
								)
							: `<p>No body-weight or body-composition series was returned by connected sources. Add a weight-capable source before showing this chart.</p>`
					}
				</article>
			</div>
		</section>
	</main>`;
	return c.html(settingsShell("My Fitness", body));
});

utilityRoutes.get("/reports", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) {
		const body = `<main class="shell">
			<section class="hero">
				<div>
					<span class="eyebrow">Export / report</span>
					<h1>Reports need your source data.</h1>
					<p class="lede">Sign in to generate reports from routed training, nutrition, recovery, and source-health context.</p>
				</div>
				<div class="panel">
					<strong>Sign in required</strong>
					<p>Reports are intentionally blank until real connected data is available.</p>
					<a class="button primary" href="/signin">Sign in</a>
				</div>
			</section>
		</main>`;
		return c.html(settingsShell("Reports", body));
	}
	const timezone = normalizeTimezone(c.req.query("timezone") || "America/New_York");
	const date = localDateForTimezone(timezone);
	const [context, scorePreferences] = await Promise.all([
		collectHealthContext(c.env, session, {
			categories: ["nutrition", "hrv", "sleep", "fitness_activities", "gym_workouts", "steps", "recovery"],
			timezone,
			date,
			rangeDays: 30,
		}),
		getScorePreferences(c.env, session),
	]);
	const scores = scoreSummary(context, scorePreferences);
	const readyCategories = context.categories.filter((category) => category.status === "ready");
	const macro = nutritionMacroLine(context);
	const activityCount =
		arrayFrom(contextFor(context, "fitness_activities")?.data).length +
		arrayFrom(contextFor(context, "gym_workouts")?.data).length;
	const reportMarkdown = `# ZorFit Monthly Report

User: @${session.login}
Date: ${date}
Ready categories: ${readyCategories.length}/${context.categories.length}
Overall score: ${scores.overall.score} (${scoreBand(scores.overall.score)})
Nutrition score: ${scores.nutrition.score}
Readiness score: ${scores.readiness.score}
Fitness score: ${scores.fitness.score}
Latest nutrition: ${macro ?? "No routed nutrition data returned"}
Activity records in window: ${activityCount}
Coach verdict: ${motivationalMessage(scores)}

Source notes:
${context.categories.map((category) => `- ${categoryLabel(category.category)} via ${PROVIDER_LABELS[category.provider]}: ${category.status}${category.note ? ` - ${category.note}` : ""}`).join("\n")}`;
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Export / report</span>
				<h1>Monthly memory layer.</h1>
				<p class="lede">For @${escapeHtml(session.login)}. Training volume, nutrition averages, source status, and coach notes in export-ready PDF or markdown form.</p>
			</div>
			<div class="panel">
				${renderFreshnessPanel("Generated from current request")}
				<div class="actions">
					<a class="button primary" href="/my-week">Open weekly review</a>
					<a class="button" href="/connections">Source health</a>
				</div>
			</div>
		</section>
		<section class="section">
			<div class="feature-grid">
				<article class="panel feature-card">
					<span class="status">PDF ready</span>
					<h3>June performance review</h3>
					<p>${readyCategories.length} routed data categories are available for report generation.</p>
				</article>
				<article class="panel feature-card">
					<span class="status">Markdown</span>
					<h3>Coach summary</h3>
					<p>Copy-ready plain-text review built from current score, nutrition, activity count, and source notes.</p>
				</article>
				<article class="panel feature-card">
					<span class="status">Share card</span>
					<h3>Weekly accountability card</h3>
					<p>Compact card should use the same real weekly score inputs as /my-week.</p>
				</article>
			</div>
		</section>
		<section class="section">
			<div class="section-head">
				<div>
					<span class="eyebrow">Preview</span>
					<h2>Markdown report.</h2>
				</div>
			</div>
			<pre class="report-preview">${escapeHtml(reportMarkdown)}</pre>
		</section>
	</main>`;
	return c.html(settingsShell("Reports", body));
});

utilityRoutes.get("/api/data-preferences", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	return c.json({
		categories: HEALTH_CATEGORIES,
		preferences: await listDataPreferences(c.env, session),
	});
});

utilityRoutes.post("/api/data-preferences", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const preferences = Array.isArray(body.preferences) ? body.preferences : [];
		await upsertDataPreferences(c.env, session, preferences);
		return c.json({ success: true });
	} catch (error) {
		console.error("Data preference save failed:", error);
		return c.json({ error: "Could not save data routing." }, 500);
	}
});

function clampedNumber(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = typeof value === "string" ? Number(value) : numberFrom(value);
	if (parsed === undefined || !Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

utilityRoutes.post("/api/score-preferences", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		await upsertScorePreferences(c.env, session, {
			nutritionWeight: Math.round(
				clampedNumber(body.nutritionWeight, 35, 0, 100),
			),
			readinessWeight: Math.round(
				clampedNumber(body.readinessWeight, 35, 0, 100),
			),
			fitnessWeight: Math.round(clampedNumber(body.fitnessWeight, 30, 0, 100)),
			proteinTargetG: Math.round(
				clampedNumber(body.proteinTargetG, 100, 0, 400),
			),
			sugarLimitG: Math.round(clampedNumber(body.sugarLimitG, 25, 0, 300)),
			fiberTargetG: Math.round(clampedNumber(body.fiberTargetG, 25, 0, 120)),
			sleepTargetHours: clampedNumber(body.sleepTargetHours, 7, 3, 12),
		});
		return c.json({ success: true });
	} catch (error) {
		console.error("Score preference save failed:", error);
		return c.json({ error: "Could not save score formula." }, 500);
	}
});

utilityRoutes.post("/api/question-bank", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const categories = normalizeHealthCategories(body.categories);
	return c.json({ categories, questions: questionBankForCategories(categories) });
});

utilityRoutes.get("/api/message-schedules", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	return c.json({ schedules: await listUserMessageSchedules(c.env, session) });
});

utilityRoutes.post("/api/message-schedules", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const times = normalizeNotificationTimes(body.times);
		if (times.length === 0)
			return c.json(
				{ error: "Add at least one valid time in HH:MM format." },
				400,
			);
		const id = await upsertUserMessageSchedule(c.env, session, {
			id: typeof body.id === "string" && body.id ? body.id : undefined,
			title: typeof body.title === "string" ? body.title : "ZorFit insight",
			enabled: Boolean(body.enabled),
			timezone: normalizeTimezone(body.timezone),
			times,
			insightMode: normalizeInsightMode(body.insightMode),
			categories: normalizeHealthCategories(body.categories),
			question: normalizeMessageQuestion(body.question),
			promptInstructions: normalizePromptInstructions(body.promptInstructions),
		});
		return c.json({ success: true, id });
	} catch (error) {
		console.error("Message schedule save failed:", error);
		return c.json({ error: "Could not save message schedule." }, 500);
	}
});

utilityRoutes.delete("/api/message-schedules/:id", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	await deleteUserMessageSchedule(c.env, session, c.req.param("id"));
	return c.json({ success: true });
});

utilityRoutes.post("/api/telegram/test-message-insight", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const telegram = await getTelegramConnection(c.env, session);
		if (!telegram?.externalUserId || !telegram.enabled) {
			return c.json(
				{ error: "Telegram is not connected. Connect Telegram first." },
				400,
			);
		}
		const timezone = normalizeTimezone(body.timezone);
		const date = localDateForTimezone(timezone);
		const categories = normalizeHealthCategories(body.categories);
		const question =
			normalizeMessageQuestion(body.question) ||
			"Give me a useful ZorFit insight from the selected health categories.";
		const context = await collectHealthContext(c.env, session, {
			categories,
			timezone,
			date,
		});
		const aiConnection = await getPreferredAiConnectionForSession(c.env, session);
		const input = {
			date,
			timezone,
			title:
				typeof body.title === "string" && body.title.trim()
					? body.title.trim()
					: "ZorFit test insight",
			question,
			categories,
			context,
			promptInstructions: normalizePromptInstructions(body.promptInstructions),
		};
		const answer = aiConnection
			? await generateHealthInsight(aiConnection, input)
			: generateBasicHealthInsight(input);
		await sendLongTelegramMessage(c.env, {
			chatId: telegram.externalUserId,
			text: `${input.title}\n\n${answer}\n\nNot medical advice. Consult a qualified professional for health or nutrition decisions.`,
		});
		return c.json({ success: true });
	} catch (error) {
		console.error("Test message insight failed:", error);
		return c.json(
			{ error: error instanceof Error ? error.message.slice(0, 500) : "Could not send test message." },
			400,
		);
	}
});

utilityRoutes.post("/api/coach-chat", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const question = normalizeMessageQuestion(body.question);
		if (!question) return c.json({ error: "Ask a question first." }, 400);
		const timezone = normalizeTimezone(body.timezone);
		const date = localDateForTimezone(timezone);
		const categories = normalizeHealthCategories(body.categories);
		const context = await collectHealthContext(c.env, session, {
			categories,
			timezone,
			date,
		});
		const aiConnection = await getPreferredAiConnectionForSession(c.env, session);
		const input = {
			date,
			timezone,
			title: "ZorFit Coach Chat",
			question,
			categories,
			context,
			promptInstructions: normalizePromptInstructions(body.promptInstructions),
		};
		const answer = aiConnection
			? await generateHealthInsight(aiConnection, input)
			: generateBasicHealthInsight(input);
		return c.json({ answer, context });
	} catch (error) {
		console.error("Coach chat failed:", error);
		return c.json(
			{ error: error instanceof Error ? error.message.slice(0, 500) : "Could not answer." },
			400,
		);
	}
});

utilityRoutes.get("/api/ai-connections", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const [connections, preference] = await Promise.all([
		listAiConnectionSummaries(c.env, session),
		getAiPreference(c.env, session),
	]);
	return c.json({ connections, preference });
});

utilityRoutes.post("/api/ai-connections", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const provider = body.provider as AiProviderId;
		if (!AI_PROVIDER_DEFAULTS[provider])
			return c.json({ error: "Unknown AI provider." }, 400);
		const modelName =
			typeof body.modelName === "string" ? body.modelName.trim() : "";
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		let requestSettings: ReturnType<typeof normalizeAiRequestSettings>;
		try {
			const requestSettingsValue =
				typeof body.requestSettingsJson === "string"
					? JSON.parse(body.requestSettingsJson || "{}")
					: body.requestSettings;
			requestSettings = normalizeAiRequestSettings(requestSettingsValue);
		} catch (error) {
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Advanced request settings must be valid JSON.",
				},
				400,
			);
		}
		let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		if (!modelName) return c.json({ error: "Model name is required." }, 400);
		if (!apiKey && body.keepExistingKey) {
			const existing = (await listAiConnectionSummaries(c.env, session)).find(
				(item) => item.provider === provider,
			);
			if (existing) {
				apiKey =
					(await getAiConnection(c.env, session, provider))?.apiKey ?? "";
			}
		}
		if (!apiKey) return c.json({ error: "API key is required." }, 400);
		await upsertAiConnection(c.env, session, {
			provider,
			apiKey,
			baseUrl,
			modelName,
			requestSettings,
			enabled: true,
		});
		return c.json({ success: true });
	} catch (error) {
		console.error("AI connection save failed:", error);
		return c.json({ error: "Could not save AI connection." }, 500);
	}
});

utilityRoutes.delete("/api/ai-connections/:provider", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const provider = c.req.param("provider") as AiProviderId;
	if (!AI_PROVIDER_DEFAULTS[provider])
		return c.json({ error: "Unknown AI provider." }, 400);
	await deleteAiConnection(c.env, session, provider);
	return c.json({ success: true });
});

utilityRoutes.get("/api/ai-preferences", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const preference = await getAiPreference(c.env, session);
	return c.json({ preference });
});

utilityRoutes.post("/api/ai-preferences", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const defaultProvider = body.defaultProvider as AiProviderId;
		if (!AI_PROVIDER_DEFAULTS[defaultProvider])
			return c.json({ error: "Unknown AI provider." }, 400);
		const connections = await listAiConnectionSummaries(c.env, session);
		const connection = connections.find(
			(item) => item.provider === defaultProvider && item.enabled,
		);
		if (!connection)
			return c.json(
				{ error: "Connect this AI provider before making it the default." },
				400,
			);
		await upsertAiPreference(c.env, session, defaultProvider);
		return c.json({ success: true });
	} catch (error) {
		console.error("AI preference save failed:", error);
		return c.json({ error: "Could not save default AI model." }, 500);
	}
});

utilityRoutes.post("/api/telegram/link-code", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_BOT_USERNAME) {
		return c.json(
			{
				error:
					"TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME must be configured before Telegram linking is available.",
			},
			503,
		);
	}
	const code = await createTelegramLinkCode(c.env, session);
	const botUrl = `https://t.me/${encodeURIComponent(c.env.TELEGRAM_BOT_USERNAME)}?start=${encodeURIComponent(code)}`;
	return c.json({ code, botUrl, expiresInSeconds: 600 });
});

utilityRoutes.post("/api/telegram/test-nutrition-insight", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		await sendTestNutritionInsight(c.env, session);
		return c.json({
			success: true,
			message: "Test nutrition insight sent to Telegram.",
		});
	} catch (error) {
		console.error("Test nutrition insight failed:", error);
		const message =
			error instanceof Error
				? error.message
				: "Could not send test nutrition insight.";
		return c.json({ error: message.slice(0, 500) }, 400);
	}
});

utilityRoutes.post("/api/telegram/webhook", async (c) => {
	if (c.env.TELEGRAM_WEBHOOK_SECRET) {
		const token = c.req.header("X-Telegram-Bot-Api-Secret-Token");
		if (token !== c.env.TELEGRAM_WEBHOOK_SECRET)
			return c.json({ ok: false }, 401);
	}
	const update = (await c.req.json().catch(() => null)) as {
		message?: {
			text?: string;
			chat?: { id?: number | string; username?: string };
			from?: { username?: string };
		};
	} | null;
	const text = update?.message?.text ?? "";
	const chatId = update?.message?.chat?.id;
	if (chatId === undefined) return c.json({ ok: true });
	const match = text.match(/^\/start\s+([a-f0-9]{18})/i);
	if (!match) {
		if (text.startsWith("/start")) {
			await sendTelegramMessage(c.env, {
				chatId: String(chatId),
				text: "Open ZorFit settings, click Connect Telegram, then tap Start from that link. That gives me the secure code needed to connect your account.",
			});
		}
		return c.json({ ok: true });
	}
	const userId = await consumeTelegramLinkCode(c.env, match[1]);
	if (!userId) {
		await sendTelegramMessage(c.env, {
			chatId: String(chatId),
			text: "This ZorFit Telegram link expired or was already used. Please return to ZorFit settings and click Connect Telegram again.",
		});
		return c.json({ ok: true });
	}
	await upsertTelegramConnection(c.env, userId, {
		externalUserId: String(chatId),
		externalUsername:
			update?.message?.chat?.username ?? update?.message?.from?.username,
		enabled: true,
	});
	await sendTelegramMessage(c.env, {
		chatId: String(chatId),
		text: "Telegram is connected to ZorFit. You can return to ZorFit settings and save your nutrition insight schedule.",
	});
	return c.json({ ok: true });
});

utilityRoutes.get("/api/notification-schedule", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const [telegram, schedule] = await Promise.all([
		getTelegramConnection(c.env, session),
		getNotificationSchedule(c.env, session),
	]);
	return c.json({ telegram, schedule });
});

utilityRoutes.post("/api/notification-schedule", async (c) => {
	const session = await getSettingsSession(c);
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	try {
		const body = await c.req.json();
		const times = normalizeNotificationTimes(body.times);
		if (times.length === 0)
			return c.json(
				{ error: "Add at least one valid time in HH:MM format." },
				400,
			);
		await upsertNotificationSchedule(c.env, session, {
			enabled: Boolean(body.enabled),
			timezone: normalizeTimezone(body.timezone),
			times,
			insightMode: normalizeInsightMode(body.insightMode),
			promptInstructions: normalizePromptInstructions(body.promptInstructions),
		});
		return c.json({ success: true });
	} catch (error) {
		console.error("Notification schedule save failed:", error);
		return c.json({ error: "Could not save notification schedule." }, 500);
	}
});

utilityRoutes.get("/settings-old", (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="description" content="Configure ZorFit_MCP fitness apps, LLM providers, and messaging integrations.">
	<title>Settings - ZorFit_MCP</title>
	<style>
		:root {
			color-scheme: dark;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			--bg: #080b10;
			--panel: #10151f;
			--panel-2: #151b27;
			--line: #273142;
			--text: #f5f7fb;
			--muted: #aab4c5;
			--soft: #d7deea;
			--green: #8ee6b1;
			--blue: #9db9ff;
			--amber: #ffd38a;
			--ink: #091019;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			color: var(--text);
			background:
				radial-gradient(circle at 82% 0%, rgba(157, 185, 255, 0.18), transparent 30rem),
				linear-gradient(180deg, #0c1119 0%, var(--bg) 46%, #07090d 100%);
		}
		a { color: inherit; text-decoration: none; }
		.shell {
			width: min(1120px, calc(100% - 32px));
			margin: 0 auto;
		}
		nav {
			position: sticky;
			top: 0;
			z-index: 10;
			border-bottom: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(8, 11, 16, 0.82);
			backdrop-filter: blur(18px);
		}
		nav .shell {
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: 72px;
			gap: 18px;
		}
		.brand {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			font-weight: 850;
		}
		.mark {
			display: grid;
			place-items: center;
			width: 32px;
			height: 32px;
			border-radius: 8px;
			background: linear-gradient(135deg, var(--green), var(--blue));
			color: var(--ink);
			font-weight: 900;
		}
		.nav-links {
			display: flex;
			align-items: center;
			gap: 10px;
		}
		.button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 42px;
			padding: 0 16px;
			border: 1px solid rgba(255, 255, 255, 0.14);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.06);
			color: var(--text);
			font-weight: 750;
			white-space: nowrap;
		}
		.button.primary {
			border-color: transparent;
			background: var(--text);
			color: var(--ink);
		}
		main {
			padding: 64px 0 76px;
		}
		.hero {
			display: grid;
			grid-template-columns: minmax(0, 0.85fr) minmax(320px, 0.55fr);
			gap: 34px;
			align-items: end;
			margin-bottom: 34px;
		}
		.eyebrow {
			color: var(--green);
			font-size: 0.76rem;
			font-weight: 820;
			letter-spacing: 0.12em;
			text-transform: uppercase;
		}
		h1 {
			margin: 14px 0 16px;
			font-size: clamp(3rem, 7vw, 6.2rem);
			line-height: 0.9;
			letter-spacing: 0;
		}
		p {
			color: var(--muted);
			line-height: 1.65;
		}
		.lede {
			max-width: 660px;
			margin: 0;
			font-size: 1.08rem;
		}
		.status-panel {
			padding: 18px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.04);
		}
		.status-panel strong {
			display: block;
			margin-bottom: 8px;
			font-size: 1.05rem;
		}
		.status-panel p {
			margin: 0;
			font-size: 0.94rem;
		}
		.settings-grid {
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 16px;
		}
		.card {
			min-height: 100%;
			padding: 22px;
			border: 1px solid rgba(255, 255, 255, 0.11);
			border-radius: 8px;
			background: var(--panel);
		}
		.card h2 {
			margin: 0 0 10px;
			font-size: 1.35rem;
			letter-spacing: 0;
		}
		.card p {
			margin: 0 0 18px;
			font-size: 0.94rem;
		}
		label {
			display: block;
			margin: 14px 0 7px;
			color: var(--soft);
			font-size: 0.82rem;
			font-weight: 780;
		}
		input, select, textarea {
			width: 100%;
			min-height: 42px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.06);
			color: var(--text);
			padding: 10px 12px;
			font: inherit;
		}
		textarea {
			min-height: 86px;
			resize: vertical;
		}
		select option {
			color: #111827;
		}
		.row {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 12px;
		}
		.helper {
			margin-top: 12px;
			padding: 12px;
			border: 1px solid rgba(255, 211, 138, 0.22);
			border-radius: 8px;
			background: rgba(255, 211, 138, 0.06);
			color: var(--muted);
			font-size: 0.88rem;
		}
		.provider-list {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 14px;
		}
		.chip {
			display: inline-flex;
			align-items: center;
			min-height: 30px;
			padding: 0 10px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.05);
			color: var(--soft);
			font-size: 0.82rem;
			font-weight: 720;
		}
		.card-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-top: 18px;
		}
		.disabled {
			opacity: 0.62;
			cursor: not-allowed;
		}
		footer {
			padding: 36px 0;
			border-top: 1px solid rgba(255, 255, 255, 0.08);
			color: var(--muted);
		}
		footer .shell {
			display: flex;
			justify-content: space-between;
			gap: 18px;
			flex-wrap: wrap;
		}
		@media (max-width: 980px) {
			.hero, .settings-grid {
				grid-template-columns: 1fr;
			}
		}
		@media (max-width: 560px) {
			.shell {
				width: min(100% - 24px, 1120px);
			}
			nav .shell {
				align-items: flex-start;
				flex-direction: column;
				padding: 14px 0;
			}
			.nav-links {
				width: 100%;
				display: grid;
				grid-template-columns: 1fr 1fr;
			}
			.row {
				grid-template-columns: 1fr;
			}
			h1 {
				font-size: clamp(3rem, 18vw, 4.2rem);
			}
		}
	</style>
</head>
<body>
	<nav>
		<div class="shell">
			<a class="brand" href="/">
				${ZORFIT_BRAND}
			</a>
			<div class="nav-links" aria-label="Settings navigation">
				<a class="button" href="/connections">Connections</a>
				<a class="button primary" href="/settings">Settings</a>
			</div>
		</div>
	</nav>

	<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Account setup</span>
				<h1>Settings for sources, AI, and messages.</h1>
				<p class="lede">Keep app credentials, LLM provider details, and messaging services in one place. These fields are prepared for the next encrypted settings upgrade.</p>
			</div>
			<div class="status-panel">
				<strong>Coming next</strong>
				<p>Saving, encryption, and test actions will be connected to the existing per-user credential store after you confirm the final provider list and Telegram flow.</p>
			</div>
		</section>

		<section class="settings-grid" aria-label="ZorFit settings">
			<form class="card">
				<span class="eyebrow">Fitness sources</span>
				<h2>Fitness apps and wearables</h2>
				<p>Add API details for fitness apps, wearables, nutrition tools, and training platforms.</p>

				<label for="fitness-provider">Service type</label>
				<select id="fitness-provider" name="fitness-provider">
					<option>Fitness app</option>
					<option>Wearable</option>
					<option>Nutrition tracker</option>
					<option>Training platform</option>
				</select>

				<label for="fitness-name">App or device name</label>
				<input id="fitness-name" name="fitness-name" placeholder="Cronometer, Strava, Garmin, Fitbit, Oura" autocomplete="off">

				<label for="fitness-api">API key or token</label>
				<textarea id="fitness-api" name="fitness-api" placeholder="Paste API key, access token, or refresh token"></textarea>

				<div class="row">
					<div>
						<label for="fitness-username">Username</label>
						<input id="fitness-username" name="fitness-username" placeholder="Optional username" autocomplete="username">
					</div>
					<div>
						<label for="fitness-password">Password</label>
						<input id="fitness-password" name="fitness-password" type="password" placeholder="Optional password" autocomplete="current-password">
					</div>
				</div>

				<div class="helper">Use the Connections page for active integrations today. This settings box is reserved for the broader encrypted credential manager.</div>
				<div class="card-actions">
					<button class="button primary disabled" type="button" disabled>Save source details soon</button>
				</div>
			</form>

			<form class="card">
				<span class="eyebrow">AI insight provider</span>
				<h2>LLM API details</h2>
				<p>Bring your own model key for future nutrition and training insights.</p>

				<label for="llm-provider">Provider</label>
				<select id="llm-provider" name="llm-provider">
					<option>OpenAI</option>
					<option>Claude / Anthropic</option>
					<option>Gemini</option>
					<option>NVIDIA NIM</option>
					<option>OpenRouter</option>
					<option>Groq</option>
					<option>Google AI Studio</option>
				</select>

				<label for="llm-api-key">API key</label>
				<textarea id="llm-api-key" name="llm-api-key" placeholder="Paste your LLM API key"></textarea>

				<div class="row">
					<div>
						<label for="llm-model">Model</label>
						<input id="llm-model" name="llm-model" placeholder="gpt-4.1-mini, claude-3.5, llama, gemini" autocomplete="off">
					</div>
					<div>
						<label for="llm-base-url">Base URL</label>
						<input id="llm-base-url" name="llm-base-url" placeholder="Optional custom endpoint" autocomplete="off">
					</div>
				</div>

				<div class="provider-list" aria-label="Supported LLM providers">
					<span class="chip">OpenAI</span>
					<span class="chip">Claude</span>
					<span class="chip">Gemini</span>
					<span class="chip">NVIDIA NIM</span>
					<span class="chip">OpenRouter</span>
					<span class="chip">Groq</span>
					<span class="chip">Google AI Studio</span>
				</div>
				<div class="helper">LLM details will power future AI-generated insights. For now, no LLM keys are stored from this placeholder form.</div>
				<div class="card-actions">
					<button class="button primary disabled" type="button" disabled>Save LLM details soon</button>
					<button class="button disabled" type="button" disabled>Test insight soon</button>
				</div>
			</form>

			<form class="card">
				<span class="eyebrow">Messaging</span>
				<h2>Notification services</h2>
				<p>Connect messaging channels for nutrition check-ins, summaries, and future AI insights.</p>

				<label for="message-service">Messaging service</label>
				<select id="message-service" name="message-service">
					<option>Telegram</option>
				</select>

				<label for="telegram-status">Telegram</label>
				<input id="telegram-status" name="telegram-status" value="Placeholder - deep-link bot connection coming soon" readonly>

				<label for="message-frequency">Insight window</label>
				<select id="message-frequency" name="message-frequency">
					<option>Every 4 hours</option>
					<option>Daily summary</option>
					<option>Paused</option>
				</select>

				<div class="helper">Telegram will use a bot deep link instead of asking users to paste chat IDs. This keeps the setup simple and familiar.</div>
				<div class="card-actions">
					<button class="button primary disabled" type="button" disabled>Connect Telegram soon</button>
					<button class="button disabled" type="button" disabled>Send test message soon</button>
				</div>
			</form>
		</section>
	</main>

	<footer>
		<div class="shell">
			<span>ZorFit settings</span>
			<span>Secrets will be encrypted before active storage is enabled.</span>
		</div>
	</footer>
</body>
</html>`;

	return c.html(html);
});

utilityRoutes.get("/", (c) => {
	return c.html(renderZorFitLandingPage(new URL(c.req.url).origin));
});

export default utilityRoutes;
