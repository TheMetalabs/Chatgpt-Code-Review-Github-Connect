import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { n as PAYMENT_AGENTS_MD, r as ROOT_AGENTS_MD, t as CODE_REVIEW_MD } from "./policy-CvHpVqoK.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/policies-Ci8_XODW.js
var import_jsx_runtime = require_jsx_runtime();
var FILES = [
	{
		path: "AGENTS.md",
		note: "Directory page. ~short. Points at details.",
		content: ROOT_AGENTS_MD
	},
	{
		path: "code_review.md",
		note: "Priority, Never report, finding standard.",
		content: CODE_REVIEW_MD
	},
	{
		path: "src/payment/AGENTS.md",
		note: "Closest-file wins on payment diffs.",
		content: PAYMENT_AGENTS_MD
	}
];
function Policies() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-4xl px-4 py-8 md:px-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
				children: "Policies"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "mt-2 text-3xl font-medium tracking-tight",
				children: "Closest file wins"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted",
				children: "Constitution stays short. Repo files are promoted only from allowlisted relative paths. PR bodies and source comments stay untrusted — including “ignore previous instructions”."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "mt-8 space-y-6",
				children: FILES.map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
					className: "overflow-hidden rounded-xl border border-line",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
						className: "flex flex-wrap items-baseline justify-between gap-2 border-b border-line bg-bg-elevated px-4 py-3",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
							className: "font-mono text-sm",
							children: f.path
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-[12px] text-fg-subtle",
							children: f.note
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
						className: "overflow-x-auto p-4 font-mono text-[12px] leading-6 text-fg-muted",
						children: f.content
					})]
				}, f.path))
			})
		]
	});
}
//#endregion
export { Policies as component };
