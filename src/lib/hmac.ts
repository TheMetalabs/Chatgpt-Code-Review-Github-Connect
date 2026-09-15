export async function signHub256(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length !== 64 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyHub256(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  const token = header.split(",")[0]?.trim() ?? "";
  if (!token.startsWith("sha256=")) return false;
  const provided = hexToBytes(token.slice("sha256=".length));
  if (!provided) return false;
  const expectedHeader = await signHub256(secret, body);
  const expected = hexToBytes(expectedHeader.slice("sha256=".length));
  if (!expected || expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ provided[i];
  return mismatch === 0;
}
