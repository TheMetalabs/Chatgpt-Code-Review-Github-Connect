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
import { isMaskedSecret } from "@/lib/types";
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
          // Every supplied field goes RAW to the shared validator (settings-rules
          // validatedSettingsPatch, via patchHarborSettings) — the same rules the Settings screen
          // runs. Nothing is prefiltered, coerced, trimmed or dropped here: a supplied invalid value
          // (a non-object fixAgent, a wrong-typed flag, an out-of-range number, an unknown field)
          // is a 400 and changes nothing. A valid save applies in memory at once.
          const { action: _action, ...patch } = body as Record<string, unknown>;
          if (Object.keys(patch).length) {
            try {
              patchHarborSettings(patch as Parameters<typeof patchHarborSettings>[0]);
            } catch (e) {
              // SettingsError: 400 = rejected input, 500 = not persisted (nothing changed either way).
              const err = e as { message?: unknown; status?: unknown } | null;
              const msg = typeof err?.message === "string" && err.message ? err.message : "could not persist settings";
              const status = err?.status === 400 ? 400 : 500;
              return Response.json({ ok: false, error: msg }, { status });
            }
          }
          return Response.json({ ok: true, settings: publicSettings(getHarbor().settings), github: githubStatus(), bridge: getBridgePublic() });
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
