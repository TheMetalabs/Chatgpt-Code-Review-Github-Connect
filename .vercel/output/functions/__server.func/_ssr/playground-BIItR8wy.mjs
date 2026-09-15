import { i as __toESM } from "../_runtime.mjs";
import { o as SAMPLE_PRS } from "./types-CqcBcVKJ.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { t as Button } from "./button-B2EtUDbO.mjs";
import { t as FindingCard } from "./finding-card-_pDoxAyN.mjs";
import { n as TSS_SERVER_FUNCTION, r as getServerFnById, t as createServerFn } from "./ssr.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/playground-BIItR8wy.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var createSsrRpc = (functionId) => {
	const url = "/_serverFn/" + functionId;
	const serverFnMeta = { id: functionId };
	const fn = async (...args) => {
		return (await getServerFnById(functionId, { origin: "server" }))(...args);
	};
	return Object.assign(fn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var runLiveReview = createServerFn({ method: "POST" }).validator((input) => {
	return {
		diff: String(input?.diff ?? "").slice(0, 12e3),
		extra: String(input?.extra ?? "").slice(0, 500)
	};
}).handler(createSsrRpc("07cc63413fde82899e3b082fc2eaa848094b93fb1e6f1caa688cf892808c0ce2"));
var DEFAULT_DIFF = SAMPLE_PRS["pay-412"].diff;
function Playground() {
	const [diff, setDiff] = (0, import_react.useState)(DEFAULT_DIFF);
	const [extra, setExtra] = (0, import_react.useState)("");
	const [busy, setBusy] = (0, import_react.useState)(false);
	const [error, setError] = (0, import_react.useState)(null);
	const [result, setResult] = (0, import_react.useState)(null);
	async function run() {
		setBusy(true);
		setError(null);
		try {
			const out = await runLiveReview({ data: {
				diff,
				extra
			} });
			if (!out.ok) setError(out.error);
			else setResult(out);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Live review failed");
		} finally {
			setBusy(false);
		}
	}
	const findings = result?.findings ?? [];
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-6xl px-4 py-8 md:px-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
				children: "Playground"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "mt-2 text-3xl font-medium tracking-tight",
				children: "Live agent loop"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted",
				children: "Optional Grok pass against the pinned #412 snapshot. User-initiated, turn-capped, read-only tools. Poster filters still run — hedges, phantom lines, and APPROVE-with-findings never publish."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "mt-4 rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm text-fg-muted",
				children: "Playground does not enqueue jobs or post reviews. Operations tapes are the poster path."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-8 grid gap-6 lg:grid-cols-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Diff (untrusted)"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
						value: diff,
						onChange: (e) => setDiff(e.target.value),
						className: "mt-2 h-48 w-full rounded-lg border border-line bg-bg-elevated px-3 py-3 font-mono text-[12px] leading-5 outline-none focus:ring-2 focus:ring-accent/40 md:h-72"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						className: "mt-4 block font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Untrusted user line"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						value: extra,
						onChange: (e) => setExtra(e.target.value),
						placeholder: "optional — treated as untrusted",
						className: "mt-2 h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						className: "mt-4",
						disabled: busy,
						onClick: run,
						children: busy ? "Running harness…" : "Run live agent"
					}),
					error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-3 text-sm text-danger",
						children: error
					}) : null
				] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: result ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-4",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "rounded-xl border border-line bg-bg-elevated p-4 text-sm",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
									children: "poster gate"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "mt-1",
									children: result.mergeRecommendation
								}),
								result.highestRisk ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "mt-1 text-fg-muted",
									children: result.highestRisk
								}) : null,
								result.dropped.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
									className: "mt-2 text-[12px] text-warn",
									children: [result.dropped.length, " candidate(s) dropped by policy"]
								}) : null
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
							className: "overflow-hidden rounded-xl border border-line",
							children: result.traces.map((t, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
								className: "border-t border-line px-4 py-2 first:border-t-0",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "font-mono text-[12px] text-accent",
										children: t.tool
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "font-mono text-[11px] text-fg-subtle",
										children: t.args
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "text-[12px] text-fg-muted",
										children: t.result
									})
								]
							}, i))
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "grid gap-3",
							children: [findings.map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FindingCard, { finding: f }, f.id)), findings.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-fg-muted",
								children: "Empty findings — no publish."
							}) : null]
						})
					]
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-fg-subtle",
					children: "Snapshot is pinned to acme/pay#412. Fire Operations tapes if you only want the scripted harness."
				}) })]
			})
		]
	});
}
//#endregion
export { Playground as component };
