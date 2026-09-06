export interface PersistedProcessOwner {
  status: string;
  process_pid: number | null;
}

/**
 * A non-running owner with a retained PID is a fail-closed recovery state: the
 * old provider process may still belong to AIKombinat and must keep all
 * ownership until Stop or confirmed death reconciles it.
 */
export function hasUnresolvedProcess(owner: PersistedProcessOwner | null | undefined): boolean {
  return !!owner && owner.status !== 'running' && !!owner.process_pid && owner.process_pid > 0;
}

export function unresolvedProcessError(ownerLabel: string, pid: number): Error {
  return new Error(`${ownerLabel} requires process recovery for retained PID ${pid}. Retry Stop or wait for confirmed exit before starting another execution.`);
}

export function assertNoUnresolvedProcess(ownerLabel: string, owner: PersistedProcessOwner): void {
  if (hasUnresolvedProcess(owner)) throw unresolvedProcessError(ownerLabel, owner.process_pid!);
}
