import {RepairHistory, type RepairHistoryRow} from "@/components/repair-history";
import { useEffect, useRef, useState } from "react";
import { PROGRESS_LABELS } from "@/lib/review-progress";
type Row = {
    id: string;
    providerVersions?: Record<string, string>;
    owner?: string;
    repo?: string;
    pr?: number;
    title?: string;
    status?: string;
    createdAt?: number;
    at?: number;
    commentId?: number;
    deliveryId?: string;
    reason?: string;
    summary?: string;
    jobId?: string;
    findingCount?: number;
};
type Detail = {
    repairs?: RepairHistoryRow[];
    job: Row;
    inCurrentRuntime: boolean;
    droppedSteps: number;
    steps: {
        id: string;
        stage: string;
        source: string;
        at: number;
        observedAt?: number;
        provider?: string;
        runId?: string;
    }[];
    observations?: Record<string, {
        text: string;
        totalChars: number;
        truncated: boolean;
        runId: string;
        at: number;
    }>;
    review?: {
        githubId?: number;
        at: number;
        event: string;
        body?: string;
        comments?: {
            file: string;
            line: number;
            body: string;
        }[];
        truncated?: boolean;
    };
    responses?: Record<string, {
        json: string;
        original: string;
        jsonChars: number;
        originalChars: number;
        truncated: boolean;
    }>;
};
const time = (at?: number) => at ? new Date(at).toLocaleString() : "—";
function download(name: string, value: unknown) { const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }
export function HistoryBrowser({ initialKind = "jobs" }: {
    initialKind?: "jobs" | "reviews" | "deliveries";
}) {
    const [token, setToken] = useState(""), [access, setAccess] = useState("");
    const [kind, setKind] = useState(initialKind), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [status, setStatus] = useState("");
    const [cursor, setCursor] = useState<string | null>(null), [previous, setPrevious] = useState<(string | null)[]>([]);
    const [rows, setRows] = useState<Row[]>([]), [next, setNext] = useState<string | null>(null), [total, setTotal] = useState(0);
    const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
    const [loading, setLoading] = useState(false), [error, setError] = useState(""), [lastRead, setLastRead] = useState<number>();
    const [refresh, setRefresh] = useState(0), [storage, setStorage] = useState("");
    const detailFlight = useRef(0);
    useEffect(() => { const id = new URLSearchParams(window.location.search).get("jobId"); if (id)
        setSelected(id); }, []);
    useEffect(() => {
        if (!access)
            return;
        const controller = new AbortController();
        let alive = true;
        setLoading(true);
        setError("");
        const params = new URLSearchParams({ kind, q: search, status, limit: "25" });
        if (cursor)
            params.set("cursor", cursor);
        void (async () => {
            try {
                const response = await fetch(`/api/history?${params}`, { cache: "no-store", headers: { "x-ashlar-history-token": access }, signal: controller.signal });
                const body = await response.json();
                if (!response.ok || !body.ok)
                    throw new Error(response.status === 401 ? "History access token was rejected." : body.error || "History could not be read.");
                if (alive) {
                    setRows(body.items);
                    setNext(body.nextCursor);
                    setTotal(body.total);
                    setLastRead(Date.now());
                    setStorage(body.health?.ok ? `Persistent history · retention ${body.health.retentionDays} days for completed records` : `History storage warning: ${body.health?.error || "unavailable"}`);
                }
            }
            catch (e) {
                if (alive)
                    setError(e instanceof Error ? e.message : "History request failed.");
            }
            finally {
                if (alive)
                    setLoading(false);
            }
        })();
        return () => { alive = false; controller.abort(); }; // Cancels only this UI read, never a review.
    }, [access, kind, search, status, cursor, refresh]);
    async function openJob(id: string, withResponses = false) {
        const generation = ++detailFlight.current;
        setSelected(id);
        setError("");
        if (detail?.job.id !== id)
            setDetail(null);
        try {
            const response = await fetch(`/api/history?jobId=${encodeURIComponent(id)}${withResponses ? "&responses=1" : ""}`, { cache: "no-store", headers: { "x-ashlar-history-token": access } });
            const body = await response.json();
            if (!response.ok || !body.ok)
                throw new Error(body.error || "Job history could not be read.");
            if (generation === detailFlight.current)
                setDetail(body.record);
        }
        catch (e) {
            if (generation === detailFlight.current)
                setError(e instanceof Error ? e.message : "Job history request failed.");
        }
    }
    useEffect(() => { if (access && selected)
        void openJob(selected); return () => { detailFlight.current++; }; }, [access, selected]);
    function changeKind(value: typeof kind) { setKind(value); setCursor(null); setPrevious([]); }
    const inputClass = "rounded border border-line bg-bg px-3 py-2 text-sm text-fg";
    return <section className="space-y-5" aria-label="Operational history">
    <p className="text-sm text-fg-muted">Search the persisted request, review and delivery history. Opening an archived job never restarts a model. Timestamps are local; client observations and server receipt times are recorded separately.</p>
    {!access ? <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); setAccess(token); setToken(""); }}>
      <label className="text-sm">History token <input aria-label="History access token" className={inputClass + " ml-2"} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required/></label>
      <button className={inputClass} type="submit">Open private history</button>
      <p className="w-full text-xs text-fg-subtle">Use the server's ASHLAR_HISTORY_TOKEN, not the Chrome bridge token. The token stays in this page's memory. It is not included in URLs, logs or exports.</p>
    </form> : <>
      <div className="flex flex-wrap items-center gap-2">
        {(["jobs", "reviews", "deliveries"] as const).map(item => <button key={item} className={inputClass + (kind === item ? " font-bold" : "")} aria-pressed={kind === item} onClick={() => changeKind(item)}>{item === "jobs" ? "Job History" : item === "reviews" ? "Review History" : "Delivery Log"}</button>)}
        <button className={inputClass} onClick={() => { setRefresh(x => x + 1); if (selected)
            void openJob(selected); }}>Refresh</button>
        <button className={inputClass} onClick={() => { detailFlight.current++; setAccess(""); setRows([]); setDetail(null); setError(""); }}>Lock history</button>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); setSearch(query); setCursor(null); setPrevious([]); }}>
        <input className={inputClass + " min-w-64 flex-1"} aria-label="Search history" placeholder="Repository, PR number, job, comment or delivery ID" maxLength={160} value={query} onChange={e => setQuery(e.target.value)}/>
        <select className={inputClass} aria-label="History job status" value={status} onChange={e => { setStatus(e.target.value); setCursor(null); setPrevious([]); }} disabled={kind === "deliveries"}>
          <option value="">All statuses</option>{["queued", "snapshot", "awaiting_chat", "validator", "posting", "posted", "skipped", "cancelled", "dlq"].map(s => <option key={s}>{s}</option>)}
        </select><button className={inputClass}>Search</button>
      </form>
      <p className="text-xs text-fg-muted">{loading ? "Loading history…" : `${total} matching records`} · Last successful read: {time(lastRead)}<br />{storage}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-line"><th className="p-2">Time</th><th className="p-2">Repository / PR</th><th className="p-2">Recorded state</th><th className="p-2">Request / correlation</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id} className="border-b border-line"><td className="p-2 whitespace-nowrap">{time(row.createdAt || row.at)}</td><td className="p-2">{row.owner}/{row.repo} #{row.pr}<div className="text-xs text-fg-subtle">{row.title || row.summary}</div></td><td className="p-2">{row.status || row.reason || "received"}{kind === "reviews" ? <div>{row.findingCount} findings</div> : null}</td><td className="p-2">
          {kind !== "deliveries" || row.jobId ? <button className="text-accent underline" onClick={() => void openJob(row.jobId || row.id)}>{row.jobId || row.id}</button> : <span>No review job created</span>}
          <div className="font-mono text-xs text-fg-subtle">Comment: {row.commentId || "—"}<br />Delivery: {row.deliveryId || "—"}</div></td></tr>)}
      </tbody></table></div>
      {!loading && !rows.length ? <p>No matching persisted history. Data lost before this version cannot be recreated.</p> : null}
      <div className="flex gap-3"><button className={inputClass} disabled={!previous.length} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(x => x.slice(0, -1)); }}>Previous</button><button className={inputClass} disabled={!next} onClick={() => { setPrevious(x => [...x, cursor]); setCursor(next); }}>Next</button></div>
    </>}
    {error ? <p role="alert" className="rounded border border-danger p-3 text-sm text-danger">{error} Previous rows, if shown, are not a fresh result.</p> : null}
    {detail && access ? <article className="rounded border border-line bg-bg-elevated p-4 space-y-4">
      <h2 className="text-lg font-semibold">Job timeline · {detail.job.id}</h2>
      <p className="text-sm">{detail.job.owner}/{detail.job.repo} #{detail.job.pr} · recorded state: <strong>{detail.job.status}</strong><br />{detail.inCurrentRuntime ? "Present in the current server runtime." : "Archived record; not present in the current server runtime. This is not proof it is still running."}</p>
      {detail.job.providerVersions ? <p className="text-xs text-fg-muted">Observed extension versions: {Object.entries(detail.job.providerVersions).map(([provider, version]) => `${provider} ${version}`).join(" · ")}</p> : null}
      <div className="flex flex-wrap gap-2"><button className={inputClass} onClick={() => void openJob(detail.job.id, true)}>Load original response / JSON</button><button className={inputClass} onClick={() => download(`${detail.job.id}-history.json`, detail)}>Export loaded history</button>
        {detail.review?.githubId ? <a className={inputClass} href={`https://github.com/${detail.job.owner}/${detail.job.repo}/pull/${detail.job.pr}#pullrequestreview-${detail.review.githubId}`} target="_blank" rel="noreferrer">Open posted review</a> : null}
      </div>
      {detail.review ? <details className="rounded border border-line p-3"><summary>Posted review · {detail.review.event} · {time(detail.review.at)}{detail.review.truncated ? " · TRUNCATED" : ""}</summary>
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{detail.review.body}</pre>
        {detail.review.comments?.map((comment, index) => <div className="mt-3" key={index}><p className="text-xs font-mono">{comment.file}:{comment.line}</p><pre className="whitespace-pre-wrap break-words text-xs">{comment.body}</pre></div>)}
      </details> : null}
      <RepairHistory repairs={detail.repairs || []} />
      {detail.droppedSteps > 0 ? <p>{detail.droppedSteps} older steps were removed by the per-job log bound.</p> : null}
      <ol className="space-y-3">{detail.steps.map(item => <li key={item.id} className="border-l-2 border-line pl-3"><div className="text-sm">{PROGRESS_LABELS[item.stage as keyof typeof PROGRESS_LABELS] || item.stage}</div><div className="font-mono text-xs text-fg-muted">Received: {time(item.at)} · {item.source} {item.provider || ""}{item.observedAt ? ` · observed: ${time(item.observedAt)}` : ""}<br />{item.runId ? `Run: ${item.runId} · ` : ""}{item.id}</div></li>)}</ol>
      {detail.observations ? Object.entries(detail.observations).map(([provider, observation]) => <details key={provider} className="rounded border border-line p-3"><summary>{provider} · observed but NOT parsed/completed · {time(observation.at)}{observation.truncated ? " · TRUNCATED" : ""}</summary>
        <p className="text-xs">Run {observation.runId} · {observation.totalChars} characters. This diagnostic snapshot is not submitted as a review.</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{observation.text}</pre>
      </details>) : null}
      {detail.responses ? Object.entries(detail.responses).map(([provider, response]) => <details key={provider} className="rounded border border-line p-3"><summary>{provider} · original {response.originalChars} chars · JSON {response.jsonChars} chars{response.truncated ? " · TRUNCATED" : ""}</summary>
        <h3 className="mt-3 text-sm font-semibold">Original rendered response</h3><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{response.original || "Original text was not supplied by this extension version. Extracted JSON is available below."}</pre>
        <h3 className="mt-3 text-sm font-semibold">Extracted review JSON</h3><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{response.json}</pre>
      </details>) : null}
    </article> : null}
  </section>;
}
