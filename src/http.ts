import { REQUEST_TIMEOUT_MS, USER_AGENT } from "./config.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

async function fetchOnce(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: controller.signal,
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      throw new HttpError(`request to ${new URL(url).host} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, undefined, url);
    }
    throw new HttpError(`network error reaching ${new URL(url).host}: ${e.message}`, undefined, url);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with a 10s timeout and a single retry (with jitter, honoring
 * Retry-After) on timeout or 429/502/503/504. Never loops beyond 2 attempts.
 */
export async function httpGetText(url: string, headers: Record<string, string> = {}): Promise<string> {
  let res: Response;
  const isLastAttempt = (attempt: number) => attempt === 1;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchOnce(url, headers);
    } catch (err) {
      if (err instanceof HttpError && err.message.includes("timed out") && !isLastAttempt(attempt)) {
        await sleep(300 + Math.floor(Math.random() * 400));
        continue;
      }
      throw err;
    }
    if (RETRYABLE_STATUS.has(res.status) && !isLastAttempt(attempt)) {
      await res.body?.cancel().catch(() => {});
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : 800 + Math.floor(Math.random() * 700);
      await sleep(waitMs);
      continue;
    }
    break;
  }
  if (!res.ok) {
    const hint = res.status === 429 ? " (rate limited — setting POKEMONTCG_API_KEY raises the limit)" : "";
    await res.body?.cancel().catch(() => {});
    throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}${hint}`, res.status, url);
  }
  return res.text();
}

export async function httpGetJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const text = await httpGetText(url, { Accept: "application/json", ...headers });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(`invalid JSON from ${new URL(url).host}`, undefined, url);
  }
}
