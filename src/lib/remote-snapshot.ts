import type { BotSettings, GithubReady, Job, PostedReview, WebhookLog } from "./types";
import type { BridgeReady } from "./store";
export type RemoteSnapshot = {
    jobs: Job[];
    events: WebhookLog[];
    reviews: PostedReview[];
    settings?: Partial<BotSettings>;
    github?: GithubReady;
    bridge?: BridgeReady;
    history?: {
        ok: boolean;
        mode: string;
        error?: string;
    };
};
/** Validate essential rendering invariants before replacing the visible state. */
export function validRemoteSnapshot(value: unknown): value is RemoteSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const row = value as Record<string, unknown>;
    const collection = (key: string, check: (item: Record<string, unknown>) => boolean) => Array.isArray(row[key]) && (row[key] as unknown[]).every(item => item && typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" && check(item as Record<string, unknown>));
    return collection("jobs", j => typeof j.status === "string" && typeof j.createdAt === "number" &&
        Array.isArray(j.findings) && Array.isArray(j.traces) && Array.isArray(j.assumptions)) &&
        collection("events", e => typeof e.at === "number") &&
        collection("reviews", r => Array.isArray(r.comments) && typeof r.body === "string" && typeof r.at === "number");
}
