import { t as cn } from "./utils-CmXpGXpd.mjs";
import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/badge-DrZHdLLM.js
var import_jsx_runtime = require_jsx_runtime();
function Badge({ className, tone = "muted", ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: cn("inline-flex h-6 items-center rounded-full border px-2 font-mono text-[11px] tracking-wide uppercase", {
			muted: "text-fg-muted border-line",
			ok: "text-ok border-ok/30",
			warn: "text-warn border-warn/30",
			danger: "text-danger border-danger/30",
			accent: "text-accent border-line-strong",
			p0: "text-p0 border-p0/30",
			p1: "text-p1 border-p1/30",
			p2: "text-p2 border-p2/30"
		}[tone], className),
		...props
	});
}
//#endregion
export { Badge as t };
