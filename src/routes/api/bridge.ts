import { createFileRoute } from "@tanstack/react-router";
import type { ProviderError } from "@/lib/types";
import {
  recordBridgeProgress,
  recordBridgeObservation,
  bridgeHeartbeat,
  bridgeJobState,
  bridgeTokenOk,
  claimBridgeJob,
  completeBridgeJob,
  failBridgeProvider,
  getBridgePublic,
  getBridgeStatus,
  promptForJob,
  refreshBridgeClaim,
  releaseBridgeJob,
  rotateBridgeToken,
  takeNextBridgeJob,
} from "@/lib/bridge.server";

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const allow = origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "content-type, x-ashlar-bridge-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function tokenFrom(request: Request, bodyToken?: string) {
  return bodyToken || request.headers.get("x-ashlar-bridge-token") || "";
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/bridge")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => new Response(null, { status: 204, headers: corsHeaders(request) }),
      GET: async ({ request }) => {
        const headers = corsHeaders(request);
        if (!bridgeTokenOk(tokenFrom(request))) {
          return Response.json({ ok: false, error: "bad token" }, { status: 401, headers });
        }
        bridgeHeartbeat();
        const jobId = new URL(request.url).searchParams.get("jobId");
        if (jobId) {
          const prompt = promptForJob(jobId);
          if (!prompt) return Response.json({ ok: false, error: "no prompt" }, { status: 404, headers });
          return Response.json({ ok: true, ...prompt }, { headers });
        }
        return Response.json({ ok: true, bridge: getBridgePublic(), job: null }, { headers });
      },
      POST: async ({ request }) => {
        const headers = corsHeaders(request);
        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          clientId?: string;
          leaseId?: string;
          excludeJobIds?: string[];
          progress?: unknown;
          runId?: string; text?: string; totalChars?: number; truncated?: boolean;
          providerErrors?: Record<string, {code?: string; message?: string}>;
          token?: string;
          jobId?: string;
          raw?: string;
          provider?: string;
          error?: string;
          results?: { provider?: string; raw?: string; originalText?: string }[];
          generating?: Partial<Record<"chatgpt" | "grok" | "local", boolean>>;
        };
        if (body.action === "reveal") {
          if (!sameOrigin(request)) {
            return Response.json({ ok: false, error: "bad origin" }, { status: 401, headers });
          }
          return Response.json({ ok: true, token: getBridgeStatus().token, bridge: getBridgePublic() }, { headers });
        }
        if (!bridgeTokenOk(tokenFrom(request, body.token))) {
          return Response.json({ ok: false, error: "bad token" }, { status: 401, headers });
        }
        bridgeHeartbeat();
        if (body.action === "rotate") {
          return Response.json({ ok: true, token: rotateBridgeToken().token, bridge: getBridgePublic() }, { headers });
        }
        if (body.action === "observe" && body.jobId) {
          if(typeof body.text!=="string" || body.text.length>128_000 || typeof body.runId!=="string" || body.runId.length>128)
            return Response.json({ok:false,error:"invalid observation"},{status:400,headers});
          try {
            const accepted=recordBridgeObservation(body.jobId,body.leaseId,String(body.provider||""),body.runId,
              body.text,Number.isSafeInteger(body.totalChars) && Number(body.totalChars)>=body.text.length ? Number(body.totalChars) : body.text.length,Boolean(body.truncated));
            return Response.json({ok:accepted},{status:accepted?200:409,headers});
          } catch {return Response.json({ok:false,error:"history storage unavailable"},{status:503,headers});}
        }
        if (body.action === "progress" && body.jobId) {
          try {const accepted=recordBridgeProgress(body.jobId,body.leaseId,body.progress);
            return Response.json({ok:accepted},{status:accepted?200:409,headers});
          } catch {return Response.json({ok:false,error:"history storage unavailable"},{status:503,headers});}
        }
        if (body.action === "ping") {
          if (body.jobId) {
            const rawGen = body.generating;
            const generating =
              rawGen && typeof rawGen === "object" && !Array.isArray(rawGen)
                ? Object.fromEntries(
                    (["chatgpt", "grok", "local"] as const)
                      .filter((p) => typeof rawGen[p] === "boolean")
                      .map((p) => [p, rawGen[p]]),
                  )
                : undefined;
            const errors: Partial<Record<"chatgpt" | "grok", ProviderError>> = {};
            for (const provider of ["chatgpt", "grok"] as const) {
              const error = body.providerErrors?.[provider];
              if (error && ["quota", "empty", "error", "tab_closed", "cancelled", "disconnected"].includes(error.code ?? "")) {
                errors[provider] = {code: error.code as ProviderError["code"], message: String(error.message ?? "").slice(0, 240)};
              }
            }
            const accepted = refreshBridgeClaim(body.jobId, generating, errors, body.leaseId);
            let progressAccepted=false;
            if(accepted && body.progress)try {progressAccepted=recordBridgeProgress(body.jobId,body.leaseId,body.progress);}catch{ /* heartbeat remains separate from telemetry storage */ }
            return Response.json({ok: true, accepted, progressAccepted, ...bridgeJobState(body.jobId), bridge: getBridgePublic()}, {headers});
          }
          return Response.json({ ok: true, bridge: getBridgePublic() }, { headers });
        }
        if (body.action === "take") {
          return Response.json({ ok: true, bridge: getBridgePublic(), job: takeNextBridgeJob(String(body.clientId ?? ""), Array.isArray(body.excludeJobIds) ? body.excludeJobIds.filter(id => typeof id === "string") : []) }, { headers });
        }
        if (body.action === "claim" && body.jobId) {
          const out = claimBridgeJob(body.jobId, String(body.clientId ?? ""));
          if (!out.ok) return Response.json(out, { status: 409, headers });
          return Response.json(out, { headers });
        }
        if (body.action === "release" && body.jobId) {
          releaseBridgeJob(body.jobId, body.leaseId);
          return Response.json({ ok: true }, { headers });
        }
        if (body.action === "failure" && body.jobId) {
          if (body.provider !== "chatgpt" && body.provider !== "grok") {
            return Response.json({ ok: false, error: "invalid chat provider" }, { status: 400, headers });
          }
          const accepted = failBridgeProvider(body.jobId, body.provider, String(body.error || "chat review failed"), body.leaseId);
          return Response.json({ ok: accepted }, { status: accepted ? 200 : 409, headers });
        }
        if (body.action === "complete" && body.jobId) {
          const legs = Array.isArray(body.results)
            ? body.results
                .filter((r) => r.provider === "chatgpt" || r.provider === "grok")
                .map((r) => ({ provider: r.provider as "chatgpt" | "grok", raw: String(r.raw ?? ""), originalText: typeof r.originalText === "string" ? r.originalText : undefined }))
            : undefined;
          const out = await completeBridgeJob(body.jobId, String(body.raw ?? ""), legs, body.leaseId);
          if (!out.ok) return Response.json(out, { status: "code" in out && out.code === "history_unavailable" ? 503 : "code" in out && out.code === "lease_conflict" ? 409 : 400, headers });
          return Response.json({ ok: true }, { headers });
        }
        return Response.json({ ok: false, error: "unknown action" }, { status: 400, headers });
      },
    },
  },
});
