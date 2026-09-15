export const BRIDGE_TOKEN_ENV = "ASHLAR_BRIDGE_TOKEN";

export function resolveBridgeToken(
  envVal: string | undefined,
  generate: () => string,
): { token: string; persist: boolean } {
  const t = String(envVal ?? "").trim();
  if (t) return { token: t, persist: false };
  return { token: generate(), persist: true };
}
