/** Bounded diagnostic metadata only. No field here authorizes cleanup or generation. */
const ADMISSION_PHASES = ["not_checked", "polling", "admitted", "recovered", "idle", "tab_capacity", "provider_quota", "disconnected", "duplicate_job"] as const;
type AdmissionPhase = typeof ADMISSION_PHASES[number];
export type WorkerStatus = {
  observedAt: number;
  receivedAt: number;
  extensionVersion: string;
  admissionPhase: AdmissionPhase;
  activeJobs: number;
  pendingCleanup: number;
  sourceCaptured: number;
  waitingForJson: number;
  capacity: {
    limit: number; used: number; managedTabs: number; reserved: number;
    restorationReserved: number; providerTabs: number; unverifiedTabs: number; orphanTabs: number; unknownReserved: number;
  };
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : undefined;
}
export function sanitizeWorkerStatus(value: unknown, version: unknown, receivedAt: number): WorkerStatus | undefined {
  const row = object(value), capacity = object(row?.capacity);
  if (!row || !capacity || typeof row.checkedAt !== "number" || !Number.isFinite(row.checkedAt) || row.checkedAt < 0 ||
      typeof row.admissionPhase !== "string" || !ADMISSION_PHASES.includes(row.admissionPhase as AdmissionPhase)) return;
  const limit = count(capacity.limit), used = count(capacity.used);
  if (!limit || limit > 16 || used === undefined) return;
  // A partial/invalid report is unknown, not a fabricated empty capacity report.
  for (const key of ["managedTabs", "reserved", "restorationReserved", "providerTabs", "unverifiedTabs"]) {
    if (count(capacity[key]) === undefined) return;
  }
  return {observedAt: row.checkedAt, receivedAt,
    extensionVersion: typeof version === "string" && /^[0-9.]{1,32}$/.test(version) ? version : "unknown",
    admissionPhase: row.admissionPhase as AdmissionPhase,
    activeJobs: count(row.activeJobs) ?? 0, pendingCleanup: count(row.pendingCleanup) ?? 0,
    sourceCaptured: count(row.sourceCaptured) ?? 0, waitingForJson: count(row.waitingForJson) ?? 0,
    capacity: {limit, used, managedTabs: capacity.managedTabs as number, reserved: capacity.reserved as number,
      restorationReserved: capacity.restorationReserved as number, providerTabs: capacity.providerTabs as number,
      unverifiedTabs: capacity.unverifiedTabs as number, orphanTabs: count(capacity.orphanTabs) ?? 0, unknownReserved: count(capacity.unknownReserved) ?? 0}};
}
export function workerStatusLabel(status: WorkerStatus | undefined, fresh: boolean): string {
  if (!status) return "Heartbeat only · admission state not reported";
  const prefix = fresh ? "" : "Last report (not current): ";
  const slots = `${status.capacity.used}/${status.capacity.limit}`;
  if (status.admissionPhase === "tab_capacity") return `${prefix}New jobs paused · managed capacity ${slots}`;
  if (status.admissionPhase === "provider_quota") return `${prefix}New jobs paused · provider quota`;
  if (status.admissionPhase === "disconnected") return `${prefix}Admission transport unavailable · originals preserved`;
  return `${prefix}Admission: ${status.admissionPhase} · managed capacity ${slots}`;
}

function sameWorkerObservation(a: WorkerStatus, b: WorkerStatus): boolean {
  return a.observedAt === b.observedAt &&
    a.extensionVersion === b.extensionVersion &&
    a.admissionPhase === b.admissionPhase &&
    a.activeJobs === b.activeJobs &&
    a.pendingCleanup === b.pendingCleanup &&
    a.sourceCaptured === b.sourceCaptured &&
    a.waitingForJson === b.waitingForJson &&
    a.capacity.limit === b.capacity.limit &&
    a.capacity.used === b.capacity.used &&
    a.capacity.managedTabs === b.capacity.managedTabs &&
    a.capacity.reserved === b.capacity.reserved &&
    a.capacity.restorationReserved === b.capacity.restorationReserved &&
    a.capacity.providerTabs === b.capacity.providerTabs &&
    a.capacity.unverifiedTabs === b.capacity.unverifiedTabs &&
    a.capacity.orphanTabs === b.capacity.orphanTabs &&
    a.capacity.unknownReserved === b.capacity.unknownReserved;
}

/** Server receipt time advances only for a genuinely new sanitized observation.
 * Browser wall-clock time is informational and never extends freshness by itself.
 */
export function mergeWorkerStatus(previous: WorkerStatus | undefined, value: unknown, version: unknown, receivedAt: number): WorkerStatus | undefined {
  const next = sanitizeWorkerStatus(value, version, receivedAt);
  if (!next) return previous;
  if (previous && sameWorkerObservation(previous, next)) {
    return {...next, receivedAt: previous.receivedAt};
  }
  return next;
}

export function workerStatusIsFresh(status: WorkerStatus | undefined, now: number, maxAge: number): boolean {
  return Boolean(status && Number.isFinite(now) && Number.isFinite(maxAge) && maxAge >= 0 &&
    now >= status.receivedAt && now - status.receivedAt < maxAge);
}
