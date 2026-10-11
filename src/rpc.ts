// A small JSON-RPC client for a keyless public Solana endpoint: one request at a time per lane, paced, with
// back-off on 429 and transient failures. Everything in this project reads from here; nothing signs or sends.

export const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Rpc {
  private next = 0;
  calls = 0;
  readonly url: string;
  readonly gapMs: number;

  constructor(url: string = RPC_URL, gapMs = 300) {
    this.url = url;
    this.gapMs = gapMs;
  }

  async call<T>(method: string, params: unknown[], timeoutMs = 120_000): Promise<T> {
    let lastErr = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const wait = this.next - Date.now();
      if (wait > 0) await sleep(wait);
      this.next = Date.now() + this.gapMs;
      this.calls++;
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // 413 is the public endpoint's "data allowance used" (about 100 MB per 30 s per IP): wait it out.
        if (res.status === 429 || res.status === 413 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          lastErr = `HTTP ${res.status}`;
          const floor = res.status === 413 ? 45_000 : 2000;
          this.next = Date.now() + Math.max(retryAfter * 1000, floor * 2 ** Math.min(attempt, 4));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error) {
          // -32005 node behind / rate limited, -32603 internal: worth another try. Anything else is our mistake.
          if ([-32005, -32603, -32004, -32014, -32016, -32019].includes(body.error.code)) {
            lastErr = body.error.message;
            this.next = Date.now() + 1500 * 2 ** attempt;
            continue;
          }
          throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
        }
        return body.result as T;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/^HTTP 4|^\w+: -32/.test(msg)) throw e;
        lastErr = msg;
        this.next = Date.now() + 1500 * 2 ** attempt;
      }
    }
    throw new Error(`${method} failed after retries: ${lastErr}`);
  }
}
