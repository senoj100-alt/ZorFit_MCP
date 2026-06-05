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
		status: "Planned",
		description: "Use your OpenAI key for nutrition and training insights.",
		href: "/settings/llm/openai",
		guidance: [
			"Model examples: gpt-4o-mini, gpt-4.1-mini",
			"Base URL: https://api.openai.com/v1",
		],
	},
	{
		id: "claude",
		label: "Claude / Anthropic",
		status: "Planned",
		description: "Use your Anthropic key for careful, concise insight writing.",
		href: "/settings/llm/claude",
		guidance: [
			"Model examples: claude-3-5-haiku-latest, claude-3-5-sonnet-latest",
			"Base URL: https://api.anthropic.com",
		],
	},
	{
		id: "gemini",
		label: "Gemini",
		status: "Planned",
		description: "Use Gemini models for AI-generated ZorFit insights.",
		href: "/settings/llm/gemini",
		guidance: [
			"Model examples: gemini-1.5-flash, gemini-2.0-flash",
			"Get keys from Google AI Studio.",
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
		],
	},
	{
		id: "groq",
		label: "Groq",
		status: "Planned",
		description: "Use Groq-hosted fast inference models for short insights.",
		href: "/settings/llm/groq",
		guidance: [
			"Model examples: llama-3.1-8b-instant, llama-3.3-70b-versatile, openai/gpt-oss-120b",
			"Base URL: https://api.groq.com/openai/v1",
		],
	},
	{
		id: "google_ai_studio",
		label: "Google AI Studio",
		status: "Planned",
		description: "Use Google AI Studio API keys for Gemini-family models.",
		href: "/settings/llm/google_ai_studio",
		guidance: [
			"Model examples: gemini-1.5-flash, gemini-2.0-flash",
			"Use the API key from AI Studio, not Google login OAuth.",
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
				<a class="button" href="/settings">Settings</a>
				<a class="button" href="/connections">Connections</a>
				<a class="button" href="/coach">Coach chat</a>
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

function hasReadyData(context: HealthContextBundle, categories: HealthDataCategory[]): boolean {
	return categories.some((category) => contextFor(context, category)?.status === "ready");
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

function nutritionMacroLine(context: HealthContextBundle): string | null {
	const nutrition = contextFor(context, "nutrition");
	const data = safeRecord(nutrition?.data);
	const macros = safeRecord(data?.macroSummary);
	if (!macros) return null;
	const calories = numberFrom(macros.calories_kcal);
	const protein = numberFrom(macros.protein_g);
	const carbs = numberFrom(macros.carbs_g);
	const fat = numberFrom(macros.fat_g);
	const sugar = numberFrom(macros.sugar_g);
	const parts = [
		calories !== undefined ? `${Math.round(calories)} kcal` : "",
		protein !== undefined ? `${Math.round(protein)}g protein` : "",
		carbs !== undefined ? `${Math.round(carbs)}g carbs` : "",
		fat !== undefined ? `${Math.round(fat)}g fat` : "",
		sugar !== undefined ? `${Math.round(sugar)}g sugar` : "",
	].filter(Boolean);
	return parts.length ? parts.join(" · ") : null;
}

function scoreSummary(context: HealthContextBundle): {
	overall: number;
	nutrition: number;
	readiness: number;
	fitness: number;
} {
	const nutrition = contextFor(context, "nutrition");
	const macroLine = nutritionMacroLine(context);
	const nutritionScore =
		nutrition?.status === "ready" ? (macroLine ? 82 : 68) : nutrition ? 48 : 42;
	const recoveryReady = hasReadyData(context, ["hrv", "sleep", "recovery"]);
	const hrvReady = contextFor(context, "hrv")?.status === "ready";
	const sleepReady = contextFor(context, "sleep")?.status === "ready";
	const readinessScore = recoveryReady
		? hrvReady && sleepReady
			? 84
			: 74
		: 52;
	const fitnessReady = hasReadyData(context, [
		"fitness_activities",
		"gym_workouts",
		"steps",
	]);
	const fitnessScore = fitnessReady ? 78 : 55;
	return {
		nutrition: boundedScore(nutritionScore),
		readiness: boundedScore(readinessScore),
		fitness: boundedScore(fitnessScore),
		overall: boundedScore((nutritionScore + readinessScore + fitnessScore) / 3),
	};
}

function motivationalMessage(scores: ReturnType<typeof scoreSummary>): string {
	if (scores.overall >= 80) {
		return "You are stacking good signals today. Keep the next decision simple: fuel well, move with intent, and protect tonight's sleep.";
	}
	if (scores.overall >= 65) {
		return "Today is still very steerable. One solid meal, one focused training choice, and one clean recovery habit can move the whole day up.";
	}
	return "No panic, just precision. Tighten the next four hours: hydrate, get protein in, take an easy walk, and make the next log count.";
}

interface MyDayTimelineItem {
	time: string;
	title: string;
	summary: string;
	status: "sent" | "pending" | "empty";
}

function timelineSummaryFor(schedule: UserMessageSchedule, sent: boolean): string {
	const categories = schedule.categories.length
		? schedule.categories.map(categoryLabel).join(", ")
		: "selected health data";
	const question = schedule.question
		? ` Question: ${schedule.question}`
		: "";
	return `${sent ? "Sent" : "Scheduled"} using ${categories}.${question}`;
}

function buildMyDayTimeline(
	schedules: UserMessageSchedule[],
	date: string,
	currentTime: string,
): MyDayTimelineItem[] {
	const currentMinutes = minutesFromTime(currentTime);
	const items = schedules
		.filter((schedule) => schedule.enabled)
		.flatMap((schedule) =>
			schedule.times
				.filter((time) => minutesFromTime(time) <= currentMinutes)
				.map((time) => {
					const slotKey = `${schedule.id}:${date}:${time}`;
					const sent = Boolean(schedule.lastSent[slotKey]);
					return {
						time,
						title: schedule.title || "ZorFit insight",
						summary: timelineSummaryFor(schedule, sent),
						status: sent ? "sent" : "pending",
					} satisfies MyDayTimelineItem;
				}),
		)
		.sort((a, b) => minutesFromTime(a.time) - minutesFromTime(b.time));
	if (items.length) return items;
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

function renderScoreCard(label: string, score: number): string {
	return `<article class="panel score-card">
		<strong>${escapeHtml(label)}</strong>
		<div class="score-value">${score}</div>
		<p>${escapeHtml(scoreBand(score))}</p>
	</article>`;
}

function renderTimelineItem(item: MyDayTimelineItem): string {
	const badge =
		item.status === "sent"
			? "sent"
			: item.status === "pending"
				? "pending"
				: "setup";
	return `<article class="timeline-item">
		<span class="timeline-dot ${item.status}"></span>
		<div class="timeline-time">${escapeHtml(item.time)}<span class="timeline-badge">${badge}</span></div>
		<h3 class="timeline-title">${escapeHtml(item.title)}</h3>
		<p class="timeline-summary">${escapeHtml(item.summary)}</p>
	</article>`;
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

utilityRoutes.get("/settings", (c) => {
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
			status: "New",
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
	];
	const body = `<main class="shell">
		<section class="hero">
			<div>
				<span class="eyebrow">Control center</span>
				<h1>Settings for sources, AI, and messages.</h1>
				<p class="lede">Start with one of the three setup areas. Each area opens into provider cards where users can add the right details in the right place.</p>
			</div>
			<div class="panel">
				<strong>Simple setup path</strong>
				<p>Fitness credentials, AI keys, and messaging services stay separated so the page stays clear as ZorFit grows.</p>
			</div>
		</section>
		<section class="section">
			<div class="actions"><a class="button" href="/">Back to home</a></div>
			<div class="grid">${renderSettingsCards(categories)}</div>
		</section>
	</main>`;
	return c.html(settingsShell("Settings", body));
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
		return {
			...source,
			status: isComingSoon
				? "Coming soon"
				: session
					? statusLabel(status?.source)
					: "Sign in required",
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
			<div class="grid">${renderSettingsCards(cards)}</div>
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
			if (event.target.dataset?.question) form.elements.question.value = event.target.dataset.question;
		});
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
		refreshBank();
	</script>`;
	return c.html(settingsShell("Coach Chat", body));
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
	const timezone = normalizeTimezone(
		c.req.query("timezone") || schedules[0]?.timezone || "America/New_York",
	);
	const local = localDateTimeForTimezone(timezone);
	const categories = configuredCategories(schedules);
	const context = await collectHealthContext(c.env, session, {
		categories,
		timezone,
		date: local.date,
	});
	const scores = scoreSummary(context);
	const timeline = buildMyDayTimeline(schedules, local.date, local.time);
	const macroLine = nutritionMacroLine(context);
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
					<span class="eyebrow">Timeline</span>
					<h2>My day so far.</h2>
				</div>
				<p>Completed message slots appear here after the scheduler sends them. Pending slots are due today but have not been marked sent yet.</p>
			</div>
			<div class="panel">
				<div class="timeline">
					${timeline.map(renderTimelineItem).join("")}
				</div>
			</div>
		</section>
	</main>`;
	return c.html(settingsShell("My Day So Far", body));
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
