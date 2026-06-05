import app from "./app.js";
import { processNutritionNotifications } from "./lib/scheduled-nutrition.js";

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Parameters<typeof processNutritionNotifications>[0]) {
		const result = await processNutritionNotifications(env);
		console.log(`Nutrition notification run complete: ${result.processed} processed, ${result.failed} failed.`);
	},
};

// Export Durable Object
export { ZorFitMCP } from "./mcp-agent.js";
