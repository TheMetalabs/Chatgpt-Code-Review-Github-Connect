import { t as cn } from "./utils-CmXpGXpd.mjs";
import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/diff-view-BbmG-HGA.js
var import_jsx_runtime = require_jsx_runtime();
function DiffView({ path, content, findings = [], caption }) {
	const lines = content.replace(/\n$/, "").split("\n");
	const byLine = new Map(findings.filter((f) => f.file === path && f.status === "accepted").map((f) => [f.line, f]));
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "overflow-hidden rounded-lg border border-line bg-bg",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "border-b border-line px-3 py-2",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "font-mono text-[11px] text-fg-muted",
				children: path
			}), caption ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "mt-1 text-[11px] text-fg-subtle",
				children: caption
			}) : null]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
			className: "overflow-x-auto p-0 text-[12px] leading-6",
			children: lines.map((line, i) => {
				const n = i + 1;
				const hit = byLine.get(n);
				return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: cn("grid grid-cols-[3rem_1fr] gap-3 px-3", hit ? "bg-danger/10" : n % 2 === 0 ? "bg-transparent" : "bg-bg-elevated/40"),
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "select-none text-right font-mono text-fg-subtle tabular-nums",
						children: n
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", {
						className: "font-mono text-fg whitespace-pre-wrap break-all",
						children: line || " "
					})]
				}, n);
			})
		})]
	});
}
//#endregion
export { DiffView as t };
