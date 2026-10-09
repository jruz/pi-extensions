import { writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "./log.ts";

const [logPath, metadataPath, capacityValue] = process.argv.slice(2);
if (logPath === undefined) throw new Error("log path: required");
if (metadataPath === undefined) throw new Error("metadata path: required");
if (capacityValue === undefined) throw new Error("capacity: required");
const capacity = Number(capacityValue);
if (!Number.isSafeInteger(capacity) || capacity < 1)
  throw new Error("capacity: positive integer required");

type Capture = Readonly<{ data: Buffer; totalBytes: number }>;
const initialData = Buffer.alloc(0);
const initialCapture = { data: initialData, totalBytes: 0 };
const captures = new Map<string, Capture>([["current", initialCapture]]);

const save = async (capture: Capture, finished: boolean): Promise<void> => {
  await writeFile(logPath, capture.data, { mode: 0o600 });
  const metadata = JSON.stringify({
    availableFrom: capture.totalBytes - capture.data.byteLength,
    availableTo: capture.totalBytes,
    capacity,
    finished,
  });
  await writeFile(metadataPath, metadata, { mode: 0o600 });
};

const captureChunk = async (chunk: unknown): Promise<void> => {
  if (!Buffer.isBuffer(chunk))
    throw new Error("capture chunk: buffer required");
  const previous = captures.get("current");
  if (previous === undefined) throw new Error("capture state: required");
  const next = {
    data: Buffer.concat([previous.data, chunk]).subarray(-capacity),
    totalBytes: previous.totalBytes + chunk.byteLength,
  };
  await save(next, false);
  captures.set("current", next);
};

const sink = new Writable({
  highWaterMark: 64 * 1024,
  write(chunk: unknown, _encoding, callback) {
    captureChunk(chunk).then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      },
    );
  },
});

try {
  await pipeline(process.stdin, sink);
  const capture = captures.get("current");
  if (capture === undefined) throw new Error("capture state: required");
  await save(capture, true);
} catch (error) {
  const message = String(error);
  log.error(`capture failure: ${message}`);
  const metadata = JSON.stringify({ error: message.slice(0, 256) });
  await writeFile(metadataPath, metadata, { mode: 0o600 });
  throw error;
}
