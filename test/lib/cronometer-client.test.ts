import { describe, expect, it, vi } from "vitest";
import { CronometerClient } from "../../src/lib/cronometer-client.js";

describe("Cronometer daily nutrition", () => {
	it("includes nutrition scores using the diary serving IDs", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 1, sessionKey: "session" }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						summary: { energy: 2000 },
						diary: [
							{ type: "Serving", servingId: 101 },
							{ type: "Biometric", servingId: 202 },
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						nutrients: [
							{ id: 208, amount: 2000 },
							{ id: 203, amount: 121 },
							{ id: 205, amount: 240 },
							{ id: 204, amount: 70 },
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						scores: [{ id: 269, amount: 42 }],
					}),
					{ status: 200 },
				),
			);
		const client = new CronometerClient({
			username: "person@example.com",
			password: "password",
		});

		const result = (await client.getDailyNutrition("2026-06-03")) as Record<
			string,
			unknown
		>;

		expect(result.nutritionScores).toEqual({
			scores: [{ id: 269, amount: 42 }],
		});
		expect(result.macroSummary).toMatchObject({
			calories_kcal: 2000,
			protein_g: 121,
			carbs_g: 240,
			fat_g: 70,
			sugar_g: 42,
		});
		const scoreRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
		expect(scoreRequest.servingIds).toEqual([101]);
	});
});
