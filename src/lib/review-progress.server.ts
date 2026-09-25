import { createHash } from "node:crypto";
import { isLabelledStage, isUnlabelledStage, UNLABELLED_PREFIX, type ProgressEvent, type ProgressStage, type UnlabelledStage } from "./review-progress.ts";

/** The shape of a stage name the extension records: snake_case from a letter, shorter than the bound the
 * worker puts on a page-reported stage (background.js, e.stage.length < 80). No space, capital or
 * punctuation matches, so free text (a prompt, a detail suffix) is not a stage and is dropped. */
const STAGE_NAME = /^[a-z][a-z0-9_]{0,78}$/;

/** The sentinel a stage without a label is kept as: the first 8 hex digits of the SHA-256 of its name.
 * A stage name passes a lexical check only, so it can still spell something that must not be retained
 * (a token, a user's text in snake_case); the sentinel keeps the event and none of the name. To map a
 * hash back, `npm run stage-hashes` prints the hash of every stage the extension records. */
export const unlabelledSentinel = (stage: string): UnlabelledStage =>
    `${UNLABELLED_PREFIX}${createHash("sha256").update(stage).digest("hex").slice(0, 8)}` as UnlabelledStage;

/** A page or worker stage as the server keeps it, or undefined when it is not a stage: a labelled stage as
 * it is, a sentinel as it is (so keeping is idempotent: a stored or re-sanitized event reads back
 * unchanged), and any other stage name as its sentinel. */
export function keptStage(stage: unknown): ProgressStage | undefined {
    if (typeof stage !== "string")
        return undefined;
    if (isLabelledStage(stage) || isUnlabelledStage(stage))
        return stage;
    return STAGE_NAME.test(stage) ? unlabelledSentinel(stage) : undefined;
}

/** The well-formed progress events of an extension report, the last 256. A stage without a label is kept
 * as its sentinel (a stage the extension records ahead of its label must not vanish from history, and
 * its name must not be retained); a stage that is not a stage name is dropped. */
export function sanitizeProgressEvents(value: unknown): ProgressEvent[] {
    if (!Array.isArray(value))
        return [];
    return value.slice(-256).flatMap(item => {
        if (!item || typeof item !== "object")
            return [];
        const row = item as Record<string, unknown>;
        const stage = keptStage(row.stage);
        if ((row.source !== "page" && row.source !== "worker") ||
            !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 || !stage ||
            typeof row.at !== "number" || !Number.isFinite(row.at) || row.at < 0)
            return [];
        return [{ source: row.source, sequence: Number(row.sequence), stage, at: row.at }];
    });
}
