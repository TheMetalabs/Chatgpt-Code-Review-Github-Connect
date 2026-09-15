export function composerAccepted(got: string, text: string): boolean {
  const g = String(got || "").replace(/\s+/g, " ").trim();
  const want = String(text || "").replace(/\s+/g, " ").trim();
  if (!want) return false;
  if (want.length <= 48) return g.includes(want);
  return (
    g.includes(want.slice(0, 48)) &&
    g.includes(want.slice(-40)) &&
    g.length >= Math.floor(want.length * 0.85)
  );
}
