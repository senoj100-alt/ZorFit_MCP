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
				new Response(JSON.stringify({ nutrients: [] }), { status: 200 }),
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
		const scoreRequest = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
		expect(scoreRequest.servingIds).toEqual([101]);
	});
});
