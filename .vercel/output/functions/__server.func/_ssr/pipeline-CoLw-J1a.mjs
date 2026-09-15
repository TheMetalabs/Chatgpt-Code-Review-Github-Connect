import { t as cn } from "./utils-CmXpGXpd.mjs";
import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/pipeline-CoLw-J1a.js
var import_jsx_runtime = require_jsx_runtime();
var STAGES = [
	{
		id: "ingress",
		label: "Ingress"
	},
	{
		id: "queued",
		label: "Queue"
	},
	{
		id: "snapshot",
		label: "Snapshot"
	},
	{
		id: "explorer",
		label: "Explorer"
	},
	{
		id: "reviewer",
		label: "Reviewer"
	},
	{
		id: "validator",
		label: "Validator"
	},
	{
		id: "posting",
		label: "Poster"
	}
];
var ORDER = {
	ingress: 0,
	queued: 1,
	snapshot: 2,
	explorer: 3,
	reviewer: 4,
	validator: 5,
	posting: 6,
	posted: 7
};
function Pipeline({ status }) {
	const idx = status ? ORDER[status] ?? -1 : -1;
	const done = status === "posted";
	const skipped = status === "skipped" || status === "cancelled" || status === "dlq";
	const caption = status === "cancelled" ? "Cancelled — worker released." : status === "dlq" ? "Dead letter — validator failed." : status === "skipped" ? "Skipped — poster or ingress refused." : null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
		className: "grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7",
		children: STAGES.map((s, i) => {
			const active = !done && !skipped && idx === i;
			const complete = done || !skipped && idx > i;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
				className: cn("rounded-lg border px-3 py-3 transition-colors duration-200", skipped ? "border-line bg-bg" : active ? "border-line-strong bg-bg-hover" : complete ? "border-line bg-bg-elevated" : "border-line bg-bg"),
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
						children: String(i).padStart(2, "0")
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: cn("mt-1 text-sm", !skipped && (active || complete) ? "text-fg" : "text-fg-muted"),
						children: s.label
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-2 h-px bg-line",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: cn("h-px bg-accent transition-[width] duration-300", skipped ? "w-0" : complete ? "w-full" : active ? "w-1/2" : "w-0") })
					})
				]
			}, s.id);
		})
	}), caption ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
		className: "mt-3 text-sm text-fg-muted",
		children: caption
	}) : null] });
}
//#endregion
export { Pipeline as t };
