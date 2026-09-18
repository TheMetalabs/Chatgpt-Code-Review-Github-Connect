import type {RepairRecord} from "@/lib/json-repair-types";
export type RepairHistoryRow = Omit<RepairRecord,"original"> & {original?:string};
const labels: Record<RepairRecord["status"],string> = {
  running:"Local formatting queued or running",
  ready:"Candidate validated; awaiting original-page recheck",
  accepted:"Applied to the original reviewer result",
  disabled:"Disabled; no uncommitted candidate applied",
  superseded:"Superseded by a newer source, native result or cancellation",
  interrupted:"Inference outcome unknown after restart; not automatically repeated",
  needs_attention:"Validation or transport failed; original retained",
};
export function RepairHistory({repairs}:{repairs:RepairHistoryRow[]}) {
  if(!repairs.length)return null;
  return <section aria-label="Local JSON repair history" className="space-y-3">
    <h3 className="text-sm font-semibold">Local JSON repair</h3>
    <p className="text-xs text-fg-muted">Formatting only, not an additional Local reviewer vote. The original is never replaced.
      Queue/generation duration is not limited. An uncertain or rejected attempt is not automatically repeated.</p>
    {repairs.map(repair=><details key={repair.id} className="rounded border border-line p-3">
      <summary className="text-sm">{repair.provider} · {labels[repair.status] || repair.status}</summary>
      <p className="mt-2 font-mono text-xs break-all">Model: {repair.model} · attempts: {repair.attempts}<br/>
        Schema: {repair.schema} / {repair.schemaVersion} · run: {repair.runId}<br/>
        Response: {repair.responseId}<br/>Source SHA-256: {repair.sourceHash}<br/>
        Started: {new Date(repair.createdAt).toLocaleString()} · updated: {new Date(repair.updatedAt).toLocaleString()}</p>
      {repair.errors.length ? <p className="mt-2 text-xs text-danger">{repair.errors.join(" · ")}</p> : null}
      {repair.original === undefined ? <p className="mt-2 text-xs text-fg-muted">Use “Load original response / JSON” to inspect the private original and candidate.</p> :
        <><h4 className="mt-3 text-sm font-medium">Immutable original response</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{repair.original}</pre></>}
      {repair.candidate !== undefined ? <><h4 className="mt-3 text-sm font-medium">Local formatting candidate</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{repair.candidate}</pre></> : null}
      {repair.raw !== undefined ? <><h4 className="mt-3 text-sm font-medium">Validated JSON candidate{repair.status === "accepted" ? " · committed" : " · not yet committed"}</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{repair.raw}</pre></> : null}
    </details>)}
  </section>;
}
