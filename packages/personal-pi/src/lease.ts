import type { PersistentStateStore } from "./persistence.ts";
import type { Lease, LeaseDecision } from "./types.ts";

export class LeaseManager {
	private readonly current = new Map<string, Lease>();
	private readonly nextEpoch = new Map<string, number>();
	private readonly store?: PersistentStateStore;

	constructor(store?: PersistentStateStore) {
		this.store = store;
		if (!store) return;
		const state = store.read();
		for (const [taskId, lease] of Object.entries(state.leases)) this.current.set(taskId, { ...lease });
		for (const [taskId, epoch] of Object.entries(state.lease_epochs)) this.nextEpoch.set(taskId, epoch);
		for (const lease of this.current.values()) {
			this.nextEpoch.set(lease.task_id, Math.max(this.nextEpoch.get(lease.task_id) ?? 0, lease.lease_epoch));
		}
	}

	acquire(taskId: string, workerId: string, issuedAt = new Date().toISOString()): Lease {
		if (this.store) {
			let lease!: Lease;
			this.store.transact((state) => {
				const epoch = Math.max(state.lease_epochs[taskId] ?? 0, this.nextEpoch.get(taskId) ?? 0) + 1;
				lease = { task_id: taskId, worker_id: workerId, lease_epoch: epoch, issued_at: issuedAt };
				state.lease_epochs[taskId] = epoch;
				state.leases[taskId] = { ...lease };
			});
			this.nextEpoch.set(taskId, lease.lease_epoch);
			this.current.set(taskId, lease);
			return { ...lease };
		}
		const epoch = (this.nextEpoch.get(taskId) ?? 0) + 1;
		this.nextEpoch.set(taskId, epoch);
		const lease = { task_id: taskId, worker_id: workerId, lease_epoch: epoch, issued_at: issuedAt };
		this.current.set(taskId, lease);
		return { ...lease };
	}

	currentLease(taskId: string): Lease | undefined {
		if (this.store) {
			const lease = this.store.read().leases[taskId];
			if (!lease) {
				this.current.delete(taskId);
				return undefined;
			}
			this.current.set(taskId, { ...lease });
			return { ...lease };
		}
		const lease = this.current.get(taskId);
		return lease ? { ...lease } : undefined;
	}

	acceptResult(lease: Lease): LeaseDecision {
		const current = this.store?.read().leases[lease.task_id] ?? this.current.get(lease.task_id);
		if (!current) return { accepted: false, reason: "unknown_lease" };
		if (current.lease_epoch !== lease.lease_epoch) return { accepted: false, reason: "stale_result" };
		if (current.worker_id !== lease.worker_id) return { accepted: false, reason: "worker_mismatch" };
		return { accepted: true, reason: "current" };
	}

	release(lease: Lease): boolean {
		if (this.store) {
			let released = false;
			this.store.transact((state) => {
				const current = state.leases[lease.task_id];
				if (current?.lease_epoch === lease.lease_epoch && current.worker_id === lease.worker_id) {
					delete state.leases[lease.task_id];
					released = true;
				}
			});
			if (released) this.current.delete(lease.task_id);
			return released;
		}
		const decision = this.acceptResult(lease);
		if (!decision.accepted) return false;
		this.current.delete(lease.task_id);
		return true;
	}
}
