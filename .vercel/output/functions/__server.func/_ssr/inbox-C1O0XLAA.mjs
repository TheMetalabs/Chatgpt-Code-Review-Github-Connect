import { i as __toESM } from "../_runtime.mjs";
import { o as SAMPLE_PRS } from "./types-CqcBcVKJ.mjs";
import { n as formatMs, r as formatWhen } from "./utils-CmXpGXpd.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { i as useAshlar, r as signHub256 } from "./router-Cie5IrZk.mjs";
import { t as Button } from "./button-B2EtUDbO.mjs";
import { t as Badge } from "./badge-DrZHdLLM.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/inbox-C1O0XLAA.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function Inbox() {
	const events = useAshlar((s) => s.events);
	const settings = useAshlar((s) => s.settings);
	const fire = useAshlar((s) => s.fire);
	const [ping, setPing] = (0, import_react.useState)("");
	async function simulate(hmacOk) {
		const out = await fire({
			sampleKey: "pay-418",
			trigger: "pull_request.opened",
			hmacOk
		});
		setPing(out.httpStatus === 403 ? `403 · ${out.reject ?? "rejected"}` : out.skip ? `202 skip · ${out.skip}` : `202 queued · ${out.jobId}`);
	}
	async function pingLive() {
		const sample = SAMPLE_PRS["pay-418"];
		const body = JSON.stringify({
			action: "opened",
			pull_request: {
				number: sample.pr,
				draft: false,
				head: {
					sha: sample.headSha,
					repo: { fork: false }
				}
			},
			repository: { full_name: `${sample.owner}/${sample.repo}` }
		});
		const sig = await signHub256(settings.webhookSecret, body);
		const t0 = performance.now();
		const res = await fetch("/api/webhook", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-GitHub-Event": "ping",
				"X-GitHub-Delivery": crypto.randomUUID(),
				"X-Hub-Signature-256": sig
			},
			body
		});
		const ms = Math.round(performance.now() - t0);
		const json = await res.json();
		setPing(`${res.status} in ${formatMs(ms)}${json.pong ? " · pong" : json.reason ? ` · ${json.reason}` : json.verified ? " · verified" : ""}`);
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-6xl px-4 py-8 md:px-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
				children: "Inbox"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "mt-2 text-3xl font-medium tracking-tight",
				children: "Webhook ingress"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted",
				children: "HMAC, idempotency, fork/draft gates, then 202. Inference never runs in this process. Simulate a delivery on the worker, or ping the live verifier without enqueueing a job."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-6 flex flex-wrap gap-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						onClick: () => simulate(true),
						children: "Simulate delivery"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						variant: "secondary",
						onClick: () => simulate(false),
						children: "Simulate bad HMAC"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						onClick: pingLive,
						children: "Ping live /api/webhook"
					})
				]
			}),
			ping ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-3 font-mono text-[12px] text-fg-muted",
				children: ping
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "mt-8 overflow-x-auto rounded-xl border border-line",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
					className: "w-full text-left text-sm",
					"aria-label": "Webhook event log",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
						className: "bg-bg-elevated font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "px-4 py-3 font-medium",
								children: "Time"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "px-4 py-3 font-medium",
								children: "Status"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "hidden px-4 py-3 font-medium md:table-cell",
								children: "HMAC"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "px-4 py-3 font-medium",
								children: "Summary"
							})
						] })
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: events.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
						className: "px-4 py-6 text-sm text-fg-subtle",
						colSpan: 4,
						children: "No deliveries yet."
					}) }) : events.map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
						className: "border-t border-line",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
								className: "px-4 py-3 font-mono text-[12px] tabular-nums text-fg-muted",
								children: formatWhen(e.at)
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
								className: "px-4 py-3",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: e.httpStatus === 202 ? "ok" : "danger",
									children: e.httpStatus
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
								className: "hidden px-4 py-3 md:table-cell",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: e.hmac === "ok" ? "ok" : "danger",
									children: e.hmac
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
								className: "px-4 py-3",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: e.summary }),
									e.skipReason ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "text-[12px] text-fg-subtle",
										children: e.skipReason
									}) : null,
									e.rejectReason ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "text-[12px] text-danger",
										children: e.rejectReason
									}) : null
								]
							})
						]
					}, e.id)) })]
				})
			})
		]
	});
}
//#endregion
export { Inbox as component };
