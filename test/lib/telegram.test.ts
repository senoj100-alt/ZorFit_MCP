import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatTelegramHtmlFromMarkdown,
	sendLongTelegramMessage,
	sendTelegramMessage,
	splitTelegramText,
} from "../../src/lib/telegram.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Telegram messages", () => {
	it("keeps short messages together", () => {
		expect(
			splitTelegramText("Nutrition analysis\n\nEverything looks useful."),
		).toEqual(["Nutrition analysis\n\nEverything looks useful."]);
	});

	it("splits long analyses without dropping content", () => {
		const text = `${"A".repeat(2500)}\n\n${"B".repeat(2500)}`;
		const chunks = splitTelegramText(text);

		expect(chunks).toHaveLength(2);
		expect(chunks.every((chunk) => chunk.length <= 3900)).toBe(true);
		expect(chunks.join("\n\n")).toBe(text);
	});

	it("formats common LLM markdown as safe Telegram HTML", () => {
		expect(
			formatTelegramHtmlFromMarkdown(
				"### Sugar intake\n\n**Protein:** low\n- Add yogurt\n<script>",
			),
		).toBe(
			"<b>Sugar intake</b>\n\n<b>Protein:</b> low\n• Add yogurt\n&lt;script&gt;",
		);
	});

	it("sends formatted HTML by default", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

		await sendTelegramMessage(
			{ TELEGRAM_BOT_TOKEN: "token" },
			{ chatId: "123", text: "**Sugar intake**" },
		);

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			chat_id: "123",
			text: "<b>Sugar intake</b>",
			parse_mode: "HTML",
			disable_web_page_preview: true,
		});
	});

	it("falls back to plain text when Telegram rejects HTML", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("bad html", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

		await sendTelegramMessage(
			{ TELEGRAM_BOT_TOKEN: "token" },
			{ chatId: "123", text: "**Sugar intake**" },
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const fallbackBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(fallbackBody.text).toBe("**Sugar intake**");
		expect(fallbackBody.parse_mode).toBeUndefined();
	});

	it("keeps HTML formatting enabled for long messages", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

		await sendLongTelegramMessage(
			{ TELEGRAM_BOT_TOKEN: "token" },
			{
				chatId: "123",
				text: `${"A".repeat(2500)}\n\n**Second chunk** ${"B".repeat(2500)}`,
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(secondBody.text).toContain("<b>Second chunk</b>");
		expect(secondBody.parse_mode).toBe("HTML");
	});
});
