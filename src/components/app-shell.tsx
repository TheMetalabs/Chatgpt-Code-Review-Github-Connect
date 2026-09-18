import {workerStatusLabel} from "@/lib/bridge-worker-status";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  Activity,
  BookOpen,
  Inbox,
  MessageSquareCode,
  Settings2,
  SquareDashedMousePointer,
} from "lucide-react";
import { Mark } from "@/components/mark";
import { cn } from "@/lib/utils";
import { useAshlar } from "@/lib/store";
import { validRemoteSnapshot } from "@/lib/remote-snapshot";
import { LIVE_INFLIGHT_STATUSES } from "@/lib/types";
import type { ReactNode } from "react";

const NAV = [
  { to: "/", label: "Operations", icon: Activity },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/history", label: "Job History", icon: BookOpen },
  { to: "/reviews", label: "Reviews", icon: MessageSquareCode },
  { to: "/policies", label: "Policies", icon: BookOpen },
  { to: "/playground", label: "Playground", icon: SquareDashedMousePointer },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queued = useAshlar(
    (s) => s.jobs.filter((j) => LIVE_INFLIGHT_STATUSES.includes(j.status)).length,
  );
  const lastReject = useAshlar((s) => s.events.find((e) => e.httpStatus === 403));
  const hmacHot = Boolean(lastReject && Date.now() - lastReject.at < 60_000);
  const github = useAshlar((s) => s.github);
  const bridge = useAshlar((s) => s.bridge);
  const mergeRemote = useAshlar((s) => s.mergeRemote);
  const sync = useAshlar(s => s.sync);
  const historyHealth = useAshlar(s => s.historyHealth);
  const markSyncError = useAshlar(s => s.markSyncError);
  const appReady = (github.appId || github.clientId) && github.privateKey && github.webhookSecret;

  useEffect(() => {
    let timer = 0;
    let alive = true;
    const controller = new AbortController();
    async function tick() {
      try {
        const res = await fetch("/api/harbor", {cache: "no-store", signal: controller.signal});
        if (!res.ok) throw new Error(`Operations API returned HTTP ${res.status}.`);
        const json: unknown = await res.json();
        if (!validRemoteSnapshot(json)) throw new Error("Operations API returned an invalid snapshot.");
        if (alive) mergeRemote(json);
      } catch (error) {
        if (alive) markSyncError(error instanceof Error ? error.message : "Operations data could not be read.");
      }
      if (alive) timer = window.setTimeout(tick, 1200);
    }
    void tick();
    return () => {
      alive = false;
      controller.abort(); // Stop only this UI read, not an in-flight review.
      window.clearTimeout(timer);
    };
  }, [mergeRemote, markSyncError]);

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-bg-elevated md:flex">
          <Link to="/" className="flex items-center gap-2.5 px-5 py-6 text-fg">
            <Mark className="text-accent" />
            <div>
              <div className="text-[15px] font-semibold tracking-tight">Ashlar</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">review harness</div>
            </div>
          </Link>
          <nav className="flex flex-1 flex-col gap-0.5 px-3">
            {NAV.map((item) => {
              const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150",
                    active ? "bg-bg-hover text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
                  )}
                >
                  <Icon className="size-4" strokeWidth={1.6} />
                  <span className="flex-1">{item.label}</span>
                  {item.to === "/" && queued > 0 ? (
                    <span className="font-mono text-[11px] tabular-nums text-accent">{queued}</span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-line px-5 py-4">
            <div className="flex items-center gap-2 text-[11px] text-fg-subtle">
              <span className={cn("size-1.5 rounded-full", hmacHot ? "bg-danger" : "bg-ok")} />
              {hmacHot ? "HMAC rejected" : sync.status === "live" ? "Operations API connected" : "Operations data not current"}
            </div>
            <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-fg-muted">
              <span className={cn("size-1.5 rounded-full", appReady ? "bg-ok" : "bg-fg-subtle")} />
              {appReady ? "GitHub App ready" : "GitHub App env unset"}
            </div>
            <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-fg-muted">
              <span className={cn("size-1.5 rounded-full", bridge.connected ? "bg-ok" : "bg-fg-subtle")} />
              {bridge.connected ? "Chat heartbeat connected" : "Chat heartbeat disconnected"}
            </div>
            <p className="mt-1 text-xs text-fg-muted" aria-live="polite">
              {workerStatusLabel(bridge.workerStatus, Boolean(bridge.connected && bridge.workerStatusFresh))}
              {bridge.workerStatus ? ` · extension ${bridge.workerStatus.extensionVersion} · source backlog ${bridge.workerStatus.sourceCaptured} · cleanup ${bridge.workerStatus.pendingCleanup}` : ""}
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur md:hidden">
            <Mark className="size-6 text-accent" />
            <div className="text-sm font-semibold">Ashlar</div>
            <Link
              to="/settings"
              className="ml-auto inline-flex size-11 items-center justify-center text-fg-muted"
            >
              <Settings2 className="size-4" strokeWidth={1.6} />
              <span className="sr-only">Settings</span>
            </Link>
          </header>
          <div className="border-b border-line px-4 py-2 text-xs text-fg-muted" role={sync.status === "error" ? "alert" : "status"}>
            {sync.status === "loading" ? "Loading operational data — no sample reviews are shown." : sync.status === "error" ?
              `Live data unavailable: ${sync.error} Previously loaded rows may be stale.` : "Live operational data loaded."}
            {sync.lastSuccessAt ? ` Last successful refresh: ${new Date(sync.lastSuccessAt).toLocaleTimeString()}.` : ""}
              <p aria-label="Browser worker status">{bridge.connected ? "Chrome heartbeat connected. " : "Chrome heartbeat disconnected. "}
                {workerStatusLabel(bridge.workerStatus, Boolean(bridge.connected && bridge.workerStatusFresh))}
                {bridge.workerStatus ? ` · source backlog ${bridge.workerStatus.sourceCaptured} · cleanup ${bridge.workerStatus.pendingCleanup} · extension ${bridge.workerStatus.extensionVersion}` : ""}
              </p>
            {historyHealth && !historyHealth.ok ? <p className="text-danger">History storage unavailable: {historyHealth.error}. Results are not acknowledged until their archive is saved.</p> : null}
          </div>
          <main id="main" className="flex-1 pb-20 md:pb-0">
            {children}
          </main>
          <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t border-line bg-bg-elevated md:hidden">
            {NAV.filter((n) => n.to !== "/settings").map((item) => {
              const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-1 text-[10px]",
                    active ? "text-fg" : "text-fg-subtle",
                  )}
                >
                  <Icon className="size-4" strokeWidth={1.6} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}
