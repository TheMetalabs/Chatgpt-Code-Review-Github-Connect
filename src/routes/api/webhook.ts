import { createFileRoute } from "@tanstack/react-router";
import { verifyHub256 } from "@/lib/hmac";
import { readBodyCapped } from "@/lib/http-body";
import { ingestGitHubWebhook } from "@/lib/harbor.server";
import { githubWebhookSecret } from "@/lib/github.server";

export const Route = createFileRoute("/api/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const t0 = performance.now();
        const secret = githubWebhookSecret();
        if (!secret) {
          return Response.json({ accepted: false, reason: "webhook secret unset" }, { status: 503 });
        }
        const read = await readBodyCapped(request);
        if (!read.ok) {
          return Response.json({ accepted: false, reason: read.reason }, { status: 413 });
        }
        const body = read.body;
        const sig = request.headers.get("x-hub-signature-256");
        const event = request.headers.get("x-github-event") ?? "";
        const delivery = request.headers.get("x-github-delivery") ?? "";
        const ok = await verifyHub256(secret, body, sig);
        const ingressMs = Math.round(performance.now() - t0);

        if (!ok) {
          const result = ingestGitHubWebhook({
            hmacOk: false,
            deliveryId: delivery || "missing",
            event: event || "unknown",
            payload: {},
          });
          return Response.json(
            { accepted: false, reason: "HMAC mismatch", ingressMs, delivery, event, reject: result.reject },
            { status: 403 },
          );
        }

        if (!event || !delivery) {
          return Response.json(
            { accepted: false, reason: "missing X-GitHub-Event or X-GitHub-Delivery", ingressMs },
            { status: 400 },
          );
        }

        let payload: unknown = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          return Response.json({ accepted: false, reason: "malformed json" }, { status: 400 });
        }

        const result = ingestGitHubWebhook({
          hmacOk: true,
          deliveryId: delivery,
          event,
          payload,
        });

        return Response.json(
          {
            accepted: result.httpStatus === 202,
            verified: ok,
            queued: Boolean(result.queued),
            jobId: result.jobId,
            skip: result.skip,
            pong: result.pong,
            reject: result.reject,
            ingressMs,
            delivery,
            event,
          },
          { status: result.httpStatus },
        );
      },
    },
  },
});
