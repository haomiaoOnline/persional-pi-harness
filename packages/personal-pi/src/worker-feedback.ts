export interface WorkerOutcomeRecord {
	worker_id: string;
	task_type: string;
	success: boolean;
}

export interface WorkerSuccessRate {
	worker_id: string;
	task_type: string;
	successes: number;
	failures: number;
	total: number;
	rate: number;
}

export interface WorkerSuccessRateSnapshot {
	worker_id: string;
	task_type: string;
	successes: number;
	failures: number;
}

function key(workerId: string, taskType: string): string {
	return `${workerId}\u0000${taskType}`;
}

export class WorkerSuccessRateTracker {
	private readonly counts = new Map<string, WorkerSuccessRateSnapshot>();

	constructor(initial: readonly WorkerSuccessRateSnapshot[] = []) {
		for (const item of initial) {
			if (item.successes < 0 || item.failures < 0) throw new Error("success counts must be non-negative");
			this.counts.set(key(item.worker_id, item.task_type), { ...item });
		}
	}

	record(outcome: WorkerOutcomeRecord): WorkerSuccessRate {
		const current = this.counts.get(key(outcome.worker_id, outcome.task_type)) ?? {
			worker_id: outcome.worker_id,
			task_type: outcome.task_type,
			successes: 0,
			failures: 0,
		};
		if (outcome.success) current.successes += 1;
		else current.failures += 1;
		this.counts.set(key(outcome.worker_id, outcome.task_type), current);
		return this.rate(outcome.worker_id, outcome.task_type) as WorkerSuccessRate;
	}

	rate(workerId: string, taskType: string): WorkerSuccessRate | undefined {
		const current = this.counts.get(key(workerId, taskType));
		if (!current) return undefined;
		const total = current.successes + current.failures;
		return { ...current, total, rate: total === 0 ? 0 : current.successes / total };
	}

	snapshot(): WorkerSuccessRateSnapshot[] {
		return [...this.counts.values()].map((item) => ({ ...item }));
	}
}
