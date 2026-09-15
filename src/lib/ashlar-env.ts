/** Hostname / public URL helpers. Values come from env only — never hardcode a real host. */

export function parseHostList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    let h = part.trim().toLowerCase();
    if (!h) continue;
    if (/^https?:\/\//.test(h)) {
      try {
        const u = new URL(h);
        if (u.username || u.password) continue;
        h = u.hostname;
      } catch {
        continue;
      }
    } else {
      h = h.replace(/\/.*$/, "").replace(/:\d+$/, "");
    }
    if (!h || h.length > 253) continue;
    if (h.includes("/") || h.includes("\\") || h.includes("..") || h.includes("@")) continue;
    if (!/^[a-z0-9.*-]+$/.test(h)) continue;
    out.push(h);
  }
  return [...new Set(out)];
}

export function ashlarPublicHost(env: NodeJS.Dict<string> = process.env): string {
  return parseHostList(env.ASHLAR_PUBLIC_HOST)[0] ?? "";
}

export function ashlarAllowedHosts(env: NodeJS.Dict<string> = process.env): string[] {
  const hosts = parseHostList(env.ASHLAR_ALLOWED_HOSTS);
  const pub = ashlarPublicHost(env);
  if (pub && !hosts.includes(pub)) hosts.push(pub);
  return hosts;
}

export function ashlarWebhookUrl(env: NodeJS.Dict<string> = process.env): string {
  const host = ashlarPublicHost(env);
  return host ? `https://${host}/api/webhook` : "";
}
