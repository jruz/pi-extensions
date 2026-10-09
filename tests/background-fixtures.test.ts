import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { log } from "./fixtures/background/log.ts";

const temporaryDirectory = tmpdir();
const fixtureDirectory = join(import.meta.dirname, "fixtures/background");
const fastFixture = join(fixtureDirectory, "fast.ts");
const stubbornFixture = join(fixtureDirectory, "stubborn.ts");
const captureFixture = join(fixtureDirectory, "capture.ts");
const workerFixture = join(fixtureDirectory, "worker.ts");
const execFileAsync = promisify(execFile);
const bufferSchema = z.instanceof(Buffer);
const outputEventSchema = z.tuple([bufferSchema]);
const captureFailureSchema = z.object({ error: z.string().max(256) });
const captureMetadata = z.object({
  availableFrom: z.number().int().nonnegative(),
  availableTo: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
  finished: z.boolean(),
});

const readOutput = async (child: ChildProcess): Promise<string> => {
  if (child.stdout === null) throw new Error("fixture stdout: required");
  try {
    const signal = AbortSignal.timeout(3000);
    const event = await once(child.stdout, "data", { signal });
    const [chunk] = outputEventSchema.parse(event);
    return chunk.toString("utf8");
  } catch (error) {
    log.error(`fixture output: ${String(error)}`);
    throw error;
  }
};

const stopFixture = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    const closed = once(child, "close", { signal: AbortSignal.timeout(3000) });
    if (!child.kill("SIGKILL"))
      throw new Error("fixture stop: signal not sent");
    await closed;
  } catch (error) {
    log.error(`fixture stop: ${String(error)}`);
    throw error;
  }
};

describe("background fixtures under native Node", () => {
  it("preserves fast initial/final output and exit status", async () => {
    try {
      await execFileAsync(process.execPath, [fastFixture]);
      throw new Error("fast fixture: expected exit 3");
    } catch (error) {
      expect(error).toMatchObject({
        code: 3,
        stdout: "fast-start\nfast-final\n",
        stderr: "",
      });
    }
  });

  it("keeps the resistant worker alive after SIGTERM and SIGINT", async () => {
    const child = spawn(process.execPath, [stubbornFixture]);
    try {
      const initialOutput = await readOutput(child);
      expect(initialOutput).toBe(`pid=${child.pid}\n`);
      await setTimeout(100);
      expect(child.exitCode).toBeNull();
      const termOutput = readOutput(child);
      const termSent = child.kill("SIGTERM");
      expect(termSent).toBe(true);
      const termMessage = await termOutput;
      expect(termMessage).toBe("ignored-term\n");
      const intOutput = readOutput(child);
      const intSent = child.kill("SIGINT");
      expect(intSent).toBe(true);
      const intMessage = await intOutput;
      expect(intMessage).toBe("ignored-int\n");
      expect(child.exitCode).toBeNull();
    } finally {
      await stopFixture(child);
    }
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("bounds persistent capture and reports discarded bytes", async () => {
    const prefix = join(temporaryDirectory, "background-capture-");
    const directory = await mkdtemp(prefix);
    const logPath = join(directory, "output.log");
    const metadataPath = join(directory, "metadata.json");
    const capacity = 4096;
    const data = Buffer.from(`startup\n${"x".repeat(256 * 1024)}\nfinal=雪\n`);
    const expectedData = data.subarray(-capacity);
    const capacityValue = String(capacity);
    const execution = execFileAsync(
      process.execPath,
      [captureFixture, logPath, metadataPath, capacityValue],
      { timeout: 3000, killSignal: "SIGKILL" },
    );
    try {
      if (execution.child.stdin === null)
        throw new Error("capture stdin: required");
      execution.child.stdin.end(data);
      await expect(execution).resolves.toMatchObject({
        stdout: "",
        stderr: "",
      });
      const firstRead = await readFile(logPath);
      const secondRead = await readFile(logPath);
      expect(firstRead).toEqual(expectedData);
      expect(secondRead).toEqual(expectedData);
      const metadataText = await readFile(metadataPath, "utf8");
      const metadataValue: unknown = JSON.parse(metadataText);
      const metadata = captureMetadata.parse(metadataValue);
      expect(metadata).toEqual({
        availableFrom: data.byteLength - capacity,
        availableTo: data.byteLength,
        capacity,
        finished: true,
      });
      const logStat = await stat(logPath);
      const metadataStat = await stat(metadataPath);
      expect(logStat.size).toBe(capacity);
      expect(logStat.mode & 0o777).toBe(0o600);
      expect(metadataStat.mode & 0o777).toBe(0o600);
    } finally {
      await stopFixture(execution.child);
      await rm(directory, { recursive: true });
    }
  });

  it("surfaces capture write failures", async () => {
    const prefix = join(temporaryDirectory, "background-capture-failure-");
    const directory = await mkdtemp(prefix);
    const logPath = join(directory, "missing/output.log");
    const metadataPath = join(directory, "metadata.json");
    const execution = execFileAsync(
      process.execPath,
      [captureFixture, logPath, metadataPath, "4096"],
      { timeout: 3000, killSignal: "SIGKILL" },
    );
    try {
      if (execution.child.stdin === null)
        throw new Error("capture stdin: required");
      execution.child.stdin.end("startup\n");
      await expect(execution).rejects.toMatchObject({ code: 1 });
      const failureMessage: unknown = expect.stringContaining(
        "capture failure: Error: ENOENT",
      );
      await expect(execution).rejects.toHaveProperty("stderr", failureMessage);
      const metadataText = await readFile(metadataPath, "utf8");
      const metadataValue: unknown = JSON.parse(metadataText);
      const metadata = captureFailureSchema.parse(metadataValue);
      expect(metadata.error).toContain("ENOENT");
    } finally {
      await stopFixture(execution.child);
      await rm(directory, { recursive: true });
    }
  });

  it("handles literal input and records a final marker before exit", async () => {
    const prefix = join(temporaryDirectory, "background-node-fixture-");
    const directory = await mkdtemp(prefix);
    const outputPath = join(directory, "events.log");
    const text = `Enter C-c; $(touch never-created) 'quoted' \\ 雪`;
    const execution = execFileAsync(
      process.execPath,
      [workerFixture, outputPath],
      { timeout: 3000, killSignal: "SIGKILL" },
    );
    try {
      if (execution.child.stdin === null)
        throw new Error("fixture stdin: required");
      execution.child.stdin.end(`${text}\nexit\n`);
      await expect(execution).rejects.toMatchObject({ code: 7, stderr: "" });
      const output = await readFile(outputPath, "utf8");
      expect(output).toContain(`cwd=${process.cwd()}\n`);
      expect(output).toContain("ready\n");
      expect(output).toContain(`input=${JSON.stringify(text)}\n`);
      expect(output).toContain("final\n");
      const outputStat = await stat(outputPath);
      expect(outputStat.mode & 0o777).toBe(0o600);
    } finally {
      await stopFixture(execution.child);
      await rm(directory, { recursive: true });
    }
  });
});
