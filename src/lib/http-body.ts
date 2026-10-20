/** Hard cap on a webhook request body, for memory safety. GitHub caps a delivery at 25 MB, but a
 * real PR event is far smaller: PR, issue and comment bodies are each capped by GitHub at 65,536
 * characters (≤ ~256 KB of UTF-8 even for all-Hangul text). 5 MiB leaves an order of magnitude of
 * headroom over the largest realistic event while bounding what one request can buffer. The old
 * 64 KiB cap silently dropped every event of a PR whose description alone was 85 KB (#107). */
export const MAX_WEBHOOK_BODY = 5 * 1024 * 1024;

export type CappedBody =
  | { ok: true; body: string }
  /** bytes: the declared Content-Length, or how many bytes had arrived when the cap was crossed. */
  | { ok: false; reason: "payload too large"; bytes: number };

export async function readBodyCapped(request: Request, max = MAX_WEBHOOK_BODY): Promise<CappedBody> {
  const raw = request.headers.get("content-length");
  if (raw != null && raw !== "") {
    const declared = Number(raw);
    if (Number.isFinite(declared) && declared > max) {
      await request.body?.cancel().catch(() => {});
      return { ok: false, reason: "payload too large", bytes: declared };
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
      return { ok: false, reason: "payload too large", bytes: total };
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
