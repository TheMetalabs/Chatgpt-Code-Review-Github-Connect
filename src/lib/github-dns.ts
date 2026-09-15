/** Parse Cloudflare/Google DNS-over-HTTPS JSON for the first A record. */
export function parseDohA(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { Answer?: { type?: number; data?: string }[] };
    const row = json.Answer?.find((a) => a.type === 1 && typeof a.data === "string" && isIpv4(a.data));
    return row?.data;
  } catch {
    return undefined;
  }
}

export function isIpv4(s: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split(".").every((p) => Number(p) <= 255);
}
