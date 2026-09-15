import { a as LIVE_INFLIGHT_STATUSES, o as SAMPLE_PRS } from "./types-CqcBcVKJ.mjs";
import { i as shortSha, n as formatMs } from "./utils-CmXpGXpd.mjs";
import { b as require_jsx_runtime, v as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { i as useAshlar, n as Route } from "./router-Cie5IrZk.mjs";
import { t as Button } from "./button-B2EtUDbO.mjs";
import { n as PAYMENT_AGENTS_MD, r as ROOT_AGENTS_MD, t as CODE_REVIEW_MD } from "./policy-CvHpVqoK.mjs";
import { t as Pipeline } from "./pipeline-CoLw-J1a.mjs";
import { n as StatusPill, t as MergePill } from "./status-pill-kphXt-cf.mjs";
import { t as DiffView } from "./diff-view-BbmG-HGA.mjs";
import { t as FindingCard } from "./finding-card-_pDoxAyN.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/jobs._id-D9_3ENtn.js
var import_jsx_runtime = require_jsx_runtime();
function JobPage() {
	const { id } = Route.useParams();
	const job = useAshlar((s) => s.jobs.find((j) => j.id === id));
	const review = useAshlar((s) => s.reviews.find((r) => r.jobId === id));
	const fire = useAshlar((s) => s.fire);
	const cancel = useAshlar((s) => s.cancel);
	const resetDemo = useAshlar((s) => s.resetDemo);
	if (!job) return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-lg px-6 py-16 text-center text-fg-muted",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "This id is not in the current demo tape. Fired jobs live in this tab until Reset." }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-4 flex justify-center gap-2",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
				asChild: true,
				variant: "secondary",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
					to: "/",
					children: "Back to Operations"
				})
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
				variant: "ghost",
				onClick: resetDemo,
				children: "Reset demo tape"
			})]
		})]
	});
	const files = (SAMPLE_PRS[job.sampleKey ?? ""]?.files ?? []).map((f) => {
		if (f.path === "AGENTS.md") return {
			...f,
			content: ROOT_AGENTS_MD
		};
		if (f.path === "code_review.md") return {
			...f,
			content: CODE_REVIEW_MD
		};
		if (f.path === "src/payment/AGENTS.md") return {
			...f,
			content: PAYMENT_AGENTS_MD
		};
		return f;
	});
	const primary = files.find((f) => f.path === job.findings[0]?.file) ?? files.find((f) => f.path.endsWith(".ts"));
	const live = LIVE_INFLIGHT_STATUSES.includes(job.status);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-6xl px-4 py-8 md:px-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
				children: ["Job ", job.id]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-2 flex flex-wrap items-end justify-between gap-4",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h1", {
					className: "text-3xl font-medium tracking-tight",
					children: [
						job.owner,
						"/",
						job.repo,
						"#",
						job.pr
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-1 text-sm text-fg-muted",
					children: job.title
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center gap-2",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatusPill, { status: job.status }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MergePill, { event: job.mergeRecommendation }),
						live ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							variant: "secondary",
							size: "sm",
							onClick: () => cancel(job.id),
							children: "Cancel"
						}) : job.sampleKey ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							variant: "secondary",
							size: "sm",
							onClick: () => fire({
								sampleKey: job.sampleKey,
								trigger: job.trigger,
								thread: job.thread
							}),
							children: "Replay"
						}) : null
					]
				})]
			}),
			job.status === "cancelled" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-4 rounded-xl border border-warn/30 bg-bg-elevated px-4 py-3 text-sm text-warn",
				children: ["Cancelled — ", job.skipReason ?? "newer delivery for the same PR took the worker."]
			}) : null,
			job.status === "dlq" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-4 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-sm text-danger",
				children: [
					"Dead letter. ",
					job.skipReason ?? "Validator failed.",
					" Replay to put it back on the worker."
				]
			}) : null,
			job.status === "skipped" && job.skipReason ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-4 rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm text-fg-muted",
				children: job.skipReason
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
				className: "mt-6 grid grid-cols-2 gap-3 md:grid-cols-4",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						k: "head",
						v: shortSha(job.headSha)
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						k: "trigger",
						v: job.trigger
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						k: "ingress",
						v: formatMs(job.ingressMs)
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						k: "sender",
						v: job.sender
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "mt-8",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pipeline, { status: job.status })
			}),
			job.thread ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-6 rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Mention extra"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-1 text-fg",
						children: job.thread.userText
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-1 text-fg-subtle",
						children: "Prior findings + this line only. Full chat log is not re-injected."
					})
				]
			}) : null,
			job.plan ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-8",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-sm font-medium text-fg-muted",
					children: "Explorer plan"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 max-w-2xl text-sm leading-relaxed text-fg",
					children: job.plan
				})]
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-8",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-sm font-medium text-fg-muted",
					children: "Tool loop"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
					className: "mt-3 overflow-hidden rounded-xl border border-line",
					children: job.traces.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", {
						className: "px-4 py-6 text-sm text-fg-subtle",
						children: live ? "Waiting on the worker." : "No tool calls — ingress skipped the worker."
					}) : job.traces.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "grid gap-1 border-t border-line px-4 py-3 first:border-t-0 md:grid-cols-[7rem_9rem_1fr_1fr]",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "font-mono text-[11px] uppercase tracking-[0.12em] text-fg-subtle",
								children: t.pass
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "font-mono text-[12px] text-accent",
								children: t.tool
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "font-mono text-[12px] text-fg-muted",
								children: t.args
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "text-[12px] text-fg-muted",
								children: t.result
							})
						]
					}, t.id))
				})]
			}),
			job.investigatedSafe.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-8",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-sm font-medium text-fg-muted",
					children: "Investigated safe"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
					className: "mt-2 list-disc pl-5 text-sm text-fg-muted",
					children: job.investigatedSafe.map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: x }, x))
				})]
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-8",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-sm font-medium text-fg-muted",
					children: "Findings"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-3 grid gap-3 lg:grid-cols-2",
					children: [[...job.findings, ...job.candidates.filter((c) => c.status === "dropped")].map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FindingCard, { finding: f }, f.id)), job.findings.length === 0 && job.candidates.length === 0 && (job.status === "posted" || job.status === "skipped") ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "text-sm text-fg-muted",
						children: "No concrete failure. Poster skipped the review."
					}) : null]
				})]
			}),
			primary ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mt-8",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", {
					className: "text-sm font-medium text-fg-muted",
					children: ["Head snapshot · ", primary.path]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-3",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DiffView, {
						path: primary.path,
						content: primary.content,
						findings: job.findings,
						caption: "Head snapshot. Highlight = accepted finding line."
					})
				})]
			}) : null,
			review ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-8 text-sm text-fg-muted",
				children: [
					"Posted as ",
					review.event,
					". See the",
					" ",
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/reviews",
						className: "text-fg underline",
						children: "review thread"
					}),
					"."
				]
			}) : null
		]
	});
}
function Meta({ k, v }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-lg border border-line px-3 py-3",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
			children: k
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "mt-1 font-mono text-[13px]",
			children: v
		})]
	});
}
//#endregion
export { JobPage as component };
