import type {RepairRecord} from "./json-repair-types.ts";

/** "Repair waiting for local model (position N)" while a running repair still waits for the shared
 * local model (short lane: behind the request in flight, ahead of queued fix/review jobs); undefined
 * otherwise, so the caller shows its ordinary status label. */
export function repairWaitingLabel(repair: Pick<RepairRecord,"status"|"modelQueuePosition">): string | undefined {
  return repair.status==="running" && typeof repair.modelQueuePosition==="number"
    ? `Repair waiting for local model (position ${repair.modelQueuePosition})` : undefined;
}
