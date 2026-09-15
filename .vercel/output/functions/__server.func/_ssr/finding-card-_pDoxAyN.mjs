import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { t as Badge } from "./badge-DrZHdLLM.mjs";
import { r as severityTone } from "./status-pill-kphXt-cf.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/finding-card-_pDoxAyN.js
var import_jsx_runtime = require_jsx_runtime();
function FindingCard({ finding }) {
	const dropped = finding.status === "dropped";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
		className: "rounded-xl border border-line bg-bg-elevated p-4",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
						tone: severityTone(finding.severity),
						children: finding.severity
					}),
					dropped ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
						tone: "muted",
						children: "dropped"
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
						tone: "ok",
						children: "accepted"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "font-mono text-[11px] text-fg-subtle",
						children: [
							finding.file,
							":",
							finding.line
						]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
				className: "mt-3 text-[15px] font-medium tracking-tight",
				children: finding.title
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 text-sm leading-relaxed text-fg-muted",
				children: finding.failureScenario
			}),
			dropped && finding.dropReason ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-3 text-sm text-warn",
				children: finding.dropReason
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
				className: "mt-4 grid gap-3 text-sm",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Root cause"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1 text-fg-muted",
						children: finding.rootCause
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Evidence"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1 font-mono text-[12px] text-fg-muted",
						children: finding.evidence
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Fix"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1 text-fg-muted",
						children: finding.recommendedFix
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: "Test"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1 text-fg-muted",
						children: finding.recommendedTest
					})] })
				]
			})
		]
	});
}
//#endregion
export { FindingCard as t };
