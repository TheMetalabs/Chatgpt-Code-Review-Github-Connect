import { createFileRoute } from "@tanstack/react-router";
import { verifyHub256 } from "@/lib/hmac";
import { MAX_WEBHOOK_BODY, readBodyCapped } from "@/lib/http-body";
import { ingestGitHubWebhook, recordOversizedWebhook } from "@/lib/harbor.server";
import { compactWebhookPayload } from "@/lib/webhook-compact";
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
          // Over the hard cap: the signature cannot be checked without the whole body, so the
          // delivery is refused — but recorded and logged, never dropped silently.
          const targetType = request.headers.get("x-github-hook-installation-target-type");
          const targetId = request.headers.get("x-github-hook-installation-target-id");
          const ev = recordOversizedWebhook({
            deliveryId: request.headers.get("x-github-delivery") ?? "",
            event: request.headers.get("x-github-event") ?? "",
            bytes: read.bytes,
            max: MAX_WEBHOOK_BODY,
            target: targetType && targetId ? `${targetType} ${targetId}` : undefined,
          });
          return Response.json(
            { accepted: false, reason: read.reason, bytes: read.bytes, max: MAX_WEBHOOK_BODY, delivery: ev.deliveryId, event: ev.event },
            { status: 413 },
          );
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

        let parsedBody: unknown = {};
        try {
          parsedBody = body ? JSON.parse(body) : {};
        } catch {
          return Response.json({ accepted: false, reason: "malformed json" }, { status: 400 });
        }
        // Only after the HMAC check on the exact raw body: bound free text (a huge PR description
        // embedded in every comment event) before anything is parsed, stored or prompted.
        const { payload, truncated } = compactWebhookPayload(event, parsedBody);

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
            ...(truncated.length ? { truncated } : {}),
          },
          { status: result.httpStatus },
        );
      },
    },
  },
});
