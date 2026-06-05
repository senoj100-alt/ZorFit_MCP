import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConnection } from "../../src/lib/ai-connections.js";
import { generateNutritionInsight } from "../../src/lib/llm-insights.js";

const INPUT = {
	date: "2026-06-03",
	mode: "today_so_far" as const,
	nutrition: { protein: 80 },
};

function connection(overrides: Partial<AiConnection> = {}): AiConnection {
	return {
		provider: "groq",
		apiKey: "test-key",
		modelName: "openai/gpt-oss-120b",
		requestSettings: {},
		enabled: true,
		updatedAt: "2026-06-03T00:00:00.000Z",
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LLM nutrition insights", () => {
	it("uses Groq GPT-OSS reasoning-safe request defaults", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "Useful insight" } }],
				}),
				{ status: 200 },
			),
		);

		await generateNutritionInsight(connection(), INPUT);

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			model: "openai/gpt-oss-120b",
			include_reasoning: false,
			reasoning_effort: "low",
			max_completion_tokens: 1800,
		});
		expect(body.max_tokens).toBeUndefined();
	});

	it("accepts OpenAI-compatible array content", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: { content: [{ type: "text", text: "Array response" }] },
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(generateNutritionInsight(connection(), INPUT)).resolves.toBe(
			"Array response",
		);
	});

	it("returns actionable guidance when Groq has no final answer", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ choices: [{ message: { content: "" } }] }),
				{ status: 200 },
			),
		);

		await expect(generateNutritionInsight(connection(), INPUT)).rejects.toThrow(
			"Increase max_completion_tokens or disable reasoning",
		);
	});

	it("retries Groq token-limit failures while preserving nutrient totals", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							message: "Limit 8000, Requested 8706",
							type: "tokens",
							code: "rate_limit_exceeded",
						},
					}),
					{ status: 413 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "Full nutrient insight" } }],
					}),
					{ status: 200 },
				),
			);
		const nutrition = {
			date: "2026-06-03",
			summary: { calories: 2200 },
			nutrients: {
				values: [
					{ id: 269, amount: 45, unit: "g", target: 50, percent: 90 },
					{ id: 303, amount: 16, unit: "mg", target: 18, percent: 89 },
				],
			},
			nutritionScores: {
				scores: [{ id: 269, amount: 45, unit: "g", target: 50, percent: 90 }],
			},
			entries: Array.from({ length: 200 }, (_, index) => ({
				name: `Food ${index}`,
				detail: "x".repeat(500),
			})),
		};

		await expect(
			generateNutritionInsight(
				connection({
					requestSettings: { max_completion_tokens: 3000 },
				}),
				{ ...INPUT, nutrition },
			),
		).resolves.toBe("Full nutrient insight");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(retryBody.max_completion_tokens).toBe(1800);
		expect(retryBody.include_reasoning).toBe(false);
		expect(retryBody.reasoning_effort).toBe("low");
		expect(retryBody.messages[1].content).toContain(
			"sugar: amount=45, unit=g, target=50, percent=90",
		);
		expect(retryBody.messages[1].content).toContain('"sugar":true');
		expect(retryBody.messages[1].content).toContain('"sevenDayTrends":false');
		expect(retryBody.messages[1].content).toContain(
			"iron: amount=16, unit=mg, target=18, percent=89",
		);
		expect(retryBody.messages[1].content).toContain(
			"Nutrient values were prioritized",
		);
		expect(retryBody.messages[1].content).not.toContain("x".repeat(500));
		expect(retryBody.messages[1].content.length).toBeLessThan(14000);
	});

	it("translates numeric-key and pair-array Cronometer sugar values", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "too large" } }), {
					status: 413,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "Sugar was available." } }],
					}),
					{ status: 200 },
				),
			);

		await generateNutritionInsight(connection(), {
			...INPUT,
			nutrition: {
				nutrients: {
					totals: { "269": 42, "291": 31 },
					values: [
						[269, 42],
						[301, 900],
					],
				},
			},
		});

		const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(retryBody.messages[1].content).toContain("sugar: amount=42");
		expect(retryBody.messages[1].content).toContain("fiber: amount=31");
		expect(retryBody.messages[1].content).toContain("calcium: amount=900");
	});

	it("retries a truncated Groq completion instead of sending partial text", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [
							{
								finish_reason: "length",
								message: { content: "**1. MACROS** Car" },
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [
							{
								finish_reason: "stop",
								message: { content: "Complete verified analysis" },
							},
						],
					}),
					{ status: 200 },
				),
			);

		await expect(generateNutritionInsight(connection(), INPUT)).resolves.toBe(
			"Complete verified analysis",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(retryBody.reasoning_effort).toBe("low");
		expect(retryBody.max_completion_tokens).toBe(1800);
	});
});
