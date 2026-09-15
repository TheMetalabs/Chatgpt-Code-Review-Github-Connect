import { i as __toESM } from "../_runtime.mjs";
import { a as LIVE_INFLIGHT_STATUSES, c as filterPublishable, d as tracesFor412, f as tracesFor418, h as tracesForMention, i as FINDING_421, m as tracesForDlq, n as DEFAULT_SETTINGS, o as SAMPLE_PRS, p as tracesFor421, r as FINDING_412, s as buildReview, t as CANDIDATE_412_DROPPED, u as isBotMention } from "./types-CqcBcVKJ.mjs";
import { a as sleep, t as cn } from "./utils-CmXpGXpd.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { _ as createRootRoute, b as require_jsx_runtime, d as useRouterState, g as createFileRoute, h as lazyRouteComponent, l as Scripts, m as Outlet, p as createRouter, u as HeadContent, v as Link, y as useRouter } from "../_libs/@tanstack/react-router+[...].mjs";
import { a as MessageSquareCode, l as Activity, n as SquareDashedMousePointer, o as Inbox, r as Settings2, s as BookOpen, t as TriangleAlert } from "../_libs/lucide-react.mjs";
import { a as union, i as string, n as number, r as object, t as literal } from "../_libs/zod.mjs";
import { t as create } from "../_libs/zustand.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/router-Cie5IrZk.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";
function errorMessage(error) {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return FALLBACK_MESSAGE;
}
function AppErrorComponent({ error }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "text-red-500",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TriangleAlert, {
					className: "size-10",
					strokeWidth: 2
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "text-lg font-semibold",
				children: "Something went wrong"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "max-w-md text-sm break-words text-zinc-500 dark:text-zinc-400",
				children: errorMessage(error)
			})
		]
	});
}
/**
* App-wide client provider mounted once near the root (in `src/routes/__root.tsx`):
*
*   <AuthProvider><Outlet /></AuthProvider>
*
* Better Auth's React client (`@/lib/auth/client`) needs NO context provider —
* its `useSession()` works standalone — so this is a passthrough today. It's
* kept as the single, stable mount point for any future client-side providers
* (e.g. a toast or theme provider) without churning the root shell.
*/
function AuthProvider({ children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children });
}
var CONNECTOR_TOKEN_READY_EVENT = "grok:connector-token-ready";
function isGrokEmbedderOrigin(origin) {
	try {
		const url = new URL(origin);
		if (url.protocol !== "https:" && url.protocol !== "http:") return false;
		const host = url.hostname.toLowerCase();
		if (host === "grok.com" || host.endsWith(".grok.com")) return true;
		if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
		return false;
	} catch {
		return false;
	}
}
function isSandboxPreviewGuestHost(hostname) {
	const host = hostname.toLowerCase();
	return host === "grok-sandbox.com" || host.endsWith(".grok-sandbox.com");
}
function isRemintPreviewPair(guestHost, parentHost) {
	const guest = guestHost.toLowerCase();
	const parent = parentHost.toLowerCase();
	const i = guest.indexOf(".preview.");
	if (i <= 0) return false;
	const label = guest.slice(0, i);
	const rest = guest.slice(i + 9);
	if (label.includes(".") || !rest.includes(".")) return false;
	return parent === rest || parent === `grok.${rest}`;
}
function resolveParentEmbedderOrigin(parentIsSelf, referrer, ancestorOrigin, guestHostname = "") {
	if (parentIsSelf) return null;
	for (const candidate of [referrer, ancestorOrigin ?? ""].filter(Boolean)) try {
		const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") continue;
		if (isGrokEmbedderOrigin(url.origin)) return url.origin;
		if (isSandboxPreviewGuestHost(guestHostname) || isRemintPreviewPair(guestHostname, url.hostname)) return url.origin;
	} catch {}
	return null;
}
/**
* Guest side of the grok-web ↔ sandbox preview postMessage bridge.
*
* Activates only when this page is framed by an allowlisted Grok embedder.
* Top-level runs (download/export, local `npm run dev`, deployed sites) noop.
*/
var PREVIEW_BRIDGE_CHANNEL = "grok-preview-bridge";
var EnvelopeSchema = object({
	channel: literal(PREVIEW_BRIDGE_CHANNEL),
	version: number().int().positive(),
	type: string().min(1)
});
var HelloSchema = EnvelopeSchema.extend({ type: literal("hello") });
var NavigateSchema = EnvelopeSchema.extend({
	type: literal("navigate"),
	path: string().min(1)
});
var HistorySchema = EnvelopeSchema.extend({
	type: literal("history"),
	delta: union([literal(-1), literal(1)])
});
var ConnectorTokenReadySchema = EnvelopeSchema.extend({ type: literal("connector-token-ready") });
function isSafeBridgePath(path) {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
	try {
		return new URL(path, "https://preview.invalid").origin === "https://preview.invalid";
	} catch {
		return false;
	}
}
/**
* Origin of the Grok embedder framing this page, or null when the page runs
* top-level (download/export, local `npm run dev`, deployed sites) or under a
* non-Grok parent. Client-only; null during SSR.
*/
function resolveCurrentEmbedderOrigin() {
	if (typeof window === "undefined") return null;
	const ancestorOrigin = typeof location.ancestorOrigins !== "undefined" && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : null;
	return resolveParentEmbedderOrigin(window.parent === window, document.referrer, ancestorOrigin, window.location.hostname);
}
/**
* Install host↔guest messaging. Returns a dispose function.
* Noops (returns a no-op dispose) when not embedded under a Grok parent.
*/
function installPreviewHostBridge(options = {}) {
	const parentOrigin = resolveCurrentEmbedderOrigin();
	if (parentOrigin === null) return () => {};
	const ROOT_STATE_KEY = "__grokPreviewBridgeRoot";
	const originalPushState = window.history.pushState.bind(window.history);
	const originalReplaceState = window.history.replaceState.bind(window.history);
	const isAtHistoryRoot = () => {
		const state = window.history.state;
		return Boolean(state && typeof state === "object" && state[ROOT_STATE_KEY] === true);
	};
	try {
		const current = window.history.state;
		if (!(current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, ROOT_STATE_KEY))) {
			const isRoot = window.history.length <= 1;
			originalReplaceState(current && typeof current === "object" ? {
				...current,
				[ROOT_STATE_KEY]: isRoot
			} : { [ROOT_STATE_KEY]: isRoot }, "", window.location.href);
		}
	} catch {}
	const post = (message) => {
		window.parent.postMessage(message, parentOrigin);
	};
	const reportLocation = () => {
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "location",
			path: window.location.pathname || "/",
			search: window.location.search,
			hash: window.location.hash
		});
	};
	const reportRoutes = () => {
		const paths = options.getRoutePaths?.() ?? [];
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "routes",
			paths
		});
	};
	const defaultNavigate = (path) => {
		if (!isSafeBridgePath(path)) return;
		try {
			const url = new URL(path, window.location.origin);
			if (url.origin !== window.location.origin) return;
			const next = `${url.pathname}${url.search}${url.hash}`;
			window.history.pushState(window.history.state, "", next);
			window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
		} catch {}
	};
	const navigate = (path) => {
		if (!isSafeBridgePath(path)) return;
		if (options.navigate) {
			options.navigate(path);
			return;
		}
		defaultNavigate(path);
	};
	const announce = () => {
		reportLocation();
		reportRoutes();
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "ready"
		});
	};
	const onHello = (data) => {
		if (!HelloSchema.safeParse(data).success) return;
		announce();
	};
	const onNavigate = (data) => {
		const parsed = NavigateSchema.safeParse(data);
		if (!parsed.success) return;
		navigate(parsed.data.path);
		queueMicrotask(reportLocation);
	};
	const onHistory = (data) => {
		const parsed = HistorySchema.safeParse(data);
		if (!parsed.success) return;
		if (parsed.data.delta === -1 && isAtHistoryRoot()) return;
		window.history.go(parsed.data.delta);
	};
	const onConnectorTokenReady = (data) => {
		if (!ConnectorTokenReadySchema.safeParse(data).success) return;
		window.dispatchEvent(new Event(CONNECTOR_TOKEN_READY_EVENT));
	};
	const hostMessageHandlers = /* @__PURE__ */ new Map([
		["hello", onHello],
		["navigate", onNavigate],
		["history", onHistory],
		["connector-token-ready", onConnectorTokenReady]
	]);
	const onMessage = (event) => {
		if (event.source !== window.parent) return;
		if (event.origin !== parentOrigin) return;
		const envelope = EnvelopeSchema.safeParse(event.data);
		if (!envelope.success || envelope.data.version !== 1) return;
		hostMessageHandlers.get(envelope.data.type)?.(event.data);
	};
	const onPopState = () => {
		reportLocation();
	};
	const onHashChange = () => {
		reportLocation();
	};
	window.history.pushState = (data, unused, url) => {
		const next = data && typeof data === "object" ? {
			...data,
			[ROOT_STATE_KEY]: false
		} : data;
		originalPushState(next, unused, url);
		reportLocation();
	};
	window.history.replaceState = (data, unused, url) => {
		const next = isAtHistoryRoot() ? {
			...data && typeof data === "object" ? data : {},
			[ROOT_STATE_KEY]: true
		} : data;
		originalReplaceState(next, unused, url);
		reportLocation();
	};
	window.addEventListener("message", onMessage);
	window.addEventListener("popstate", onPopState);
	window.addEventListener("hashchange", onHashChange);
	announce();
	return () => {
		window.removeEventListener("message", onMessage);
		window.removeEventListener("popstate", onPopState);
		window.removeEventListener("hashchange", onHashChange);
		window.history.pushState = originalPushState;
		window.history.replaceState = originalReplaceState;
	};
}
/** Collect static path patterns from a TanStack route tree (best-effort). */
function collectRoutePathsFromTree(routeTree) {
	const paths = /* @__PURE__ */ new Set();
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		const record = node;
		const full = typeof record.fullPath === "string" ? record.fullPath : typeof record.path === "string" ? record.path : null;
		if (full !== null && full !== "") paths.add(full.startsWith("/") ? full : `/${full}`);
		else if (full === "") paths.add("/");
		const children = record.children;
		if (Array.isArray(children)) for (const child of children) walk(child);
		else if (children && typeof children === "object") for (const child of Object.values(children)) walk(child);
	};
	walk(routeTree);
	return [...paths];
}
/**
* Mount once in `__root.tsx` so the Grok preview chrome can drive navigation
* (and later receive registered routes). Noops when the app is not embedded.
*/
function PreviewHostBridge() {
	const router = useRouter();
	(0, import_react.useEffect)(() => {
		return installPreviewHostBridge({
			navigate: (path) => {
				router.history.push(path);
			},
			getRoutePaths: () => collectRoutePathsFromTree(router.routeTree)
		});
	}, [router]);
	return null;
}
function Mark({ className }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 32 32",
		className: cn("size-7", className),
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
				d: "M6 26V8l16 18H6Z",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinejoin: "miter"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
				d: "M6 26h18",
				stroke: "currentColor",
				strokeWidth: "1.6"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
				d: "M6 20h6",
				stroke: "currentColor",
				strokeWidth: "1.2",
				opacity: "0.7"
			})
		]
	});
}
var MENTION_TRIGGERS = ["issue_comment.mention", "pull_request_review_comment.followup"];
function decideIngress(opts) {
	if (!opts.hmacOk) return {
		ok: false,
		status: 403,
		reason: "HMAC mismatch"
	};
	if ((opts.knownDeliveries ?? []).includes(opts.deliveryId) || opts.existing.some((j) => j.deliveryId === opts.deliveryId)) return {
		ok: true,
		skip: `duplicate delivery_id ${opts.deliveryId}`
	};
	if (opts.settings.skipDrafts && opts.sample.isDraft) return {
		ok: true,
		skip: "draft"
	};
	if (opts.settings.skipForks && opts.sample.isFork) return {
		ok: true,
		skip: "fork (allowlist empty) · PR body not promoted to policy"
	};
	if (MENTION_TRIGGERS.includes(opts.trigger)) {
		if (!isBotMention(opts.thread?.userText, opts.settings)) return {
			ok: true,
			skip: "not a mention"
		};
	}
	if (opts.existing.find((j) => j.owner === opts.sample.owner && j.repo === opts.sample.repo && j.pr === opts.sample.pr && j.headSha === opts.sample.headSha && j.trigger === opts.trigger && (j.status === "posted" || j.status === "skipped")) && !MENTION_TRIGGERS.includes(opts.trigger)) return {
		ok: true,
		skip: "idempotent (repo, pr, head_sha, trigger)"
	};
	return {
		ok: true,
		job: {
			deliveryId: opts.deliveryId,
			trigger: opts.trigger,
			owner: opts.sample.owner,
			repo: opts.sample.repo,
			pr: opts.sample.pr,
			title: opts.sample.title,
			headSha: opts.sample.headSha,
			baseSha: opts.sample.baseSha,
			sender: opts.sample.sender,
			isFork: opts.sample.isFork,
			isDraft: opts.sample.isDraft,
			thread: MENTION_TRIGGERS.includes(opts.trigger) ? opts.thread : void 0,
			sampleKey: opts.sample.key
		}
	};
}
var seq = 1;
var nid = (p) => `${p}-${Date.now().toString(36)}-${seq++}`;
function seed() {
	const now = Date.now() - 72e4;
	const job = {
		id: "job-seed-412",
		deliveryId: "d-seed-412",
		trigger: "pull_request.opened",
		owner: "acme",
		repo: "pay",
		pr: 412,
		title: SAMPLE_PRS["pay-412"].title,
		headSha: SAMPLE_PRS["pay-412"].headSha,
		baseSha: SAMPLE_PRS["pay-412"].baseSha,
		sender: "alice",
		isFork: false,
		isDraft: false,
		status: "posted",
		createdAt: now,
		updatedAt: now + 1800,
		ingressMs: 42,
		traces: tracesFor412(now),
		plan: "Investigate capture + fulfill replay against payment invariants. No findings in Explorer.",
		candidates: [FINDING_412, CANDIDATE_412_DROPPED],
		findings: [{
			...FINDING_412,
			status: "accepted"
		}],
		mergeRecommendation: "REQUEST_CHANGES",
		highestRisk: "double capture on webhook retry",
		investigatedSafe: [],
		assumptions: ["Stripe at-least-once delivery"],
		postedReviewId: "rev-job-seed-412",
		sampleKey: "pay-412"
	};
	const review = buildReview(job, filterPublishable(job, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
	review.id = "rev-job-seed-412";
	review.at = now + 1800;
	const event = {
		id: "ev-seed-412",
		deliveryId: job.deliveryId,
		event: "pull_request",
		action: "opened",
		hmac: "ok",
		httpStatus: 202,
		at: now,
		summary: "acme/pay#412 opened",
		jobId: job.id
	};
	return {
		jobs: [job],
		events: [event],
		reviews: [review]
	};
}
function isLive(status) {
	return LIVE_INFLIGHT_STATUSES.includes(status);
}
async function playJob(get, set, jobId, opts = {}) {
	const patch = (fn) => set((s) => ({ jobs: s.jobs.map((j) => j.id === jobId ? fn(j) : j) }));
	const current = () => get().jobs.find((j) => j.id === jobId);
	if (!current()) return;
	const stages = opts.forceDlq ? [
		"snapshot",
		"explorer",
		"reviewer"
	] : [
		"snapshot",
		"explorer",
		"reviewer",
		"validator",
		"posting"
	];
	for (const st of stages) {
		await sleep(st === "snapshot" ? 280 : st === "explorer" ? 520 : st === "reviewer" ? 640 : 420);
		const live = current();
		if (!live || live.status === "cancelled") return;
		patch((j) => ({
			...j,
			status: st,
			updatedAt: Date.now()
		}));
	}
	const live = current();
	if (!live || live.status === "cancelled") return;
	if (opts.forceDlq) {
		patch((j) => ({
			...j,
			status: "dlq",
			skipReason: "validator timeout — job moved to DLQ",
			traces: tracesForDlq(Date.now() - 200),
			updatedAt: Date.now()
		}));
		return;
	}
	const sample = SAMPLE_PRS[live.sampleKey ?? ""];
	const settings = get().settings;
	const mention = Boolean(live.thread && isBotMention(live.thread.userText, settings));
	const now = Date.now();
	if (mention && live.sampleKey === "pay-412") patch((j) => ({
		...j,
		traces: tracesForMention(now - 200),
		plan: "Prior findings + user line only. Do not reload the full thread.",
		candidates: [FINDING_412],
		findings: [{
			...FINDING_412,
			status: "accepted"
		}],
		mergeRecommendation: "REQUEST_CHANGES",
		highestRisk: "double capture on webhook retry; fulfillOrder also replays",
		assumptions: ["Stripe at-least-once delivery"]
	}));
	else if (live.sampleKey === "pay-412") {
		const naming = settings.precisionOverRecall ? CANDIDATE_412_DROPPED : {
			...CANDIDATE_412_DROPPED,
			status: "accepted",
			dropReason: void 0
		};
		patch((j) => ({
			...j,
			traces: tracesFor412(now - 1100),
			plan: "Investigate capture + fulfill replay against payment invariants.",
			candidates: [FINDING_412, naming],
			findings: settings.precisionOverRecall ? [{
				...FINDING_412,
				status: "accepted"
			}] : [{
				...FINDING_412,
				status: "accepted"
			}, {
				...CANDIDATE_412_DROPPED,
				status: "accepted",
				dropReason: void 0
			}],
			mergeRecommendation: "REQUEST_CHANGES",
			highestRisk: "double capture on webhook retry",
			assumptions: ["Stripe at-least-once delivery"]
		}));
	} else if (live.sampleKey === "pay-418") patch((j) => ({
		...j,
		traces: tracesFor418(now - 420),
		plan: "New invoices route. Confirm auth guard. Findings forbidden until concrete failure.",
		candidates: [],
		findings: [],
		investigatedSafe: ["auth middleware on new route"],
		assumptions: []
	}));
	else if (live.sampleKey === "pay-421") patch((j) => ({
		...j,
		traces: tracesFor421(now - 300),
		plan: "Untrusted PR body quoted, not loaded. Investigate missing auth guard.",
		candidates: [FINDING_421],
		findings: [{
			...FINDING_421,
			status: "accepted"
		}],
		mergeRecommendation: "REQUEST_CHANGES",
		highestRisk: "unauthenticated invoice creation",
		assumptions: ["PR body is untrusted"]
	}));
	const after = current();
	if (!after) return;
	const liveSettings = get().settings;
	const publishable = filterPublishable(after, liveSettings, sample);
	const review = buildReview(after, publishable, liveSettings);
	if (!review) {
		set((s) => ({
			jobs: s.jobs.map((j) => j.id === jobId ? {
				...j,
				status: "skipped",
				skipReason: "poster: zero findings (precision policy)",
				mergeRecommendation: void 0,
				postedReviewId: void 0,
				updatedAt: Date.now()
			} : j),
			reviews: s.reviews.map((r) => r.owner === after.owner && r.repo === after.repo && r.pr === after.pr && r.headSha === after.headSha ? {
				...r,
				dismissed: true
			} : r)
		}));
		return;
	}
	set((s) => ({
		reviews: [review, ...s.reviews.map((r) => r.owner === review.owner && r.repo === review.repo && r.pr === review.pr && r.headSha === review.headSha ? {
			...r,
			dismissed: true
		} : r)],
		jobs: s.jobs.map((j) => j.id === jobId ? {
			...j,
			status: "posted",
			postedReviewId: review.id,
			updatedAt: Date.now(),
			mergeRecommendation: review.event,
			findings: publishable.length ? publishable : j.findings
		} : j)
	}));
}
var useAshlar = create()((set, get) => ({
	settings: DEFAULT_SETTINGS,
	...seed(),
	setSettings: (patch) => set((s) => ({ settings: {
		...s.settings,
		...patch
	} })),
	resetDemo: () => set(() => ({
		...seed(),
		settings: DEFAULT_SETTINGS
	})),
	cancel: (jobId) => set((s) => ({ jobs: s.jobs.map((j) => j.id === jobId && isLive(j.status) ? {
		...j,
		status: "cancelled",
		skipReason: "cancelled by operator",
		updatedAt: Date.now()
	} : j) })),
	fire: async (opts) => {
		const sample = SAMPLE_PRS[opts.sampleKey];
		if (!sample) return {
			httpStatus: 403,
			reject: "unknown sample"
		};
		const hmacOk = opts.hmacOk !== false;
		const deliveryId = opts.deliveryId ?? nid("d");
		const t0 = performance.now();
		const decision = decideIngress({
			hmacOk,
			settings: get().settings,
			sample,
			trigger: opts.trigger,
			deliveryId,
			existing: get().jobs,
			knownDeliveries: get().events.map((e) => e.deliveryId),
			thread: opts.thread
		});
		const ingressMs = Math.max(8, performance.now() - t0);
		if (!decision.ok) {
			const ev = {
				id: nid("ev"),
				deliveryId,
				event: opts.trigger.split(".")[0],
				action: opts.trigger.split(".")[1] ?? "unknown",
				hmac: "fail",
				httpStatus: 403,
				at: Date.now(),
				summary: `${sample.owner}/${sample.repo}#${sample.pr} rejected`,
				rejectReason: decision.reason
			};
			set((s) => ({ events: [ev, ...s.events] }));
			return {
				httpStatus: 403,
				reject: decision.reason
			};
		}
		if (decision.skip || !decision.job) {
			const skipJob = {
				deliveryId,
				trigger: opts.trigger,
				owner: sample.owner,
				repo: sample.repo,
				pr: sample.pr,
				title: sample.title,
				headSha: sample.headSha,
				baseSha: sample.baseSha,
				sender: sample.sender,
				isFork: sample.isFork,
				isDraft: sample.isDraft,
				thread: opts.thread,
				sampleKey: sample.key,
				id: nid("job"),
				status: "skipped",
				skipReason: decision.skip ?? "filtered",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				ingressMs,
				traces: [],
				plan: "",
				candidates: [],
				findings: [],
				investigatedSafe: [],
				assumptions: []
			};
			const ev = {
				id: nid("ev"),
				deliveryId,
				event: opts.trigger.split(".")[0],
				action: opts.trigger.split(".")[1] ?? "unknown",
				hmac: "ok",
				httpStatus: 202,
				at: Date.now(),
				summary: `${sample.owner}/${sample.repo}#${sample.pr} skipped`,
				skipReason: decision.skip ?? "filtered",
				jobId: skipJob.id
			};
			set((s) => ({
				jobs: [skipJob, ...s.jobs],
				events: [ev, ...s.events]
			}));
			return {
				httpStatus: 202,
				skip: decision.skip ?? "filtered",
				jobId: skipJob.id
			};
		}
		const payload = decision.job;
		const job = {
			deliveryId: payload.deliveryId,
			trigger: payload.trigger,
			owner: payload.owner,
			repo: payload.repo,
			pr: payload.pr,
			title: payload.title,
			headSha: payload.headSha,
			baseSha: payload.baseSha,
			sender: payload.sender,
			isFork: payload.isFork,
			isDraft: payload.isDraft,
			thread: payload.thread,
			sampleKey: payload.sampleKey,
			id: nid("job"),
			status: "queued",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			ingressMs,
			traces: [],
			plan: "",
			candidates: [],
			findings: [],
			investigatedSafe: [],
			assumptions: []
		};
		set((s) => {
			const cancelled = s.jobs.map((j) => j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && isLive(j.status) ? {
				...j,
				status: "cancelled",
				skipReason: `superseded by ${job.id}`,
				updatedAt: Date.now()
			} : j);
			const ev = {
				id: nid("ev"),
				deliveryId,
				event: opts.trigger.split(".")[0],
				action: opts.trigger.split(".")[1] ?? "unknown",
				hmac: "ok",
				httpStatus: 202,
				at: Date.now(),
				summary: `${job.owner}/${job.repo}#${job.pr} ${opts.trigger}`,
				jobId: job.id
			};
			return {
				jobs: [job, ...cancelled],
				events: [ev, ...s.events]
			};
		});
		playJob(get, set, job.id, { forceDlq: opts.forceDlq });
		return {
			httpStatus: 202,
			jobId: job.id
		};
	}
}));
var NAV = [
	{
		to: "/",
		label: "Operations",
		icon: Activity
	},
	{
		to: "/inbox",
		label: "Inbox",
		icon: Inbox
	},
	{
		to: "/reviews",
		label: "Reviews",
		icon: MessageSquareCode
	},
	{
		to: "/policies",
		label: "Policies",
		icon: BookOpen
	},
	{
		to: "/playground",
		label: "Playground",
		icon: SquareDashedMousePointer
	},
	{
		to: "/settings",
		label: "Settings",
		icon: Settings2
	}
];
function AppShell({ children }) {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const queued = useAshlar((s) => s.jobs.filter((j) => LIVE_INFLIGHT_STATUSES.includes(j.status)).length);
	const lastReject = useAshlar((s) => s.events.find((e) => e.httpStatus === 403));
	const hmacHot = Boolean(lastReject && Date.now() - lastReject.at < 6e4);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "min-h-dvh bg-bg text-fg",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
			href: "#main",
			className: "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg",
			children: "Skip to content"
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-h-dvh",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
				className: "sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-bg-elevated md:flex",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
						to: "/",
						className: "flex items-center gap-2.5 px-5 py-6 text-fg",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mark, { className: "text-accent" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "text-[15px] font-semibold tracking-tight",
							children: "Ashlar"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle",
							children: "review harness"
						})] })]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
						className: "flex flex-1 flex-col gap-0.5 px-3",
						children: NAV.map((item) => {
							const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
							const Icon = item.icon;
							return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
								to: item.to,
								className: cn("flex h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150", active ? "bg-bg-hover text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg"),
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, {
										className: "size-4",
										strokeWidth: 1.6
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "flex-1",
										children: item.label
									}),
									item.to === "/" && queued > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-mono text-[11px] tabular-nums text-accent",
										children: queued
									}) : null
								]
							}, item.to);
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "border-t border-line px-5 py-4",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2 text-[11px] text-fg-subtle",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: cn("size-1.5 rounded-full", hmacHot ? "bg-danger" : "bg-ok") }), hmacHot ? "HMAC rejected" : "Ingress listening"]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "mt-1 font-mono text-[11px] text-fg-muted",
							children: "acme/pay · App token"
						})]
					})
				]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-w-0 flex-1 flex-col",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
						className: "sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur md:hidden",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mark, { className: "size-6 text-accent" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "text-sm font-semibold",
								children: "Ashlar"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
								to: "/settings",
								className: "ml-auto inline-flex size-11 items-center justify-center text-fg-muted",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Settings2, {
									className: "size-4",
									strokeWidth: 1.6
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "sr-only",
									children: "Settings"
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("main", {
						id: "main",
						className: "flex-1 pb-20 md:pb-0",
						children
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
						className: "fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-bg-elevated md:hidden",
						children: NAV.filter((n) => n.to !== "/settings").map((item) => {
							const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
							const Icon = item.icon;
							return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
								to: item.to,
								className: cn("flex min-h-14 flex-col items-center justify-center gap-1 text-[10px]", active ? "text-fg" : "text-fg-subtle"),
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, {
									className: "size-4",
									strokeWidth: 1.6
								}), item.label]
							}, item.to);
						})
					})
				]
			})]
		})]
	});
}
var styles_default = "/assets/styles-fXlYZ0rB.css";
var APP_NAME = "Ashlar";
var Route$8 = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1"
			},
			{ title: APP_NAME },
			{
				name: "description",
				content: "Precision PR reviews. Codex loop, webhook delivery, scripted posts."
			},
			{
				name: "theme-color",
				content: "#0b0c0e"
			}
		],
		links: [
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/favicon.svg"
			},
			{
				rel: "stylesheet",
				href: styles_default
			},
			{
				rel: "manifest",
				href: "/__grok/manifest.webmanifest"
			},
			{
				rel: "apple-touch-icon",
				href: "/__grok/icon-180.png"
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap"
			}
		]
	}),
	component: () => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("html", {
		lang: "en",
		className: "antialiased",
		suppressHydrationWarning: true,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("head", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HeadContent, {}) }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("body", {
			className: "bg-bg text-fg",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PreviewHostBridge, {}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AuthProvider, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AppShell, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {}) }) }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Scripts, {})
			]
		})]
	})
});
var $$splitComponentImporter$6 = () => import("./routes-BDOVMf6A.mjs");
var Route$7 = createFileRoute("/")({ component: lazyRouteComponent($$splitComponentImporter$6, "component") });
var $$splitComponentImporter$5 = () => import("./inbox-C1O0XLAA.mjs");
var Route$6 = createFileRoute("/inbox")({ component: lazyRouteComponent($$splitComponentImporter$5, "component") });
var $$splitComponentImporter$4 = () => import("./playground-BIItR8wy.mjs");
var Route$5 = createFileRoute("/playground")({ component: lazyRouteComponent($$splitComponentImporter$4, "component") });
var $$splitComponentImporter$3 = () => import("./policies-Ci8_XODW.mjs");
var Route$4 = createFileRoute("/policies")({ component: lazyRouteComponent($$splitComponentImporter$3, "component") });
var $$splitComponentImporter$2 = () => import("./reviews-VonHMJTm.mjs");
var Route$3 = createFileRoute("/reviews")({ component: lazyRouteComponent($$splitComponentImporter$2, "component") });
var $$splitComponentImporter$1 = () => import("./settings-DRbNS8z_.mjs");
var Route$2 = createFileRoute("/settings")({ component: lazyRouteComponent($$splitComponentImporter$1, "component") });
async function signHub256(secret, body) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), {
		name: "HMAC",
		hash: "SHA-256"
	}, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
	return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function hexToBytes(hex) {
	if (hex.length !== 64 || /[^0-9a-f]/i.test(hex)) return null;
	const out = /* @__PURE__ */ new Uint8Array(32);
	for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
async function verifyHub256(secret, body, header) {
	if (!secret || !header) return false;
	const token = header.split(",")[0]?.trim() ?? "";
	if (!token.startsWith("sha256=")) return false;
	const provided = hexToBytes(token.slice(7));
	if (!provided) return false;
	const expected = hexToBytes((await signHub256(secret, body)).slice(7));
	if (!expected || expected.length !== provided.length) return false;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ provided[i];
	return mismatch === 0;
}
var MAX_BODY = 65536;
var ALLOWED_EVENTS = /* @__PURE__ */ new Set([
	"ping",
	"pull_request",
	"issue_comment"
]);
var Route$1 = createFileRoute("/api/webhook")({ server: { handlers: { POST: async ({ request }) => {
	const t0 = performance.now();
	const secret = process.env.GITHUB_WEBHOOK_SECRET || DEFAULT_SETTINGS.webhookSecret;
	if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY) return Response.json({
		accepted: false,
		reason: "payload too large"
	}, { status: 413 });
	const body = await request.text();
	if (body.length > MAX_BODY) return Response.json({
		accepted: false,
		reason: "payload too large"
	}, { status: 413 });
	const sig = request.headers.get("x-hub-signature-256");
	const event = request.headers.get("x-github-event") ?? "";
	const delivery = request.headers.get("x-github-delivery") ?? "";
	const ok = await verifyHub256(secret, body, sig);
	const ingressMs = Math.round(performance.now() - t0);
	if (!ok) return Response.json({
		accepted: false,
		reason: "HMAC mismatch",
		ingressMs,
		delivery,
		event
	}, { status: 403 });
	if (!event || !delivery) return Response.json({
		accepted: false,
		reason: "missing X-GitHub-Event or X-GitHub-Delivery",
		ingressMs
	}, { status: 400 });
	if (event === "ping") return Response.json({
		accepted: true,
		pong: true,
		verified: true,
		ingressMs,
		delivery
	}, { status: 202 });
	if (!ALLOWED_EVENTS.has(event)) return Response.json({
		accepted: true,
		verified: true,
		skip: "event ignored",
		ingressMs,
		delivery,
		event
	}, { status: 202 });
	return Response.json({
		accepted: true,
		verified: true,
		queued: false,
		note: "HMAC verified. Worker enqueue lives on the Operations tapes — this endpoint does not enqueue.",
		ingressMs,
		delivery,
		event
	}, { status: 202 });
} } } });
var $$splitComponentImporter = () => import("./jobs._id-D9_3ENtn.mjs");
var Route = createFileRoute("/jobs/$id")({ component: lazyRouteComponent($$splitComponentImporter, "component") });
var rootRouteChildren = {
	IndexRoute: Route$7.update({
		id: "/",
		path: "/",
		getParentRoute: () => Route$8
	}),
	InboxRoute: Route$6.update({
		id: "/inbox",
		path: "/inbox",
		getParentRoute: () => Route$8
	}),
	PlaygroundRoute: Route$5.update({
		id: "/playground",
		path: "/playground",
		getParentRoute: () => Route$8
	}),
	PoliciesRoute: Route$4.update({
		id: "/policies",
		path: "/policies",
		getParentRoute: () => Route$8
	}),
	ReviewsRoute: Route$3.update({
		id: "/reviews",
		path: "/reviews",
		getParentRoute: () => Route$8
	}),
	SettingsRoute: Route$2.update({
		id: "/settings",
		path: "/settings",
		getParentRoute: () => Route$8
	}),
	ApiWebhookRoute: Route$1.update({
		id: "/api/webhook",
		path: "/api/webhook",
		getParentRoute: () => Route$8
	}),
	JobsIdRoute: Route.update({
		id: "/jobs/$id",
		path: "/jobs/$id",
		getParentRoute: () => Route$8
	})
};
var routeTree = Route$8._addFileChildren(rootRouteChildren)._addFileTypes();
var router_exports = /* @__PURE__ */ __exportAll({ getRouter: () => getRouter });
function getRouter() {
	return createRouter({
		routeTree,
		defaultErrorComponent: AppErrorComponent
	});
}
//#endregion
export { useAshlar as i, Route as n, signHub256 as r, router_exports as t };
