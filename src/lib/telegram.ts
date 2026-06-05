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
	const lines = escaped.split("\n");
	const formatted: string[] = [];
	for (const line of lines) {
		if (/^\s*-{3,}\s*$/.test(line)) {
			if (formatted[formatted.length - 1] !== "") formatted.push("");
			continue;
		}
		if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) {
			continue;
		}
		const tableCells = markdownTableCells(line);
		if (tableCells.length > 1) {
			formatted.push(formatTableCells(tableCells));
			continue;
		}
		const heading = line.match(/^#{1,6}\s+(.+)$/);
		const normalizedLine = heading ? `<b>${heading[1]}</b>` : line;
		const bulletLine = normalizedLine.replace(/^(\s*)[-*]\s+/u, "$1• ");
		formatted.push(formatTelegramInlineMarkdown(bulletLine));
	}
	return formatted.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function markdownTableCells(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return [];
	const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return withoutEdges
		.split("|")
		.map((cell) => cell.trim())
		.filter(Boolean);
}

function formatTableCells(cells: string[]): string {
	const line =
		cells.length <= 2
			? `• ${cells.join(": ")}`
			: `• ${cells[0]}: ${cells.slice(1).join(" | ")}`;
	return formatTelegramInlineMarkdown(line);
}

function formatTelegramInlineMarkdown(line: string): string {
	return line
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
		.replace(/__([^_\n]+)__/g, "<b>$1</b>");
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
	const shouldFormat = message.parseMode !== null;
	await postTelegramMessage(
		env,
		message,
		shouldFormat ? formatTelegramHtmlFromMarkdown(message.text) : message.text,
		shouldFormat ? message.text : undefined,
	);
}

async function postTelegramMessage(
	env: TelegramEnv,
	message: TelegramMessage,
	text: string,
	fallbackText?: string,
): Promise<void> {
	const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: telegramPayload(message, text),
	});
	if (!response.ok) {
		if (message.parseMode !== null && fallbackText !== undefined) {
			const fallback = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: telegramPayload({ ...message, parseMode: null }, fallbackText),
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
	maximumLength = 3000,
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
	if (!env.TELEGRAM_BOT_TOKEN) {
		throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
	}
	const shouldFormat = message.parseMode !== null;
	const preparedText = shouldFormat
		? formatTelegramHtmlFromMarkdown(message.text)
		: message.text;
	const chunks = splitTelegramText(preparedText);
	for (const chunk of chunks) {
		await postTelegramMessage(
			env,
			{
				chatId: message.chatId,
				text: chunk,
				parseMode: message.parseMode,
			},
			chunk,
			shouldFormat ? chunk : undefined,
		);
	}
}

export function escapeTelegramHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
