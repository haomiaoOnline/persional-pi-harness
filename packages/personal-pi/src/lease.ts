import type { Lease, LeaseDecision } from "./types.ts";

export class LeaseManager {
	private readonly current = new Map<string, Lease>();
	private readonly nextEpoch = new Map<string, number>();

	acquire(taskId: string, workerId: string, issuedAt = new Date().toISOString()): Lease {
		const epoch = (this.nextEpoch.get(taskId) ?? 0) + 1;
		this.nextEpoch.set(taskId, epoch);
		const lease = { task_id: taskId, worker_id: workerId, lease_epoch: epoch, issued_at: issuedAt };
		this.current.set(taskId, lease);
		return { ...lease };
	}

	currentLease(taskId: string): Lease | undefined {
		const lease = this.current.get(taskId);
		return lease ? { ...lease } : undefined;
	}

	acceptResult(lease: Lease): LeaseDecision {
		const current = this.current.get(lease.task_id);
		if (!current) return { accepted: false, reason: "unknown_lease" };
		if (current.lease_epoch !== lease.lease_epoch) return { accepted: false, reason: "stale_result" };
		if (current.worker_id !== lease.worker_id) return { accepted: false, reason: "worker_mismatch" };
		return { accepted: true, reason: "current" };
	}

	release(lease: Lease): boolean {
		const decision = this.acceptResult(lease);
		if (!decision.accepted) return false;
		this.current.delete(lease.task_id);
		return true;
	}
}
