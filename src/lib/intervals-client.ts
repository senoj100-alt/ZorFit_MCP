export interface IntervalsCredentials {
	apiKey?: string;
	athleteId?: string;
}

export class IntervalsClient {
	private readonly baseUrl = "https://intervals.icu/api/v1";

	constructor(private readonly credentials: IntervalsCredentials) {}

	private requireCredentials(): Required<IntervalsCredentials> {
		const { apiKey, athleteId } = this.credentials;
		if (!apiKey || !athleteId) {
			throw new Error(
				"Intervals.icu is not configured. Set INTERVALS_ICU_API_KEY and INTERVALS_ICU_ATHLETE_ID as Worker secrets.",
			);
		}
		return { apiKey, athleteId };
	}

	private async request<T>(
		path: string,
		options: RequestInit = {},
	): Promise<T> {
		const { apiKey } = this.requireCredentials();
		const response = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				Authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`,
				Accept: "application/json",
				...options.headers,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Intervals.icu API error (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		return response.json() as Promise<T>;
	}

	private defaultOldestDate(): string {
		const date = new Date();
		date.setUTCDate(date.getUTCDate() - 30);
		return date.toISOString().slice(0, 10);
	}

	async getAthlete(): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}`);
	}

	async getRecentActivities(args: {
		oldest?: string;
		newest?: string;
		limit?: number;
	}): Promise<unknown[]> {
		const { athleteId } = this.requireCredentials();
		const params = new URLSearchParams();
		params.set("oldest", args.oldest ?? this.defaultOldestDate());
		if (args.newest) {
			params.set("newest", args.newest);
		}

		const suffix = params.size ? `?${params.toString()}` : "";
		const activities = await this.request<unknown[]>(
			`/athlete/${encodeURIComponent(athleteId)}/activities${suffix}`,
		);
		return activities.slice(0, args.limit ?? 30);
	}

	async getWellness(args: {
		oldest?: string;
		newest?: string;
		limit?: number;
	}): Promise<unknown[]> {
		const { athleteId } = this.requireCredentials();
		const params = new URLSearchParams();
		params.set("oldest", args.oldest ?? this.defaultOldestDate());
		if (args.newest) {
			params.set("newest", args.newest);
		}

		const suffix = params.size ? `?${params.toString()}` : "";
		const wellness = await this.request<unknown[]>(
			`/athlete/${encodeURIComponent(athleteId)}/wellness${suffix}`,
		);
		return wellness.slice(0, args.limit ?? 30);
	}

	async updateActivity(activityId: string, data: Record<string, unknown>): Promise<unknown> {
		return this.request(`/activity/${encodeURIComponent(activityId)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async deleteActivity(activityId: string): Promise<unknown> {
		await this.request(`/activity/${encodeURIComponent(activityId)}`, {
			method: "DELETE",
		});
		return { activity_id: activityId, deleted: true };
	}

	async updateWellness(data: Record<string, unknown>, date?: string): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		const path = date
			? `/athlete/${encodeURIComponent(athleteId)}/wellness/${encodeURIComponent(date)}`
			: `/athlete/${encodeURIComponent(athleteId)}/wellness`;
		return this.request(path, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async createEvent(data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async updateEvent(eventId: number, data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/events/${eventId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async deleteEvent(eventId: number): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		await this.request(`/athlete/${encodeURIComponent(athleteId)}/events/${eventId}`, {
			method: "DELETE",
		});
		return { event_id: eventId, deleted: true };
	}

	async bulkCreateEvents(events: Array<Record<string, unknown>>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/events/bulk`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(events),
		});
	}

	async bulkDeleteEvents(eventIds: number[]): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/events/bulk`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids: eventIds }),
		});
	}

	async duplicateEvent(eventId: number, newDate: string): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/events/${eventId}/duplicate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ start_date_local: newDate }),
		});
	}

	async createGear(data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/gear`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async updateGear(gearId: string, data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/gear/${encodeURIComponent(gearId)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async deleteGear(gearId: string): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		await this.request(`/athlete/${encodeURIComponent(athleteId)}/gear/${encodeURIComponent(gearId)}`, {
			method: "DELETE",
		});
		return { gear_id: gearId, deleted: true };
	}

	async createGearReminder(gearId: string, data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/gear/${encodeURIComponent(gearId)}/reminders`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async updateGearReminder(
		gearId: string,
		reminderId: number,
		data: Record<string, unknown>,
	): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(
			`/athlete/${encodeURIComponent(athleteId)}/gear/${encodeURIComponent(gearId)}/reminders/${reminderId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			},
		);
	}

	async createSportSettings(data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/sport-settings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async updateSportSettings(sportId: number, data: Record<string, unknown>): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/sport-settings/${sportId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async applySportSettings(sportId: number, oldest?: string): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		const params = new URLSearchParams();
		if (oldest) params.set("oldest", oldest);
		const suffix = params.size ? `?${params.toString()}` : "";
		return this.request(`/athlete/${encodeURIComponent(athleteId)}/sport-settings/${sportId}/apply${suffix}`, {
			method: "POST",
		});
	}

	async deleteSportSettings(sportId: number): Promise<unknown> {
		const { athleteId } = this.requireCredentials();
		await this.request(`/athlete/${encodeURIComponent(athleteId)}/sport-settings/${sportId}`, {
			method: "DELETE",
		});
		return { sport_id: sportId, deleted: true };
	}
}
