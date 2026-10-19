/** Tab lifecycle events the extension uploads on its bridge pings (background.js tabLog): metadata
 * only, sanitized again here, written to the server log so what happened to a review tab (created,
 * closed, preserved, swept, a failed close) can be read without opening Chrome. */
export type TabEvent = {seq: number; at: number; event: string; fields: Record<string, string | number>};

const MAX_EVENTS = 32;
// The largest time a Date can hold; anything beyond would make toISOString throw and break the ping.
const MAX_TIME = 8.64e15;
const FIELDS = ["provider", "jobId", "runId", "tabId", "cause", "outcome", "reason", "why", "attempts", "ageMs", "error", "note"] as const;

function text(value: string): string {
  return value.replace(/[^\w:.\-/ ]/g, "_").slice(0, 160);
}

export function sanitizeTabEvents(value: unknown): TabEvent[] {
  if (!Array.isArray(value)) return [];
  const out: TabEvent[] = [];
  for (const raw of value.slice(0, MAX_EVENTS)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.event !== "string" || !/^[a-z_]{1,48}$/.test(row.event)) continue;
    const fields: Record<string, string | number> = {};
    for (const key of FIELDS) {
      const v = row[key];
      if (typeof v === "number" && Number.isFinite(v)) fields[key] = v;
      else if (typeof v === "string" && v) fields[key] = text(v);
    }
    out.push({
      seq: typeof row.seq === "number" && Number.isSafeInteger(row.seq) ? row.seq : 0,
      at: typeof row.at === "number" && Number.isFinite(row.at) && row.at >= 0 && row.at <= MAX_TIME ? row.at : 0,
      event: row.event,
      fields,
    });
  }
  return out;
}

export function formatTabEvent(event: TabEvent): string {
  const pairs = Object.entries(event.fields).map(([key, v]) => (typeof v === "string" && /\s/.test(v) ? `${key}="${v}"` : `${key}=${v}`));
  const at = event.at ? new Date(event.at).toISOString() : "unknown";
  return `[ashlar] tab-event ${event.event} seq=${event.seq} at=${at}${pairs.length ? " " + pairs.join(" ") : ""}`;
}

export function logTabEvents(value: unknown, log: (line: string) => void = line => console.info(line)): number {
  const events = sanitizeTabEvents(value);
  for (const event of events) log(formatTabEvent(event));
  return events.length;
}
