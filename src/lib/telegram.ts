export interface TelegramEnv {
	TELEGRAM_BOT_TOKEN?: string;
}

export interface TelegramMessage {
	chatId: string;
	text: string;
	parseMode?: "HTML" | null;
}

export async function sendTelegramMessage(
	env: TelegramEnv,
	message: TelegramMessage,
): Promise<void> {
	if (!env.TELEGRAM_BOT_TOKEN) {
		throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
	}
	const response = await fetch(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: message.chatId,
				text: message.text,
				...(message.parseMode === null
					? {}
					: { parse_mode: message.parseMode ?? "HTML" }),
				disable_web_page_preview: true,
			}),
		},
	);
	if (!response.ok) {
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
			parseMode: null,
		});
	}
}

export function escapeTelegramHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
