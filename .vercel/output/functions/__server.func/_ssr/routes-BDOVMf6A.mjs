import { i as __toESM } from "../_runtime.mjs";
import { i as shortSha, n as formatMs, r as formatWhen } from "./utils-CmXpGXpd.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { b as require_jsx_runtime, v as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { c as ArrowUpRight, i as Play } from "../_libs/lucide-react.mjs";
import { i as useAshlar } from "./router-Cie5IrZk.mjs";
import { t as Button } from "./button-B2EtUDbO.mjs";
import { t as Badge } from "./badge-DrZHdLLM.mjs";
import { t as Pipeline } from "./pipeline-CoLw-J1a.mjs";
import { n as StatusPill, t as MergePill } from "./status-pill-kphXt-cf.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-BDOVMf6A.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var TAPES = [
	{
		label: "Sync #412 (post)",
		sampleKey: "pay-412",
		trigger: "pull_request.synchronize"
	},
	{
		label: "Open #418 (no publish)",
		sampleKey: "pay-418",
		trigger: "pull_request.opened"
	},
	{
		label: "@ashlar on #412",
		sampleKey: "pay-412",
		trigger: "issue_comment.mention",
		mention: true
	},
	{
		label: "Fork #421",
		sampleKey: "pay-421",
		trigger: "pull_request.opened"
	},
	{
		label: "Draft #430 (skip)",
		sampleKey: "pay-430",
		trigger: "pull_request.opened"
	},
	{
		label: "HMAC fail",
		sampleKey: "pay-418",
		trigger: "pull_request.opened",
		hmacOk: false
	},
	{
		label: "Worker crash (DLQ)",
		sampleKey: "pay-418",
		trigger: "pull_request.reopened",
		forceDlq: true
	}
];
function Home() {
	const jobs = useAshlar((s) => s.jobs);
	const events = useAshlar((s) => s.events);
	const reviews = useAshlar((s) => s.reviews);
	const fire = useAshlar((s) => s.fire);
	const settings = useAshlar((s) => s.settings);
	const [lastFire, setLastFire] = (0, import_react.useState)(null);
	const [firing, setFiring] = (0, import_react.useState)(false);
	const liveJobs = jobs.filter((j) => [
		"queued",
		"snapshot",
		"explorer",
		"reviewer",
		"validator",
		"posting"
	].includes(j.status));
	const live = liveJobs[0];
	const posted = jobs.filter((j) => j.status === "posted" && j.postedReviewId).length;
	const skipped = jobs.filter((j) => j.status === "skipped").length;
	const rejected = events.filter((e) => e.httpStatus === 403).length;
	const p95 = percentile(jobs.map((j) => j.ingressMs).filter(Boolean), .95);
	async function runTape(t) {
		setFiring(true);
		try {
			const out = await fire({
				sampleKey: t.sampleKey,
				trigger: t.trigger,
				hmacOk: t.hmacOk,
				forceDlq: t.forceDlq,
				thread: t.mention ? {
					kind: "mention",
					commentId: 88,
					userText: "@ashlar-bot focus on fulfillOrder replay"
				} : void 0
			});
			setLastFire(out.httpStatus === 403 ? `403 · ${out.reject ?? "rejected"}` : out.skip ? `202 skip · ${out.skip}` : `202 queued · ${out.jobId}`);
		} finally {
			setFiring(false);
		}
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-6xl px-4 py-8 md:px-8 md:py-10",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-end justify-between gap-4",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
						children: "Operations"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
						className: "mt-2 text-3xl font-medium tracking-tight md:text-4xl",
						children: "Review harbor"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-2 max-w-xl text-sm leading-relaxed text-fg-muted",
						children: "Codex loop on the worker. Cody-style webhook that closes in milliseconds. Poster is a script — no model on the write path."
					})
				] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
					disabled: firing,
					onClick: () => runTape({
						label: "",
						sampleKey: "pay-412",
						trigger: "pull_request.synchronize"
					}),
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Play, {
						className: "size-4",
						strokeWidth: 1.6
					}), "Fire #412 sync"]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
				className: "mt-8 grid grid-cols-2 gap-3 md:grid-cols-5",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: "Ingress p95",
						value: p95 ? formatMs(p95) : "—",
						hint: "HMAC + 202"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: "Posted",
						value: String(posted),
						hint: "Reviews API only"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: "Skipped",
						value: String(skipped),
						hint: "fork / draft / poster"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: "Rejected",
						value: String(rejected),
						hint: "HMAC 403"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
						label: "Live reviews",
						value: String(reviews.filter((r) => !r.dismissed).length),
						hint: "head SHA unique"
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-10",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-sm font-medium text-fg-muted",
						children: "Live pipeline"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-3",
						"aria-busy": Boolean(live),
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pipeline, { status: live?.status })
					}),
					liveJobs.length > 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "mt-3 font-mono text-[12px] text-fg-muted",
						children: [liveJobs.length, " live · showing newest"]
					}) : null,
					live ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "mt-3 font-mono text-[12px] text-fg-muted",
						children: [
							live.owner,
							"/",
							live.repo,
							"#",
							live.pr,
							" · ",
							live.status,
							" · ",
							shortSha(live.headSha)
						]
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-3 text-sm text-fg-subtle",
						children: "Idle. Ingress is still accepting."
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-10",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-sm font-medium text-fg-muted",
						children: "Event tapes"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-3 flex flex-wrap gap-2",
						children: TAPES.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							variant: "secondary",
							size: "sm",
							disabled: firing,
							onClick: () => runTape(t),
							children: t.sampleKey === "pay-421" && !settings.skipForks ? "Fork #421 (injection)" : t.label
						}, t.label))
					}),
					lastFire ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-3 font-mono text-[12px] text-fg-muted",
						children: lastFire
					}) : null
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-10",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-baseline justify-between",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-sm font-medium text-fg-muted",
						children: "Recent ingress"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "font-mono text-[11px] text-fg-subtle",
						children: [events.length, " events"]
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-3 overflow-x-auto rounded-xl border border-line",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
						className: "w-full text-left text-sm",
						"aria-label": "Recent webhook events",
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
									className: "px-4 py-3 font-medium",
									children: "Summary"
								})
							] })
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: events.slice(0, 6).map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
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
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-10",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-baseline justify-between",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-sm font-medium text-fg-muted",
						children: "Jobs"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "font-mono text-[11px] tabular-nums text-fg-subtle",
						children: [jobs.length, " total"]
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-3 overflow-x-auto rounded-xl border border-line",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
						className: "w-full text-left text-sm",
						"aria-label": "Review jobs",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
							className: "bg-bg-elevated font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
									className: "px-4 py-3 font-medium",
									children: "PR"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
									className: "hidden px-4 py-3 font-medium md:table-cell",
									children: "Trigger"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
									className: "px-4 py-3 font-medium",
									children: "Status"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
									className: "hidden px-4 py-3 font-medium sm:table-cell",
									children: "Ingress"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { className: "px-4 py-3 font-medium" })
							] })
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: jobs.slice(0, 12).map((j) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(JobRow, { job: j }, j.id)) })]
					})
				})]
			})
		]
	});
}
function JobRow({ job: j }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
		className: "border-t border-line",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
				className: "px-4 py-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "font-medium",
					children: [
						j.owner,
						"/",
						j.repo,
						"#",
						j.pr
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "text-fg-subtle",
					children: j.title
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
				className: "hidden px-4 py-3 font-mono text-[12px] text-fg-muted md:table-cell",
				children: j.trigger
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
				className: "px-4 py-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatusPill, { status: j.status }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MergePill, { event: j.mergeRecommendation })]
				}), j.skipReason ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-1 text-[12px] text-fg-subtle",
					children: j.skipReason
				}) : null]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
				className: "hidden px-4 py-3 font-mono text-[12px] tabular-nums text-fg-muted sm:table-cell",
				children: [
					formatMs(j.ingressMs),
					" · ",
					formatWhen(j.createdAt)
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
				className: "px-4 py-3 text-right",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
					to: "/jobs/$id",
					params: { id: j.id },
					className: "inline-flex size-11 items-center justify-center text-fg-muted hover:text-fg",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowUpRight, { className: "size-4" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "sr-only",
						children: "Open job"
					})]
				})
			})
		]
	});
}
function Stat({ label, value, hint }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-xl border border-line bg-bg-elevated px-4 py-4",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
				className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
				children: label
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
				className: "mt-2 font-mono text-2xl tabular-nums tracking-tight",
				children: value
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
				className: "mt-1 text-[12px] text-fg-subtle",
				children: hint
			})
		]
	});
}
function percentile(values, p) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}
//#endregion
export { Home as component };
