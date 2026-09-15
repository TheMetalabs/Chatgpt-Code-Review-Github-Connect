import { n as clsx } from "../_libs/class-variance-authority+clsx.mjs";
import { t as twMerge } from "../_libs/tailwind-merge.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/utils-CmXpGXpd.js
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
function shortSha(sha) {
	return sha.slice(0, 7);
}
function formatMs(ms) {
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	return `${(ms / 1e3).toFixed(1)}s`;
}
function formatWhen(ts) {
	const delta = Date.now() - ts;
	if (delta < 6e4) return "just now";
	if (delta < 36e5) return `${Math.floor(delta / 6e4)}m ago`;
	if (delta < 864e5) return `${Math.floor(delta / 36e5)}h ago`;
	return new Date(ts).toLocaleDateString();
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
export { sleep as a, shortSha as i, formatMs as n, formatWhen as r, cn as t };
