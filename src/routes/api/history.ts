import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";
import { getHarbor } from "@/lib/harbor.server";
import { reviewHistory } from "@/lib/review-history.server";
export const Route = createFileRoute("/api/history")({ server: { handlers: { GET: async ({ request }) => {
                const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
                const secret = process.env.ASHLAR_HISTORY_TOKEN || "";
                if (secret.length < 32)
                    return Response.json({ ok: false, error: "Configure ASHLAR_HISTORY_TOKEN (at least 32 characters) on the server." }, { status: 503, headers });
                const provided = request.headers.get("x-ashlar-history-token") || "";
                const valid = Boolean(provided) && timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(secret).digest());
                // Separate from the bridge token: its existing reveal endpoint is not archive authorization.
                // Header only: never accept credentials in URLs, logs, persisted UI state or exports.
                if (!valid)
                    return Response.json({ ok: false, error: "history access token required" }, { status: 401, headers });
                const query = new URL(request.url).searchParams, history = reviewHistory();
                try {
                    const id = query.get("jobId");
                    if (id) {
                        const record = history.getJob(id, query.get("responses") === "1");
                        if (!record)
                            return Response.json({ ok: false, error: "history record not found" }, { status: 404, headers });
                        return Response.json({ ok: true, record: { ...record, inCurrentRuntime: getHarbor().jobs.some(j => j.id === id) }, health: history.health() }, { headers });
                    }
                    const options = { q: query.get("q") || "", status: query.get("status") || "", cursor: query.get("cursor"), limit: Number(query.get("limit") || 25), reviewsOnly: query.get("kind") === "reviews" };
                    const result = query.get("kind") === "deliveries" ? history.listDeliveries(options) : history.listJobs(options);
                    return Response.json({ ok: true, ...result, health: history.health() }, { headers });
                }
                catch (error) {
                    return Response.json({ ok: false, error: error instanceof Error && error.message === "invalid_cursor" ? "invalid cursor" : "history storage unavailable", health: history.health() }, { status: error instanceof Error && error.message === "invalid_cursor" ? 400 : 503, headers });
                }
            } } } });
