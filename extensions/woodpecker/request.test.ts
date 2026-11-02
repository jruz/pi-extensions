import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestError, requestJson, retryDelay } from "./request.ts";

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn<typeof sleep>().mockResolvedValue(undefined),
}));

const url = new URL("https://ci.example.test/api/repos");
const report = vi.fn<(message: string) => void>();
const fetchMock = vi.fn<typeof fetch>();
const request = (signal: AbortSignal) => requestJson(url, {}, signal, report);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("Woodpecker request retries", () => {
  it("recovers from a transient HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const response = Response.json({ id: 7 });
    fetchMock.mockResolvedValueOnce(response);
    const result = request(new AbortController().signal);
    await expect(result).resolves.toEqual({
      id: 7,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const delays = vi.mocked(sleep).mock.calls.map(([delay]) => delay);
    expect(delays).toEqual([1000]);
    expect(report).toHaveBeenCalledWith(
      "woodpecker: HTTP 503; retry 1/4 in 1000ms",
    );
  });

  it("stops after four exponentially delayed retries", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 502 })),
    );
    const result = request(new AbortController().signal);
    await expect(result).rejects.toThrow("woodpecker: HTTP 502");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const delays = vi.mocked(sleep).mock.calls.map(([delay]) => delay);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %i", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    const result = request(new AbortController().signal);
    await expect(result).rejects.toThrow(`woodpecker: HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors Retry-After on rate limits", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
    );
    const response = Response.json([]);
    fetchMock.mockResolvedValueOnce(response);
    await request(new AbortController().signal);
    const delays = vi.mocked(sleep).mock.calls.map(([delay]) => delay);
    expect(delays).toEqual([30000]);
  });

  it("retries network failures without exposing their messages", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("private upstream details"));
    const response = Response.json([]);
    fetchMock.mockResolvedValueOnce(response);
    await request(new AbortController().signal);
    expect(report).toHaveBeenCalledWith(
      "woodpecker: network failure; retry 1/4 in 1000ms",
    );
  });

  it("retries request timeouts", async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException("timeout", "TimeoutError"),
    );
    const response = Response.json([]);
    fetchMock.mockResolvedValueOnce(response);
    const timeout = AbortSignal.abort();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout);
    await request(new AbortController().signal);
    expect(report).toHaveBeenCalledWith(
      "woodpecker: request timeout; retry 1/4 in 1000ms",
    );
  });

  it("does not retry invalid JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not JSON"));
    const result = request(new AbortController().signal);
    await expect(result).rejects.toThrow("woodpecker: invalid JSON");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a cancelled request", async () => {
    const signal = AbortSignal.abort();
    const result = request(signal);
    await expect(result).rejects.toThrow("This operation was aborted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry when cancelled during fetch", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new TypeError("cancelled"));
    });
    const result = request(controller.signal);
    await expect(result).rejects.toThrow("This operation was aborted");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("cancels the retry wait without making another request", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    vi.mocked(sleep).mockImplementationOnce((_delay, _value, options) => {
      const signal = options?.signal;
      if (signal === undefined) throw new Error("missing signal");
      controller.abort();
      signal.throwIfAborted();
      return Promise.resolve();
    });
    const result = request(controller.signal);
    await expect(result).rejects.toThrow("This operation was aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("retry delays and diagnostics", () => {
  it("adds jitter", () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const delay = retryDelay(null, 0);
    expect(delay).toBe(1125);
  });

  it("accepts HTTP dates", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const delay = retryDelay("Thu, 01 Jan 2026 00:00:30 GMT", 0);
    expect(delay).toBe(30000);
  });

  it("rejects malformed Retry-After", () => {
    expect(() => retryDelay("invalid", 0)).toThrow(
      "woodpecker: invalid Retry-After",
    );
  });

  it("exposes only safe diagnostic messages", () => {
    const safe = requestError(new Error("woodpecker: HTTP 503"));
    const privateError = requestError(new Error("private upstream details"));
    expect(safe).toBe("woodpecker: HTTP 503");
    expect(privateError).not.toContain("private upstream details");
  });
});
