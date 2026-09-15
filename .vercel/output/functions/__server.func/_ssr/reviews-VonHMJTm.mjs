import { i as __toESM } from "../_runtime.mjs";
import { o as SAMPLE_PRS } from "./types-CqcBcVKJ.mjs";
import { i as shortSha, r as formatWhen } from "./utils-CmXpGXpd.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { i as useAshlar } from "./router-Cie5IrZk.mjs";
import { t as Button } from "./button-B2EtUDbO.mjs";
import { t as Badge } from "./badge-DrZHdLLM.mjs";
import { n as PAYMENT_AGENTS_MD, r as ROOT_AGENTS_MD, t as CODE_REVIEW_MD } from "./policy-CvHpVqoK.mjs";
import { t as MergePill } from "./status-pill-kphXt-cf.mjs";
import { t as DiffView } from "./diff-view-BbmG-HGA.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/reviews-VonHMJTm.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function Reviews() {
	const reviews = useAshlar((s) => s.reviews);
	const jobs = useAshlar((s) => s.jobs);
	const fire = useAshlar((s) => s.fire);
	const [mention, setMention] = (0, import_react.useState)("@ashlar-bot focus on fulfillOrder replay");
	const [selectedId, setSelectedId] = (0, import_react.useState)(null);
	const [lastFire, setLastFire] = (0, import_react.useState)(null);
	const fallback = reviews.find((r) => !r.dismissed) ?? reviews[0];
	const active = reviews.find((r) => r.id === selectedId) ?? fallback;
	const job = jobs.find((j) => j.id === active?.jobId);
	const sample = SAMPLE_PRS[job?.sampleKey ?? "pay-412"];
	const file = (0, import_react.useMemo)(() => {
		if (!sample) return null;
		const path = active?.comments[0]?.file ?? sample.changedPaths[0];
		const raw = sample.files.find((f) => f.path === path);
		if (!raw) return null;
		let content = raw.content;
		if (raw.path === "AGENTS.md") content = ROOT_AGENTS_MD;
		if (raw.path === "code_review.md") content = CODE_REVIEW_MD;
		if (raw.path === "src/payment/AGENTS.md") content = PAYMENT_AGENTS_MD;
		return {
			...raw,
			content
		};
	}, [sample, active]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-6xl px-4 py-8 md:px-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
				children: "Reviews"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "mt-2 text-3xl font-medium tracking-tight",
				children: "Posted thread"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted",
				children: "Poster talks to the Reviews API only. Same head SHA is dismissed before a replacement goes up. Models never see this screen."
			}),
			!active ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-10 text-sm text-fg-muted",
				children: "No reviews yet. Fire a sample PR from Operations."
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap items-center gap-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", {
								className: "text-lg font-medium",
								children: [
									active.owner,
									"/",
									active.repo,
									"#",
									active.pr
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MergePill, { event: active.event }),
							active.dismissed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
								tone: "muted",
								children: "dismissed"
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
								tone: "ok",
								children: "current"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "mt-1 font-mono text-[12px] text-fg-subtle",
						children: [
							shortSha(active.headSha),
							" · ",
							formatWhen(active.at)
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-4 whitespace-pre-wrap rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm leading-relaxed text-fg-muted",
						children: active.body
					}),
					file ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-6",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DiffView, {
							path: file.path,
							content: file.content,
							findings: job?.findings ?? [],
							caption: "Head snapshot. Highlight = accepted finding line — not a unified diff."
						})
					}) : null,
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
						className: "mt-6 space-y-3",
						children: active.comments.map((c) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
							className: "rounded-xl border border-line bg-bg-elevated p-4",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "font-mono text-[11px] text-fg-subtle",
								children: [
									c.file,
									":",
									c.line,
									" · ",
									c.side
								]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "mt-2 whitespace-pre-wrap text-sm leading-relaxed",
								children: c.body
							})]
						}, c.id))
					})
				] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
					className: "space-y-4",
					children: [!active.dismissed ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-xl border border-line bg-bg-elevated p-4",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
								className: "text-sm font-medium",
								children: "Mention the bot"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-1 text-[12px] text-fg-muted",
								children: "Comment text must include a mention token from Settings. Prior findings + this one line only."
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
								value: mention,
								onChange: (e) => setMention(e.target.value),
								className: "mt-3 h-24 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/40"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
								className: "mt-3 w-full",
								onClick: async () => {
									const out = await fire({
										sampleKey: job?.sampleKey ?? "pay-412",
										trigger: "issue_comment.mention",
										thread: {
											kind: "mention",
											commentId: 91,
											userText: mention
										}
									});
									setLastFire(out.httpStatus === 403 ? `403 · ${out.reject}` : out.skip ? `202 skip · ${out.skip}` : `202 queued · ${out.jobId}`);
								},
								children: "@ashlar-bot"
							}),
							lastFire ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-2 font-mono text-[11px] text-fg-muted",
								children: lastFire
							}) : null
						]
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-xl border border-line p-4 text-sm text-fg-muted",
						children: "This review was dismissed. Mention the current thread, not an old SHA."
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-xl border border-line p-4",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
							className: "text-sm font-medium",
							children: "History"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
							className: "mt-3 space-y-2 text-sm",
							children: reviews.map((r) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => setSelectedId(r.id),
								className: "flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-fg-muted hover:bg-bg-hover hover:text-fg",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
									"#",
									r.pr,
									" ",
									shortSha(r.headSha)
								] }), r.dismissed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: "muted",
									children: "old"
								}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: "ok",
									children: "live"
								})]
							}) }, r.id))
						})]
					})]
				})]
			})
		]
	});
}
//#endregion
export { Reviews as component };
