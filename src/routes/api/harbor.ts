import {reviewHistory} from "@/lib/review-history.server";
import { createFileRoute } from "@tanstack/react-router";
import { getBridgePublic, bridgeTokenOk } from "@/lib/bridge.server";
import { buildChatPrompt } from "@/lib/chat-prompt";
import {
  cancelHarborJob,
  getHarbor,
  githubStatus,
  lastGithubInstallationId,
  patchHarborSettings,
  previewChatPaste,
  publicJobs,
  publicReviews,
  publicSettings,
  resetHarbor,
  submitHarborChat,
} from "@/lib/harbor.server";
import { runLocalLlm } from "@/lib/local-llm.server";
import { SAMPLE_PRS } from "@/lib/samples";
import { probeGithub } from "@/lib/github.server";
import { clearGithubSecrets, patchGithubSecrets } from "@/lib/secrets.server";
import { isMaskedSecret, normalizeReviewOrder } from "@/lib/types";
import type { ReviewProvider } from "@/lib/types";
import { normalizeChatgptReasoning, normalizeGrokReasoning } from "@/lib/reasoning";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function keepSecret(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (isMaskedSecret(v)) return undefined;
  return v;
}

export const Route = createFileRoute("/api/harbor")({
  server: {
    handlers: {
      GET: async () => {
        const harbor = getHarbor();
        return Response.json({
          jobs: publicJobs(harbor.jobs),
          events: harbor.events,
          reviews: publicReviews(harbor.reviews),
          settings: publicSettings(harbor.settings),
          github: githubStatus(),
          bridge: getBridgePublic(),
          history: reviewHistory().health(),
        }, {headers:{"Cache-Control":"no-store"}});
      },
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          action?: string;
          jobId?: string;
          raw?: string;
          extra?: string;
          token?: string;
          username?: string;
          mention?: string[];
          skipForks?: boolean;
          skipDrafts?: boolean;
          maxInlineComments?: number;
          maxTurns?: number;
          exploreTurns?: number;
          publishMinSeverity?: "P0" | "P1" | "P2";
          requestChangesMin?: "P0" | "P1" | "P2";
          precisionOverRecall?: boolean;
          webhookSecret?: string;
          reviewChatgpt?: boolean;
          reviewGrok?: boolean;
          reviewLocal?: boolean;
          localJsonRepairEnabled?: boolean;
          localReviewRole?: string;
          localLlmBaseUrl?: string;
          localLlmApiKey?: string;
          localLlmModel?: string;
          reviewOrder?: ReviewProvider[];
          chatgptReasoning?: string;
          grokReasoning?: string;
          githubAppId?: string;
          githubClientId?: string;
          githubWebhookSecret?: string;
          githubPrivateKey?: string;
          results?: { provider?: string; raw?: string }[];
        };
        const headerToken = request.headers.get("x-ashlar-bridge-token");
        if (body.action === "preview") {
          const out = previewChatPaste(String(body.raw ?? ""));
          if (!out.ok) {
            const message = "error" in out ? out.error : out.reason;
            return Response.json({ ok: false, error: message }, { status: 400 });
          }
          return Response.json({ ok: true, result: out });
        }
        if (body.action === "local") {
          const prompt = buildChatPrompt({ sample: SAMPLE_PRS["pay-412"], extra: String(body.extra ?? "") });
          const out = await runLocalLlm(prompt, getHarbor().settings);
          if (!out.ok) return Response.json({ ok: false, error: out.error }, { status: 400 });
          return Response.json({ ok: true, raw: out.raw });
        }
        if (body.action === "settings") {
          if (!sameOrigin(request)) {
            return Response.json({ ok: false, error: "bad origin" }, { status: 401 });
          }
          const patch: Parameters<typeof patchHarborSettings>[0] = {};
          if (typeof body.username === "string" && body.username.trim()) patch.username = body.username.trim();
          if (Array.isArray(body.mention)) {
            patch.mention = body.mention.map((m) => String(m).trim()).filter(Boolean);
          }
          if (typeof body.skipForks === "boolean") patch.skipForks = body.skipForks;
          if (typeof body.skipDrafts === "boolean") patch.skipDrafts = body.skipDrafts;
          if (typeof body.precisionOverRecall === "boolean") patch.precisionOverRecall = body.precisionOverRecall;
          if (typeof body.maxInlineComments === "number" && Number.isFinite(body.maxInlineComments)) {
            patch.maxInlineComments = Math.max(0, Math.min(20, Math.floor(body.maxInlineComments)));
          }
          if (typeof body.maxTurns === "number" && Number.isFinite(body.maxTurns)) patch.maxTurns = body.maxTurns;
          if (typeof body.exploreTurns === "number" && Number.isFinite(body.exploreTurns)) {
            patch.exploreTurns = body.exploreTurns;
          }
          if (body.publishMinSeverity === "P0" || body.publishMinSeverity === "P1" || body.publishMinSeverity === "P2") {
            patch.publishMinSeverity = body.publishMinSeverity;
          }
          if (body.requestChangesMin === "P0" || body.requestChangesMin === "P1" || body.requestChangesMin === "P2") {
            patch.requestChangesMin = body.requestChangesMin;
          }
          const webhookSecret = keepSecret(body.webhookSecret);
          if (webhookSecret) patch.webhookSecret = webhookSecret.trim();
          if (typeof body.reviewChatgpt === "boolean") patch.reviewChatgpt = body.reviewChatgpt;
          if (typeof body.reviewGrok === "boolean") patch.reviewGrok = body.reviewGrok;
          if (typeof body.reviewLocal === "boolean") patch.reviewLocal = body.reviewLocal;
          if (typeof body.localJsonRepairEnabled === "boolean") patch.localJsonRepairEnabled = body.localJsonRepairEnabled;
          if (body.localReviewRole === "race" || body.localReviewRole === "verify-clean") patch.localReviewRole = body.localReviewRole;
          if (typeof body.localLlmBaseUrl === "string") patch.localLlmBaseUrl = body.localLlmBaseUrl.trim();
          if (typeof body.localLlmModel === "string") patch.localLlmModel = body.localLlmModel.trim();
          const localKey = keepSecret(body.localLlmApiKey);
          if (localKey) patch.localLlmApiKey = localKey.trim();
          if (Array.isArray(body.reviewOrder)) patch.reviewOrder = normalizeReviewOrder(body.reviewOrder);
          if (typeof body.chatgptReasoning === "string") patch.chatgptReasoning = normalizeChatgptReasoning(body.chatgptReasoning);
          if (typeof body.grokReasoning === "string") patch.grokReasoning = normalizeGrokReasoning(body.grokReasoning);
          if (Object.keys(patch).length) {
            try {
              patchHarborSettings(patch);
            } catch (e) {
              const msg = e instanceof Error ? e.message : "could not persist settings";
              return Response.json({ ok: false, error: msg }, { status: msg.includes("reviewer") ? 400 : 500 });
            }
          }
          return Response.json({ ok: true, github: githubStatus(), bridge: getBridgePublic() });
        }
        if (body.action === "github" || body.action === "github-clear") {
          if (!sameOrigin(request)) {
            return Response.json({ ok: false, error: "bad origin" }, { status: 401 });
          }
          if (body.action === "github-clear") {
            clearGithubSecrets();
            return Response.json({ ok: true, github: githubStatus() });
          }
          const out = patchGithubSecrets({
            githubAppId: typeof body.githubAppId === "string" ? body.githubAppId : undefined,
            githubClientId: typeof body.githubClientId === "string" ? body.githubClientId : undefined,
            githubWebhookSecret: keepSecret(body.githubWebhookSecret),
            githubPrivateKey: keepSecret(body.githubPrivateKey),
          });
          if (!out.ok) return Response.json({ ok: false, error: out.error }, { status: 400 });
          return Response.json({ ok: true, github: githubStatus() });
        }
        if (body.action === "github-test") {
          if (!sameOrigin(request)) {
            return Response.json({ ok: false, error: "bad origin" }, { status: 401 });
          }
          const probe = await probeGithub(lastGithubInstallationId());
          return Response.json({ ok: probe.ok, probe, github: githubStatus() }, { status: probe.ok ? 200 : 400 });
        }
        if (body.action === "cancel" && body.jobId) {
          cancelHarborJob(body.jobId);
          return Response.json({ ok: true, github: githubStatus() });
        }
        if (body.action === "reset") {
          resetHarbor();
          return Response.json({ ok: true, github: githubStatus() });
        }
        if (body.action === "chat" && body.jobId) {
          if (!bridgeTokenOk(body.token || headerToken)) {
            return Response.json({ ok: false, error: "bad token" }, { status: 401 });
          }
          const legs = Array.isArray(body.results)
            ? body.results
                .filter((r) => r.provider === "chatgpt" || r.provider === "grok" || r.provider === "local")
                .map((r) => ({ provider: r.provider as ReviewProvider, raw: String(r.raw ?? "") }))
            : undefined;
          const out = await submitHarborChat(body.jobId, String(body.raw ?? ""), legs);
          if (!out.ok) return Response.json({ ok: false, error: out.error }, { status: 400 });
          return Response.json({ ok: true, github: githubStatus() });
        }
        return Response.json({ ok: false, reason: "unknown action" }, { status: 400 });
      },
    },
  },
});
