import { describe, expect, it } from "vitest";
import { splitTelegramText } from "../../src/lib/telegram.js";

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
});
