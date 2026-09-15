export const MAX_WEBHOOK_BODY = 65_536;

export type CappedBody = { ok: true; body: string } | { ok: false; reason: "payload too large" };

export async function readBodyCapped(request: Request, max = MAX_WEBHOOK_BODY): Promise<CappedBody> {
  const raw = request.headers.get("content-length");
  if (raw != null && raw !== "") {
    const declared = Number(raw);
    if (Number.isFinite(declared) && declared > max) {
      return { ok: false, reason: "payload too large" };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, body: "" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { ok: false, reason: "payload too large" };
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(buf) };
}
