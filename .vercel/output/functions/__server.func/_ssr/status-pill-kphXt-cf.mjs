import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { t as Badge } from "./badge-DrZHdLLM.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/status-pill-kphXt-cf.js
var import_jsx_runtime = require_jsx_runtime();
function severityTone(s) {
	return s.toLowerCase();
}
function StatusPill({ status }) {
	const m = {
		queued: {
			tone: "muted",
			label: "queued"
		},
		snapshot: {
			tone: "accent",
			label: "snapshot"
		},
		explorer: {
			tone: "accent",
			label: "explorer"
		},
		reviewer: {
			tone: "accent",
			label: "reviewer"
		},
		validator: {
			tone: "accent",
			label: "validator"
		},
		posting: {
			tone: "accent",
			label: "poster"
		},
		posted: {
			tone: "ok",
			label: "posted"
		},
		skipped: {
			tone: "muted",
			label: "skipped"
		},
		dlq: {
			tone: "danger",
			label: "dlq"
		},
		cancelled: {
			tone: "warn",
			label: "cancelled"
		}
	}[status];
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
		tone: m.tone,
		children: m.label
	});
}
function MergePill({ event }) {
	if (!event) return null;
	if (event === "REQUEST_CHANGES") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
		tone: "danger",
		children: "request changes"
	});
	if (event === "APPROVE") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
		tone: "ok",
		children: "approve"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
		tone: "muted",
		children: "comment"
	});
}
//#endregion
export { StatusPill as n, severityTone as r, MergePill as t };
