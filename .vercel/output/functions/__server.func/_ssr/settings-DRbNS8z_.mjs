import { b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { i as useAshlar } from "./router-Cie5IrZk.mjs";
import { t as Button } from "./button-B2EtUDbO.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/settings-DRbNS8z_.js
var import_jsx_runtime = require_jsx_runtime();
function Settings() {
	const settings = useAshlar((s) => s.settings);
	const setSettings = useAshlar((s) => s.setSettings);
	const resetDemo = useAshlar((s) => s.resetDemo);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto max-w-3xl px-4 py-8 md:px-8",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle",
				children: "Settings"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "mt-2 text-3xl font-medium tracking-tight",
				children: "Bot constitution"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-2 text-sm leading-relaxed text-fg-muted",
				children: "YAML in the design, knobs here. These steer ingress and the poster on this tab. Reset and refresh restore defaults."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
				className: "mt-8 space-y-5",
				onSubmit: (e) => e.preventDefault(),
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "bot.username",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							value: settings.username,
							onChange: (e) => setSettings({ username: e.target.value }),
							className: "h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "mentions",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							value: settings.mention.join(", "),
							onChange: (e) => setSettings({ mention: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }),
							className: "h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "grid gap-4 sm:grid-cols-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
								label: "skip_forks",
								checked: settings.skipForks,
								onChange: (v) => setSettings({ skipForks: v })
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
								label: "skip_drafts",
								checked: settings.skipDrafts,
								onChange: (v) => setSettings({ skipDrafts: v })
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
								label: "precision_over_recall",
								checked: settings.precisionOverRecall,
								onChange: (v) => setSettings({ precisionOverRecall: v })
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "grid gap-4 sm:grid-cols-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "publish_min_severity",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
									value: settings.publishMinSeverity,
									onChange: (e) => setSettings({ publishMinSeverity: e.target.value }),
									className: "h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { children: "P0" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { children: "P1" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { children: "P2" })
									]
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "request_changes_min",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
									value: settings.requestChangesMin,
									onChange: (e) => setSettings({ requestChangesMin: e.target.value }),
									className: "h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { children: "P0" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { children: "P1" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { children: "P2" })
									]
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "max_inline_comments",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									type: "number",
									min: 0,
									max: 20,
									value: settings.maxInlineComments,
									onChange: (e) => setSettings({ maxInlineComments: Number(e.target.value) }),
									className: "h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Field, {
						label: "github.webhook_secret (demo signer)",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "password",
							autoComplete: "off",
							value: settings.webhookSecret,
							onChange: (e) => setSettings({ webhookSecret: e.target.value }),
							className: "h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-2 text-[12px] text-fg-subtle",
							children: "Signs the live ping only. Worker simulation uses the HMAC toggle on Operations / Inbox — not this string."
						})]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
				className: "mt-8 overflow-x-auto rounded-xl border border-line bg-bg-elevated p-4 font-mono text-[12px] leading-6 text-fg-muted",
				children: `bot:
  username: ${settings.username}
  mention: [${settings.mention.map((m) => `"${m}"`).join(", ")}]
limits:
  max_inline_comments: ${settings.maxInlineComments}
policy:
  precision_over_recall: ${settings.precisionOverRecall}
  publish_min_severity: ${settings.publishMinSeverity}
  request_changes_min: ${settings.requestChangesMin}
github:
  skip_forks: ${settings.skipForks}
  skip_drafts: ${settings.skipDrafts}`
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
				variant: "secondary",
				className: "mt-6",
				onClick: resetDemo,
				children: "Reset demo tape"
			})
		]
	});
}
function Field({ label, children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
		className: "block",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle",
			children: label
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "mt-2",
			children
		})]
	});
}
function Toggle({ label, checked, onChange }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		"aria-pressed": checked,
		onClick: () => onChange(!checked),
		className: "flex h-11 items-center justify-between rounded-md border border-line bg-bg-elevated px-3 text-left text-sm",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "font-mono text-[12px]",
			children: label
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: checked ? "text-ok" : "text-fg-subtle",
			children: checked ? "true" : "false"
		})]
	});
}
//#endregion
export { Settings as component };
