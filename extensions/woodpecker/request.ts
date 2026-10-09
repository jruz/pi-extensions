import { setTimeout as sleep } from "node:timers/promises";
import { ZodError } from "zod";

export const requestError = (error: unknown): string => {
  if (error instanceof ZodError) return "woodpecker: invalid API response";
  if (
    error instanceof Error &&
    /^woodpecker: (HTTP [1-5]\d{2}|network failure|request timeout|invalid JSON|invalid Retry-After)$/.test(
      error.message,
    )
  )
    return error.message;
  return "woodpecker: request failed; check connectivity, configuration and API permissions";
};

export const retryDelay = (header: string | null, attempt: number): number => {
  const backoff = 1000 * 2 ** attempt * (1 + Math.random() * 0.25);
  if (header === null) return backoff;
  const delay = /^\d+$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(delay))
    throw new Error("woodpecker: invalid Retry-After");
  return Math.max(backoff, delay);
};

const failureMessage = (timedOut: boolean, error: unknown): string => {
  if (timedOut) return "woodpecker: request timeout";
  if (error instanceof SyntaxError) return "woodpecker: invalid JSON";
  return "woodpecker: network failure";
};

const wait = async (delay: number, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  if (delay > 2147483647) {
    await sleep(2147483647, undefined, { signal });
    return wait(delay - 2147483647, signal);
  }
  await sleep(delay, undefined, { signal });
};

export const requestJson = async (
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<unknown> => {
  const attemptRequest = async (attempt: number): Promise<unknown> => {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(15000);
    const outcome = await (async () => {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.any([signal, timeout]),
          redirect: "error",
        });
        if (!response.ok) {
          const retryAfter = response.headers.get("Retry-After");
          await response.body?.cancel();
          return {
            type: "failure" as const,
            message: `woodpecker: HTTP ${response.status}`,
            retryable: response.status === 429 || response.status >= 500,
            retryAfter,
          };
        }
        const data: unknown = await response.json();
        return { type: "success" as const, data };
      } catch (error) {
        signal.throwIfAborted();
        return {
          type: "failure" as const,
          message: failureMessage(timeout.aborted, error),
          retryable: timeout.aborted || error instanceof TypeError,
          retryAfter: null,
        };
      }
    })();
    if (outcome.type === "success") return outcome.data;
    if (!outcome.retryable || attempt === 4) throw new Error(outcome.message);
    const delay = retryDelay(outcome.retryAfter, attempt);
    report(
      `${outcome.message}; retry ${attempt + 1}/4 in ${Math.ceil(delay)}ms`,
    );
    await wait(delay, signal);
    return attemptRequest(attempt + 1);
  };
  return attemptRequest(0);
};
