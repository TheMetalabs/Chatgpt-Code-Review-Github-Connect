/** Instant-tier replies often dump findings:[] with no file-level check. */
export function findingsJsonTooThin(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { findings?: unknown; investigated_safe?: unknown };
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    if (findings.length > 0) return false;
    const safe = Array.isArray(parsed.investigated_safe) ? parsed.investigated_safe : [];
    return safe.filter((x) => String(x || "").trim()).length < 1;
  } catch {
    return true;
  }
}
