import type {RepairSchema} from "./review-json-repair.ts";
export type RepairStatus = "running" | "ready" | "accepted" | "disabled" | "superseded" | "interrupted" | "needs_attention";
export type RepairRecord = {
  id: string; jobId: string; provider: "chatgpt" | "grok"; runId: string; responseId: string;
  sourceHash: string; schema: RepairSchema; schemaVersion: string; headSha: string;
  original: string; candidate?: string; raw?: string; errors: string[];
  model: string; status: RepairStatus; attempts: number; createdAt: number; updatedAt: number;
  /** While "running": the 1-based position waiting for the shared local model (short lane). Absent
   * once the model is granted (or when it never had to wait). Display only. */
  modelQueuePosition?: number;
};
export type RepairReceipt = {id: string; sourceHash: string; responseId: string; runId: string; normalizedBy: "local"};
