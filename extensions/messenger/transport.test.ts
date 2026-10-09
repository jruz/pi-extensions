import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTransport } from "./transport.ts";
import type { AgentRecord } from "./protocol.ts";

const cleanups: (() => Promise<void>)[] = [];

const crashEndpoint = async (directory: string, id: string): Promise<void> => {
  const path = join(directory, `${id}.sock`);
  const child = spawn(process.execPath, [
    "--eval",
    `import { createServer } from "node:net"; createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("ready"));`,
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => {
        resolve();
      });
      child.once("error", reject);
    });
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
};
const setup = async () => {
  const temporaryRoot = tmpdir();
  const prefix = join(temporaryRoot, "msg-");
  const directory = await mkdtemp(prefix);
  const errors: unknown[] = [];
  const transport = createTransport(directory, (error) => errors.push(error));
  const agent: AgentRecord = {
    id: randomUUID(),
    instanceId: randomUUID(),
    projectPath: "/project",
    status: "idle",
  };
  cleanups.push(async () => {
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, errors, transport, agent };
};

afterEach(async () => {
  const pending = cleanups.splice(0);
  const actions = pending.map((cleanup) => cleanup());
  await Promise.all(actions);
});

describe("live messenger transport", () => {
  it("prunes crashed endpoints during discovery without storing agent metadata", async () => {
    const test = await setup();
    await test.transport.start(
      () => test.agent,
      () => undefined,
    );
    const crashedId = randomUUID();
    await crashEndpoint(test.directory, crashedId);
    const peers = await test.transport.peers();
    expect(peers).toEqual([test.agent]);
    const files = await readdir(test.directory);
    expect(files).toEqual([`${test.agent.id}.sock`]);
    expect(test.errors).toEqual([]);
  });

  it("reclaims a crashed endpoint on startup", async () => {
    const test = await setup();
    await crashEndpoint(test.directory, test.agent.id);
    await test.transport.start(
      () => test.agent,
      () => undefined,
    );
    const identity = await test.transport.identity(test.agent.id);
    expect(identity).toEqual(test.agent);
    await test.transport.stop();
    const files = await readdir(test.directory);
    expect(files).toEqual([]);
  });

  it("rejects concurrent owners through the socket bind", async () => {
    const test = await setup();
    const second = createTransport(test.directory, (error) =>
      test.errors.push(error),
    );
    cleanups.push(() => second.stop());
    const results = await Promise.allSettled([
      test.transport.start(
        () => test.agent,
        () => undefined,
      ),
      second.start(
        () => ({ ...test.agent, instanceId: randomUUID() }),
        () => undefined,
      ),
    ]);
    const started = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
