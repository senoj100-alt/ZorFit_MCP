import { describe, expect, it } from "vitest";
import {
	normalizeAiRequestSettings,
	recommendedAiRequestSettings,
} from "../../src/lib/ai-connections.js";

describe("AI request settings", () => {
	it("normalizes supported request controls", () => {
		expect(
			normalizeAiRequestSettings({
				include_reasoning: false,
				max_completion_tokens: 1200,
				temperature: 0.4,
			}),
		).toEqual({
			temperature: 0.4,
			max_completion_tokens: 1200,
			include_reasoning: false,
		});
	});

	it("rejects protected and unknown request fields", () => {
		expect(() =>
			normalizeAiRequestSettings({ model: "different-model" }),
		).toThrow("Unsupported advanced request setting: model.");
	});

	it("recommends reasoning-safe defaults for Groq GPT-OSS", () => {
		expect(recommendedAiRequestSettings("groq", "openai/gpt-oss-120b")).toEqual(
			{
				include_reasoning: false,
				reasoning_effort: "low",
				max_completion_tokens: 1800,
			},
		);
	});
});
