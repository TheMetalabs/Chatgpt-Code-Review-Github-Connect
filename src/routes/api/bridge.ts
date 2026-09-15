import { createFileRoute } from "@tanstack/react-router";
import {
  bridgeHeartbeat,
  bridgeTokenOk,
  claimBridgeJob,
  completeBridgeJob,
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
          token?: string;
          jobId?: string;
          raw?: string;
          results?: { provider?: string; raw?: string }[];
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
            refreshBridgeClaim(body.jobId, generating);
          }
          return Response.json({ ok: true, bridge: getBridgePublic() }, { headers });
        }
        if (body.action === "take") {
          return Response.json({ ok: true, bridge: getBridgePublic(), job: takeNextBridgeJob() }, { headers });
        }
        if (body.action === "claim" && body.jobId) {
          const out = claimBridgeJob(body.jobId);
          if (!out.ok) return Response.json(out, { status: 409, headers });
          return Response.json({ ok: true }, { headers });
        }
        if (body.action === "release" && body.jobId) {
          releaseBridgeJob(body.jobId);
          return Response.json({ ok: true }, { headers });
        }
        if (body.action === "complete" && body.jobId) {
          const legs = Array.isArray(body.results)
            ? body.results
                .filter((r) => r.provider === "chatgpt" || r.provider === "grok")
                .map((r) => ({ provider: r.provider as "chatgpt" | "grok", raw: String(r.raw ?? "") }))
            : undefined;
          const out = await completeBridgeJob(body.jobId, String(body.raw ?? ""), legs);
          if (!out.ok) return Response.json(out, { status: 400, headers });
          return Response.json({ ok: true }, { headers });
        }
        return Response.json({ ok: false, error: "unknown action" }, { status: 400, headers });
      },
    },
  },
});
