// The actual enforcement behind `gates/limits.ts`'s size cap (ADR §B.5):
// `Content-Length` is only ever a hint (`limits.ts#contentLengthExceeds`) —
// this reads the body incrementally and refuses once the cap is crossed,
// which also matters for a `Content-Encoding: gzip` request, since Cloudflare
// Workers do not auto-decompress an *incoming* request body (unlike a
// `fetch()` *response*): the wire bytes could be small while the decompressed
// bytes blow the cap, exactly the gzip-bomb shape a hint on the compressed
// size cannot catch.

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Reads `req`'s body, transparently gunzipping when `Content-Encoding`
 *  names `gzip`, refusing (throwing {@link BodyTooLargeError}) once the
 *  decompressed byte count exceeds `maxBytes`. Reads only as much of the
 *  stream as it takes to detect the overflow — it does not first buffer the
 *  whole thing and check after. */
export async function readCappedBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);

  const encoding = req.headers.get("content-encoding");
  const stream = encoding?.toLowerCase().includes("gzip")
    ? req.body.pipeThrough(new DecompressionStream("gzip"))
    : req.body;

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readCappedText(req: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(req, maxBytes));
}
