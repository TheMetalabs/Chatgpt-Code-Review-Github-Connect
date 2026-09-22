import type {RepairRecord} from "./json-repair-types.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, openSync, closeSync, fsyncSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Job, PostedReview, ReviewProvider, WebhookLog } from "./types.ts";
import { sanitizeProgressEvents } from "./review-progress.ts";
type Summary = {
    id: string;
    owner: string;
    repo: string;
    pr: number;
    title: string;
    status: string;
    trigger: string;
    sender: string;
    deliveryId: string;
    commentId?: number;
    createdAt: number;
    updatedAt: number;
    headSha: string;
    origin?: string;
    skipReason?: string;
    reviewId?: string;
    findingCount: number;
    providers: string[];
    providerVersions?: Partial<Record<ReviewProvider, string>>;
};
type Step = {
    id: string;
    stage: string;
    source: string;
    at: number;
    observedAt?: number;
    provider?: string;
    runId?: string;
};
export type CapturedResponse = {
    id: string; jobId: string; provider: "chatgpt" | "grok"; runId: string;
    responseId: string; sourceHash: string; headSha: string; text: string; at: number;
};
type StoredResponse = {
    json: string;
    original: string;
    jsonChars: number;
    originalChars: number;
    truncated: boolean;
    at: number;
};
type Query = {
    q?: string;
    status?: string;
    cursor?: string | null;
    limit?: number;
    reviewsOnly?: boolean;
};
type Delivery = {
    id: string;
    deliveryId: string;
    event: string;
    action: string;
    at: number;
    httpStatus: number;
    hmac: string;
    summary: string;
    reason?: string;
    jobId?: string;
    owner?: string;
    repo?: string;
    pr?: number;
    commentId?: number;
};
type Options = {
    maxTerminalJobs?: number;
    retentionDays?: number;
    maxResponseChars?: number;
    maxBytes?: number;
};
const terminal = new Set(["posted", "skipped", "cancelled", "dlq"]);
const safe = (value: unknown, length = 240) => String(value ?? "").replace(/[\u0000-\u0008]/g, "").replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{16,})\b/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, length);
const hash = (id: string) => createHash("sha256").update(id).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Private, single-writer filesystem archive, intentionally NOT an execution queue. */
export class ReviewHistoryStore {
    private memory = new Map<string, unknown>();
    private lastError: string | undefined;
    private writes = 0;
    private limits: Required<Options>;
    private directory: string | null;
    constructor(directory: string | null, options: Options = {}) {
        this.directory = directory;
        this.limits = { maxTerminalJobs: options.maxTerminalJobs ?? 1000, retentionDays: options.retentionDays ?? 30,
            maxResponseChars: options.maxResponseChars ?? 500000, maxBytes: options.maxBytes ?? 128 * 1024 * 1024 };
    }
    health() {
        return { ok: !this.lastError, mode: this.directory ? "filesystem" : "memory-test", error: this.lastError,
            maxTerminalJobs: this.limits.maxTerminalJobs, retentionDays: this.limits.retentionDays };
    }
    private read<T>(key: string): T | null {
        if (!this.directory)
            return this.memory.has(key) ? clone(this.memory.get(key) as T) : null;
        try {
            return JSON.parse(readFileSync(join(this.directory, key), "utf8")) as T;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
            this.lastError = "history_read_failed";
            throw new Error("history_read_failed");
        }
    }
    private write(key: string, value: unknown) {
        if (!this.directory) {
            this.memory.set(key, clone(value));
            return;
        }
        const path = join(this.directory, key), parent = dirname(path);
        const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            mkdirSync(parent, { recursive: true, mode: 0o700 });
            writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
            const fd = openSync(temporary, "r");
            try {
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(temporary, path);
            const dir = openSync(parent, "r");
            try {
                fsyncSync(dir);
            }
            finally {
                closeSync(dir);
            }
            this.lastError = undefined;
        }
        catch {
            try {
                rmSync(temporary, { force: true });
            }
            catch { /* Never replace the original on failure. */ }
            this.lastError = "history_write_failed";
            throw new Error("history_write_failed");
        }
    }
    private keys(kind: "jobs" | "deliveries") {
        if (!this.directory)
            return [...new Set([...this.memory.keys()].filter(k => k.startsWith(kind + "/")).map(k => k.split("/")[1]))];
        try {
            return readdirSync(join(this.directory, kind)).filter(k => /^[a-f0-9]{64}$/.test(k));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return [];
            this.lastError = "history_read_failed";
            throw new Error("history_read_failed");
        }
    }
    private jobKey(id: string, name = "meta") { return `jobs/${hash(id)}/${name}.json`; }
    recordJob(job: Job) {
        if (job.origin === "tape")
            return;
        const previous = this.read<Summary>(this.jobKey(job.id));
        const summary: Summary = { id: job.id, owner: safe(job.owner, 100), repo: safe(job.repo, 100), pr: job.pr,
            title: safe(job.title), status: job.status, trigger: job.trigger, sender: safe(job.sender, 100), deliveryId: safe(job.deliveryId, 160),
            commentId: job.thread?.commentId || undefined, createdAt: job.createdAt, updatedAt: job.updatedAt,
            headSha: job.headSha, origin: job.origin, skipReason: job.skipReason ? safe(job.skipReason) : undefined,
            providerVersions: Object.fromEntries(Object.entries(job.providerProgress || {}).map(([provider, progress]) => [provider, safe(progress?.extensionVersion || "unknown", 40)])),
            reviewId: job.postedReviewId, findingCount: job.findings?.length || 0, providers: job.reviewProviders || [] };
        // Heartbeats do not create repeated "generating" log lines or fsync large results.
        const signature = (s: Summary) => JSON.stringify({ ...s, updatedAt: 0 });
        if (previous && signature(previous) === signature(summary))
            return;
        if (previous?.status !== summary.status)
            this.append(job.id, {
                id: `server:${job.status}:${job.updatedAt}`, source: "server", stage: `job.${job.status}`, at: job.updatedAt,
            });
        this.write(this.jobKey(job.id), summary);
        if (++this.writes % 32 === 0)
            this.prune();
    }
    private append(id: string, step: Step) {
        const key = this.jobKey(id, "steps"), old = this.read<{
            items: Step[];
            dropped: number;
        }>(key) || { items: [], dropped: 0 };
        if (old.items.some(item => item.id === step.id))
            return;
        old.items.push(step);
        if (old.items.length > 2000) {
            old.dropped += old.items.length - 2000;
            old.items = old.items.slice(-2000);
        }
        this.write(key, old);
    }
    recordServerStep(id: string, stage: "local.requested" | "local.accepted" | "local.generating" | "local.response_received" | "local.failed") {
        if (!this.read<Summary>(this.jobKey(id)))
            return;
        this.append(id, { id: `server:${stage}`, source: "server", stage, provider: "local", at: Date.now() });
    }
    recordProgress(id: string, provider: ReviewProvider, runId: string, values: unknown) {
        if (!this.read<Summary>(this.jobKey(id)))
            return;
        const key = this.jobKey(id, "steps"), log = this.read<{
            items: Step[];
            dropped: number;
        }>(key) || { items: [], dropped: 0 };
        const ids = new Set(log.items.map(item => item.id));
        let changed = false;
        for (const event of sanitizeProgressEvents(values)) {
            const eventId = `${provider}:${runId}:${event.source}:${event.sequence}`;
            if (ids.has(eventId))
                continue;
            ids.add(eventId);
            changed = true;
            log.items.push({ id: eventId, source: event.source, stage: event.stage, observedAt: event.at, at: Date.now(), provider, runId: safe(runId, 128) });
        }
        if (!changed)
            return;
        if (log.items.length > 2000) {
            log.dropped += log.items.length - 2000;
            log.items = log.items.slice(-2000);
        }
        this.write(key, log);
    }
    recordObservation(id: string, provider: ReviewProvider, runId: string, text: string, totalChars: number, truncated: boolean) {
        if (!this.read<Summary>(this.jobKey(id)))
            throw new Error("history_job_missing");
        const value = { runId: safe(runId, 128), text: text.slice(0, 128000), totalChars,
            truncated: truncated || text.length > 128000, at: Date.now(), final: false };
        const key = this.jobKey(id, `observation-${provider}`);
        const previous = this.read<typeof value>(key);
        if (previous?.runId === value.runId && previous.text === value.text)
            return;
        this.write(key, value);
        this.append(id, { id: `observed:${provider}:${runId}`, source: "server", stage: "response.observed_unparsed", provider, runId: safe(runId, 128), at: value.at });
    }
    recordResponse(id: string, provider: ReviewProvider, json: string, original = "") {
        const job = this.read<Summary>(this.jobKey(id));
        if (!job)
            throw new Error("history_job_missing");
        const previous = this.read<StoredResponse>(this.jobKey(id, `response-${provider}`));
        if (!original && previous?.json === json)
            original = previous.original;
        if (previous?.json === json && previous.original === original) {
            this.append(id, { id: `response:${provider}:${hash(json)}`, source: "server", stage: "response.archived", provider, at: previous.at });
            return;
        }
        const cap = this.limits.maxResponseChars;
        const response: StoredResponse = { json: json.slice(0, cap), original: original.slice(0, cap), jsonChars: json.length,
            originalChars: original.length, truncated: json.length > cap || original.length > cap, at: Date.now() };
        this.write(this.jobKey(id, `response-${provider}`), response);
        this.append(id, { id: `response:${provider}:${hash(json)}`, source: "server", stage: "response.archived", provider, at: response.at });
    }
    /** The original and attempted intent are one durable record, never a diagnostic truncation. */
    putRepair(record: RepairRecord) {
        if (!this.read<Summary>(this.jobKey(record.jobId))) throw new Error("history_job_missing");
        if (!/^[a-f0-9]{64}$/.test(record.id) || record.original.length > this.limits.maxResponseChars ||
            (record.candidate?.length || 0) > this.limits.maxResponseChars) throw new Error("repair_archive_limit");
        const indexKey = this.jobKey(record.jobId, "repairs"), ids = this.read<string[]>(indexKey) || [];
        if (!ids.includes(record.id) && ids.length >= 8) throw new Error("repair_attempt_limit");
        const previous = this.getRepair(record.jobId, record.id);
        if (previous && previous.original !== record.original) throw new Error("repair_original_is_immutable");
        this.write(this.jobKey(record.jobId, `repair-${record.id}`), record);
        if (!ids.includes(record.id)) this.write(indexKey, [...ids, record.id]);
        this.append(record.jobId, {id:`repair:${record.id}:${record.status}`, stage:`repair.${record.status}`,
            source:"server", provider:record.provider, runId:record.runId, at:record.updatedAt});
    }
    getRepair(jobId: string, id: string): RepairRecord | null {
        if (!/^[a-f0-9]{64}$/.test(id)) return null;
        return this.read<RepairRecord>(this.jobKey(jobId, `repair-${id}`));
    }
    listRepairs(jobId: string): RepairRecord[] {
        return (this.read<string[]>(this.jobKey(jobId,"repairs")) || []).map(id=>this.getRepair(jobId,id)).filter((r):r is RepairRecord=>Boolean(r));
    }
    /** Full immutable source escrow. This is NOT a parsed result or a review vote. */
    putCapture(record: CapturedResponse) {
        if (!this.read<Summary>(this.jobKey(record.jobId))) throw new Error("history_job_missing");
        if (!/^[a-f0-9]{64}$/.test(record.id) || !record.text.trim() ||
            record.text.length > this.limits.maxResponseChars || hash(record.text) !== record.sourceHash)
            throw new Error("capture_archive_limit_or_hash");
        const key = this.jobKey(record.jobId, "captures"), ids = this.read<string[]>(key) || [];
        if (!ids.includes(record.id) && ids.length >= 8) throw new Error("capture_attempt_limit");
        const previous = this.getCapture(record.jobId, record.id);
        if (previous && JSON.stringify({...previous, at:0}) !== JSON.stringify({...record, at:0}))
            throw new Error("capture_is_immutable");
        const stored = previous || record;
        if (!previous) this.write(this.jobKey(record.jobId, `capture-${record.id}`), stored);
        if (!ids.includes(record.id)) this.write(key, [...ids, record.id]);
        // A failed index/step write must be retried before granting the receipt.
        this.append(record.jobId, {id:`capture:${record.id}`, stage:"response.source_archived", source:"server",
            provider:record.provider, runId:record.runId, at:stored.at});
        return stored;
    }
    getCapture(jobId: string, id: string): CapturedResponse | null {
        if (!/^[a-f0-9]{64}$/.test(id)) return null;
        return this.read<CapturedResponse>(this.jobKey(jobId, `capture-${id}`));
    }
    listCaptures(jobId: string): CapturedResponse[] {
        return (this.read<string[]>(this.jobKey(jobId,"captures")) || []).map(id=>this.getCapture(jobId,id))
            .filter((record):record is CapturedResponse=>Boolean(record));
    }
    recordReview(review: PostedReview) {
        if (!this.read<Summary>(this.jobKey(review.jobId)))
            return;
        this.write(this.jobKey(review.jobId, "review"), { id: review.id, jobId: review.jobId, owner: review.owner, repo: review.repo,
            pr: review.pr, githubId: review.githubId, headSha: review.headSha, event: review.event, at: review.at, findingCount: review.comments.length,
            body: review.body.slice(0, 100000), comments: review.comments.slice(0, 50).map(comment => ({ file: comment.file, line: comment.line, body: comment.body.slice(0, 20000) })),
            truncated: review.body.length > 100000 || review.comments.length > 50 || review.comments.some(comment => comment.body.length > 20000) });
        this.append(review.jobId, { id: `review:${review.id}`, source: "server", stage: "review.posted", at: review.at });
    }
    recordDelivery(event: WebhookLog, target: {
        owner?: string;
        repo?: string;
        pr?: number;
        commentId?: number;
    } = {}) {
        const delivery: Delivery = { id: event.id, deliveryId: safe(event.deliveryId, 160), event: event.event, action: event.action,
            at: event.at, httpStatus: event.httpStatus, hmac: event.hmac, summary: safe(event.summary), reason: safe(event.skipReason || event.rejectReason) || undefined,
            jobId: event.jobId, ...target };
        this.write(`deliveries/${hash(event.id)}/meta.json`, delivery);
        if (++this.writes % 32 === 0)
            this.prune();
    }
    getJob(id: string, includeResponses = false) {
        const job = this.read<Summary>(this.jobKey(id));
        if (!job)
            return null;
        const log = this.read<{
            items: Step[];
            dropped: number;
        }>(this.jobKey(id, "steps"));
        const responses: Partial<Record<ReviewProvider, StoredResponse>> = {};
        if (includeResponses)
            for (const p of ["chatgpt", "grok", "local"] as const) {
                const r = this.read<StoredResponse>(this.jobKey(id, `response-${p}`));
                if (r)
                    responses[p] = r;
            }
        const observations: Partial<Record<ReviewProvider, unknown>> = {};
        if (includeResponses)
            for (const p of ["chatgpt", "grok", "local"] as const) {
                const observed = this.read(this.jobKey(id, `observation-${p}`));
                if (observed)
                    observations[p] = observed;
            }
        const repairs = this.listRepairs(id).map(record => {
            const {original, candidate, raw, ...metadata} = record;
            return includeResponses ? record : metadata;
        });
        const captures = this.listCaptures(id).map(record => {
            const {text, ...metadata} = record;
            return includeResponses ? {...record,totalChars:text.length} : {...metadata, totalChars:text.length};
        });
        return { job, repairs, captures, steps: log?.items || [], droppedSteps: log?.dropped || 0, review: this.read(this.jobKey(id, "review")),
            ...(includeResponses ? { responses, observations } : {}), historical: true };
    }
    private page<T extends {
        id: string;
    }>(items: T[], query: Query, time: (item: T) => number) {
        const q = (query.q || "").trim().toLowerCase().slice(0, 160);
        let rows = items.filter(item => !q || JSON.stringify(item).toLowerCase().includes(q)).sort((a, b) => time(b) - time(a) || b.id.localeCompare(a.id));
        const total = rows.length;
        if (query.cursor) {
            let cursor: unknown;
            try {
                cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
            }
            catch {
                throw new Error("invalid_cursor");
            }
            if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isFinite(cursor[0]) || typeof cursor[1] !== "string")
                throw new Error("invalid_cursor");
            const [at, id] = cursor as [
                number,
                string
            ];
            rows = rows.filter(row => time(row) < at || (time(row) === at && row.id.localeCompare(id) < 0));
        }
        const limit = Math.max(1, Math.min(Number(query.limit) || 25, 100));
        const selected = rows.slice(0, limit), last = selected.at(-1);
        return { items: selected, total, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([time(last), last.id])).toString("base64url") : null };
    }
    listJobs(query: Query = {}) {
        const items = this.keys("jobs").map(key => this.read<Summary>(`jobs/${key}/meta.json`)).filter((x): x is Summary => Boolean(x));
        return this.page(items.filter(row => (!query.status || row.status === query.status) && (!query.reviewsOnly || row.status === "posted")), query, row => row.createdAt);
    }
    listDeliveries(query: Query = {}) {
        const items = this.keys("deliveries").map(key => this.read<Delivery>(`deliveries/${key}/meta.json`)).filter((x): x is Delivery => Boolean(x));
        return this.page(items, query, row => row.at);
    }
    prune(now = Date.now()) {
        // Enumerate all summaries, not only the first UI page. Nonterminal jobs are pinned.
        const all = this.keys("jobs").map(key => ({ key, meta: this.read<Summary>(`jobs/${key}/meta.json`) })).filter(row => row.meta);
        const completed = all.filter(row => terminal.has(row.meta!.status)).sort((a, b) => b.meta!.updatedAt - a.meta!.updatedAt);
        let size = 0;
        if (this.directory)
            for (const row of all)
                for (const file of readdirSync(join(this.directory, "jobs", row.key)))
                    size += statSync(join(this.directory, "jobs", row.key, file)).size;
        for (let i = completed.length - 1; i >= 0; i--) {
            const row = completed[i];
            if (i < this.limits.maxTerminalJobs && now - row.meta!.updatedAt < this.limits.retentionDays * 86400000 && size <= this.limits.maxBytes)
                continue;
            const prefix = `jobs/${row.key}/`;
            if (this.directory) {
                for (const file of readdirSync(join(this.directory, "jobs", row.key)))
                    size -= statSync(join(this.directory, "jobs", row.key, file)).size;
                rmSync(join(this.directory, "jobs", row.key), { recursive: true });
            }
            else
                for (const key of this.memory.keys())
                    if (key.startsWith(prefix))
                        this.memory.delete(key);
        }
        const deliveries = this.keys("deliveries").map(key => ({ key, meta: this.read<Delivery>(`deliveries/${key}/meta.json`) })).filter(row => row.meta).sort((a, b) => b.meta!.at - a.meta!.at);
        for (const [i, row] of deliveries.entries())
            if (i >= 5000 || now - row.meta!.at > this.limits.retentionDays * 86400000) {
                if (this.directory)
                    rmSync(join(this.directory, "deliveries", row.key), { recursive: true });
                else
                    this.memory.delete(`deliveries/${row.key}/meta.json`);
            }
    }
}
let singleton: ReviewHistoryStore | undefined;
export function reviewHistory() {
    return singleton ||= new ReviewHistoryStore(process.env.ASHLAR_HISTORY_DIR || (process.env.NODE_TEST_CONTEXT ? null : ".data/review-history"));
}
/** Operational metadata may degrade visibly; failed archival never gets a result ACK. */
export function recordJobHistory(job: Job) { try {
    reviewHistory().recordJob(job);
}
catch { /* exposed through health(), no silent success claim */ } }
export function recordDeliveryHistory(event: WebhookLog, target?: {
    owner?: string;
    repo?: string;
    pr?: number;
    commentId?: number;
}) {
    try {
        reviewHistory().recordDelivery(event, target);
    }
    catch { /* health() retains the failure */ }
}
