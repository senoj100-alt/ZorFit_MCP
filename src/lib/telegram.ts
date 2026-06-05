export interface TelegramEnv {
	TELEGRAM_BOT_TOKEN?: string;
}

export interface TelegramMessage {
	chatId: string;
	text: string;
	parseMode?: "HTML" | null;
}

export function formatTelegramHtmlFromMarkdown(text: string): string {
	const escaped = escapeTelegramHtml(text);
	return escaped
		.split("\n")
		.map((line) => {
			const heading = line.match(/^#{1,6}\s+(.+)$/);
			const normalizedLine = heading ? `<b>${heading[1]}</b>` : line;
			const bulletLine = normalizedLine.replace(/^(\s*)[-*]\s+/u, "$1• ");
			return bulletLine
				.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
				.replace(/__([^_\n]+)__/g, "<b>$1</b>");
		})
		.join("\n");
}

function telegramPayload(message: TelegramMessage, text: string): string {
	return JSON.stringify({
		chat_id: message.chatId,
		text,
		...(message.parseMode === null
			? {}
			: { parse_mode: message.parseMode ?? "HTML" }),
		disable_web_page_preview: true,
	});
}

export async function sendTelegramMessage(
	env: TelegramEnv,
	message: TelegramMessage,
): Promise<void> {
	if (!env.TELEGRAM_BOT_TOKEN) {
		throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
	}
	const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
	const shouldFormat = message.parseMode !== null;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: telegramPayload(
			message,
			shouldFormat ? formatTelegramHtmlFromMarkdown(message.text) : message.text,
		),
	});
	if (!response.ok) {
		if (shouldFormat) {
			const fallback = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: telegramPayload({ ...message, parseMode: null }, message.text),
			});
			if (fallback.ok) return;
		}
		throw new Error(
			`Telegram send failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
		);
	}
}

export function splitTelegramText(
	text: string,
	maximumLength = 3900,
): string[] {
	const remainingParagraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = "";

	const pushCurrent = () => {
		if (!current) return;
		chunks.push(current);
		current = "";
	};

	for (const paragraph of remainingParagraphs) {
		if (!paragraph) continue;
		if (paragraph.length > maximumLength) {
			pushCurrent();
			for (let start = 0; start < paragraph.length; start += maximumLength) {
				chunks.push(paragraph.slice(start, start + maximumLength));
			}
			continue;
		}
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (candidate.length > maximumLength) pushCurrent();
		current = current ? `${current}\n\n${paragraph}` : paragraph;
	}
	pushCurrent();
	return chunks;
}

export async function sendLongTelegramMessage(
	env: TelegramEnv,
	message: TelegramMessage,
): Promise<void> {
	const chunks = splitTelegramText(message.text);
	for (const chunk of chunks) {
		await sendTelegramMessage(env, {
			chatId: message.chatId,
			text: chunk,
			parseMode: message.parseMode,
		});
	}
}

export function escapeTelegramHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
