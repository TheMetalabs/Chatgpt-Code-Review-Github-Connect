import { createFileRoute } from "@tanstack/react-router";
import { getBridgePublic, bridgeTokenOk } from "@/lib/bridge.server";
import { buildChatPrompt } from "@/lib/chat-prompt";
import {
  cancelHarborJob,
  getHarbor,
  githubStatus,
  patchHarborSettings,
  previewChatPaste,
  publicJobs,
  publicSettings,
  resetHarbor,
  submitHarborChat,
} from "@/lib/harbor.server";
import { runLocalLlm } from "@/lib/local-llm.server";
import { SAMPLE_PRS } from "@/lib/samples";
import { clearGithubSecrets, patchGithubSecrets } from "@/lib/secrets.server";
import { normalizeReviewOrder } from "@/lib/types";
import type { ReviewProvider } from "@/lib/types";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/harbor")({
  server: {
    handlers: {
      GET: async () => {
        const harbor = getHarbor();
        return Response.json({
          jobs: publicJobs(harbor.jobs),
          events: harbor.events,
          reviews: harbor.reviews,
          settings: publicSettings(harbor.settings),
          github: githubStatus(),
          bridge: getBridgePublic(),
        });
      },
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          action?: string;
          jobId?: string;
          raw?: string;
          extra?: string;
          token?: string;
          reviewChatgpt?: boolean;
          reviewGrok?: boolean;
          reviewLocal?: boolean;
          localLlmBaseUrl?: string;
          localLlmApiKey?: string;
          localLlmModel?: string;
          reviewOrder?: ReviewProvider[];
          githubAppId?: string;
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
          const patch: Parameters<typeof patchHarborSettings>[0] = {};
          if (typeof body.reviewChatgpt === "boolean") patch.reviewChatgpt = body.reviewChatgpt;
          if (typeof body.reviewGrok === "boolean") patch.reviewGrok = body.reviewGrok;
          if (typeof body.reviewLocal === "boolean") patch.reviewLocal = body.reviewLocal;
          if (typeof body.localLlmBaseUrl === "string") patch.localLlmBaseUrl = body.localLlmBaseUrl.trim();
          if (typeof body.localLlmModel === "string") patch.localLlmModel = body.localLlmModel.trim();
          if (typeof body.localLlmApiKey === "string" && body.localLlmApiKey.trim()) {
            patch.localLlmApiKey = body.localLlmApiKey.trim();
          }
          if (Array.isArray(body.reviewOrder)) patch.reviewOrder = normalizeReviewOrder(body.reviewOrder);
          if (Object.keys(patch).length) patchHarborSettings(patch);
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
            githubWebhookSecret: typeof body.githubWebhookSecret === "string" ? body.githubWebhookSecret : undefined,
            githubPrivateKey: typeof body.githubPrivateKey === "string" ? body.githubPrivateKey : undefined,
          });
          if (!out.ok) return Response.json({ ok: false, error: out.error }, { status: 400 });
          return Response.json({ ok: true, github: githubStatus() });
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
