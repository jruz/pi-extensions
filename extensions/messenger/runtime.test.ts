import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createRuntime, type MessengerRuntime } from "./runtime.ts";
import { createTransport } from "./transport.ts";
import {
  messageIdSchema,
  type AgentRecord,
  type MessageRecord,
} from "./protocol.ts";

const cleanups: (() => Promise<void>)[] = [];

const createPeer = async (directory: string, id: string, errors: unknown[]) => {
  const agent: AgentRecord = {
    id,
    instanceId: randomUUID(),
    projectPath: "/same/project",
    status: "idle",
  };
  const activity = { idle: true, failDelivery: false };
  const delivered: Readonly<{ text: string; mode: "steer" | "followUp" }>[] =
    [];
  const transport = createTransport(directory, (error) => errors.push(error));
  const runtime = createRuntime({
    agent,
    transport,
    isIdle: () => activity.idle,
    deliver: (text, mode) => {
      if (activity.failDelivery) throw new Error("test: injection failed");
      delivered.push({ text, mode });
    },
  });
  await runtime.start();
  const readUser = () => {
    const user = delivered.map((entry) => entry.text);
    runtime.recordContext({ user, tool: [] });
  };
  return { agent, runtime, activity, delivered, readUser, transport };
};

type Peer = Awaited<ReturnType<typeof createPeer>>;

const setup = async () => {
  const temporaryRoot = tmpdir();
  const prefix = join(temporaryRoot, "msg-");
  const directory = await mkdtemp(prefix);
  const runtimes: MessengerRuntime[] = [];
  const errors: unknown[] = [];
  cleanups.push(async () => {
    const stops = runtimes.map((runtime) => runtime.stop());
    await Promise.all(stops);
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (id: string) => {
    const peer = await createPeer(directory, id, errors);
    runtimes.push(peer.runtime);
    return peer;
  };
  const leftId = randomUUID();
  const rightId = randomUUID();
  const left = await start(leftId);
  const right = await start(rightId);
  return { directory, start, left, right, errors };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const incomingId = (text: string): string => {
  const marker = /^message-id: (.+)$/m.exec(text);
  return messageIdSchema.parse(marker?.[1]);
};

const sendMessage = (from: Peer, to: Peer, text: string) =>
  from.runtime.send(to.agent.id, text, "normal", undefined);

const reply = (test: Fixture, id: string, text: string) =>
  test.right.runtime.send(test.left.agent.id, text, "normal", id);

const readCheckpoint = (peer: Peer, text: string): void => {
  peer.runtime.recordContext({ user: [], tool: [text] });
};

const originalMessage = async (test: Fixture): Promise<string> => {
  await sendMessage(test.left, test.right, "question");
  await test.right.runtime.poll();
  test.right.readUser();
  const first = test.right.delivered[0];
  if (first === undefined) throw new Error("test: no delivery");
  test.right.activity.idle = false;
  return incomingId(first.text);
};

afterEach(async () => {
  const pending = cleanups.splice(0);
  const actions = pending.map((cleanup) => cleanup());
  await Promise.all(actions);
});

describe("ephemeral messenger", () => {
  it("discovers only running conversations, excluding itself", async () => {
    const test = await setup();
    const idle = await test.left.runtime.peers();
    expect(idle).toEqual([test.right.agent]);
    test.right.activity.idle = false;
    const busy = await test.left.runtime.peers();
    expect(busy).toEqual([{ ...test.right.agent, status: "busy" }]);
    await test.right.runtime.stop();
    const stopped = await test.left.runtime.peers();
    expect(stopped).toEqual([]);
    const files = await readdir(test.directory);
    expect(files).toEqual([`${test.left.agent.id}.sock`]);
  });

  it("wakes an idle agent once with a full incoming message", async () => {
    const test = await setup();
    const result = await sendMessage(test.left, test.right, "hello");
    expect(result).toEqual({
      type: "sent",
      text: `to: ${test.right.agent.id}\nproject: /same/project\npriority: normal\nmessage:\nhello`,
    });
    await test.right.runtime.poll();
    await test.right.runtime.poll();
    expect(test.right.delivered).toHaveLength(1);
    expect(test.right.delivered[0]).toMatchObject({ mode: "followUp" });
    expect(test.right.delivered[0]?.text).toContain(
      `from: ${test.left.agent.id}\nproject: /same/project`,
    );
    expect(test.right.delivered[0]?.text).toContain("Read the messenger skill");
    const history = test.right.runtime.history(20, 0);
    expect(history).toContain("received queued");
  });

  it("holds busy normal messages and delivers them together in order when idle", async () => {
    const test = await setup();
    test.right.activity.idle = false;
    await sendMessage(test.left, test.right, "first");
    await test.right.runtime.poll();
    await sendMessage(test.left, test.right, "second");
    await test.right.runtime.poll();
    expect(test.right.delivered).toEqual([]);
    test.right.activity.idle = true;
    await test.right.runtime.poll();
    expect(test.right.delivered).toHaveLength(1);
    const text = test.right.delivered[0]?.text;
    if (text === undefined) throw new Error("test: no normal batch");
    expect(text).toContain("first");
    expect(text).toContain("second");
    const first = text.indexOf("first");
    const second = text.indexOf("second");
    expect(first).toBeLessThan(second);
  });

  it("withholds a reply, returns all waiting messages, then sends the revised reply", async () => {
    const test = await setup();
    const id = await originalMessage(test);
    await sendMessage(test.left, test.right, "also test errors");
    await sendMessage(test.left, test.right, "skip the slow suite");
    await test.right.runtime.poll();
    const draft = await reply(test, id, "all tests pass");
    expect(draft.type).toBe("withheld");
    expect(draft.text).toContain("Message NOT sent.");
    expect(draft.text).toContain("also test errors");
    expect(draft.text).toContain("skip the slow suite");
    const before = test.left.runtime.history(20, 0);
    expect(before).not.toContain("all tests pass");
    await test.left.runtime.poll();
    expect(test.left.delivered).toEqual([]);
    readCheckpoint(test.right, draft.text);
    const revised = await reply(
      test,
      id,
      "error tests pass; slow suite skipped",
    );
    expect(revised.type).toBe("sent");
    await test.left.runtime.poll();
    expect(test.left.delivered).toHaveLength(1);
    expect(test.left.delivered[0]?.text).toContain(`reply-to: ${id}`);
    expect(test.left.delivered[0]?.text).toContain(
      "error tests pass; slow suite skipped",
    );
    const after = test.left.runtime.history(20, 0);
    expect(after).toContain("sent acknowledged");
    expect(test.right.delivered).toHaveLength(1);
  });

  it("keeps oversized waiting batches blocked until every output part is read", async () => {
    const test = await setup();
    const id = await originalMessage(test);
    const body = "x".repeat(7900);
    const requests = Array.from({ length: 8 }, (_, index) =>
      sendMessage(test.left, test.right, `${index}: ${body}`),
    );
    await Promise.all(requests);
    const first = await reply(test, id, "draft");
    expect(first.type).toBe("withheld");
    expect(first.text).toContain("part 1 of 2");
    const firstBytes = Buffer.byteLength(first.text);
    expect(firstBytes).toBeLessThan(50 * 1024);
    readCheckpoint(test.right, first.text);
    const second = await reply(test, id, "draft");
    expect(second.type).toBe("withheld");
    expect(second.text).toContain("part 2 of 2");
    const secondBytes = Buffer.byteLength(second.text);
    expect(secondBytes).toBeLessThan(50 * 1024);
    const history = test.left.runtime.history(20, 0);
    expect(history).not.toContain("draft");
    readCheckpoint(test.right, second.text);
    const sent = await reply(test, id, "reviewed all eight");
    expect(sent.type).toBe("sent");
  });

  it("pages newline-heavy messages without releasing a draft early", async () => {
    const test = await setup();
    const id = await originalMessage(test);
    const text = "x\n".repeat(3000);
    await sendMessage(test.left, test.right, text);
    const first = await reply(test, id, "draft");
    expect(first.type).toBe("withheld");
    const lines = first.text.split("\n");
    expect(lines.length).toBeLessThan(2000);
    readCheckpoint(test.right, first.text);
    const second = await reply(test, id, "draft");
    expect(second.type).toBe("withheld");
    readCheckpoint(test.right, second.text);
    const sent = await reply(test, id, "reviewed");
    expect(sent.type).toBe("sent");
  });

  it("shows unread messages before failing an unavailable reply destination", async () => {
    const test = await setup();
    const id = await originalMessage(test);
    await sendMessage(test.left, test.right, "last update");
    await test.left.runtime.stop();
    const draft = await reply(test, id, "draft");
    expect(draft.type).toBe("withheld");
    expect(draft.text).toContain("last update");
    readCheckpoint(test.right, draft.text);
    const retry = reply(test, id, "reviewed");
    await expect(retry).rejects.toThrow("recipient offline");
  });

  it("does not bypass the checkpoint using send instead of reply", async () => {
    const test = await setup();
    await originalMessage(test);
    await sendMessage(test.left, test.right, "new instruction");
    const draft = await sendMessage(test.right, test.left, "old answer");
    expect(draft.type).toBe("withheld");
    const history = test.left.runtime.history(20, 0);
    expect(history).not.toContain("old answer");
  });

  it("does not send a repeated draft until the checkpoint batch reaches model context", async () => {
    const test = await setup();
    const id = await originalMessage(test);
    await sendMessage(test.left, test.right, "update");
    const first = await reply(test, id, "draft");
    const second = await reply(test, id, "draft");
    expect(first.type).toBe("withheld");
    expect(second.type).toBe("withheld");
    readCheckpoint(test.right, second.text);
    const third = await reply(test, id, "revised");
    expect(third.type).toBe("sent");
  });

  it("checks again when more messages arrive after a blocked reply", async () => {
    const test = await setup();
    const id = await originalMessage(test);
    await sendMessage(test.left, test.right, "update one");
    const first = await reply(test, id, "draft");
    readCheckpoint(test.right, first.text);
    await sendMessage(test.left, test.right, "update two");
    const second = await reply(test, id, "revised");
    expect(second.type).toBe("withheld");
    expect(second.text).toContain("update two");
    expect(second.text).not.toContain("update one");
  });

  it("steers busy urgent messages while retaining normal messages", async () => {
    const test = await setup();
    test.right.activity.idle = false;
    await sendMessage(test.left, test.right, "normal");
    await test.left.runtime.send(
      test.right.agent.id,
      "urgent",
      "urgent",
      undefined,
    );
    await test.right.runtime.poll();
    expect(test.right.delivered).toHaveLength(1);
    expect(test.right.delivered[0]).toMatchObject({ mode: "steer" });
    expect(test.right.delivered[0]?.text).toContain("message:\nurgent");
    const draft = await sendMessage(test.right, test.left, "answer");
    expect(draft.type).toBe("withheld");
    expect(draft.text).toContain("message:\nnormal");
    expect(draft.text).toContain("message:\nurgent");
  });

  it("includes injected messages in the checkpoint until their actual batch reaches context", async () => {
    const test = await setup();
    await test.left.runtime.send(
      test.right.agent.id,
      "urgent",
      "urgent",
      undefined,
    );
    await test.right.runtime.poll();
    const entry = test.right.delivered[0];
    if (entry === undefined) throw new Error("test: no urgent delivery");
    const marker = incomingId(entry.text);
    test.right.runtime.recordContext({ user: [marker], tool: [] });
    const blocked = await sendMessage(test.right, test.left, "answer");
    expect(blocked.type).toBe("withheld");
    test.right.readUser();
    const sent = await sendMessage(test.right, test.left, "updated");
    expect(sent.type).toBe("sent");
  });

  it("does not consume waiting messages when their marker is quoted", async () => {
    const test = await setup();
    test.right.activity.idle = false;
    await sendMessage(test.left, test.right, "waiting");
    const history = test.right.runtime.history(20, 0);
    const match = / id=([^ ]+)/.exec(history);
    const id = messageIdSchema.parse(match?.[1]);
    test.right.runtime.recordContext({ user: [`message-id: ${id}`], tool: [] });
    const draft = await sendMessage(test.right, test.left, "answer");
    expect(draft.type).toBe("withheld");
  });

  it("drops pending messages and history on restart of the same conversation", async () => {
    const test = await setup();
    test.right.activity.idle = false;
    await sendMessage(test.left, test.right, "discard me");
    await test.right.runtime.stop();
    const restarted = await test.start(test.right.agent.id);
    await restarted.runtime.poll();
    expect(restarted.delivered).toEqual([]);
    const history = restarted.runtime.history(20, 0);
    expect(history).toContain("Showing 0 of 0");
    const peers = await test.left.runtime.peers();
    expect(peers).toEqual([restarted.agent]);
  });

  it("fails clearly for offline or unknown recipients without retaining messages", async () => {
    const test = await setup();
    await test.right.runtime.stop();
    const offline = sendMessage(test.left, test.right, "offline");
    await expect(offline).rejects.toThrow("recipient offline");
    const unknownId = randomUUID();
    const unknown = test.left.runtime.send(
      unknownId,
      "unknown",
      "normal",
      undefined,
    );
    await expect(unknown).rejects.toThrow("recipient offline");
    const history = test.left.runtime.history(20, 0);
    expect(history).toContain("Showing 0 of 0");
  });

  it("rejects duplicate live owners and does not affect the existing runtime", async () => {
    const test = await setup();
    const duplicate = test.start(test.right.agent.id);
    await expect(duplicate).rejects.toThrow("already online");
    const peers = await test.left.runtime.peers();
    expect(peers).toEqual([test.right.agent]);
  });

  it("rejects a stale runtime identity instead of sending to a replacement", async () => {
    const test = await setup();
    const previous = await test.left.transport.identity(test.right.agent.id);
    await test.right.runtime.stop();
    await test.start(test.right.agent.id);
    const message: MessageRecord = {
      id: randomUUID(),
      senderId: test.left.agent.id,
      senderProjectPath: "/same/project",
      recipientId: test.right.agent.id,
      message: "stale",
      priority: "normal",
      sentAt: Date.now(),
    };
    const stale = test.left.transport.send(previous, message);
    await expect(stale).rejects.toThrow("runtime replaced");
    expect(test.errors).toHaveLength(1);
  });

  it("rejects shortened IDs, self sends, and invalid reply links", async () => {
    const test = await setup();
    const shortenedId = test.right.agent.id.slice(0, 8);
    const shortened = test.left.runtime.send(
      shortenedId,
      "hello",
      "normal",
      undefined,
    );
    await expect(shortened).rejects.toThrow(ZodError);
    const self = sendMessage(test.left, test.left, "self");
    await expect(self).rejects.toThrow("yourself");
    const unknownReply = randomUUID();
    const invalid = test.left.runtime.send(
      test.right.agent.id,
      "reply",
      "normal",
      unknownReply,
    );
    await expect(invalid).rejects.toThrow("reply target");
    const empty = sendMessage(test.left, test.right, "");
    await expect(empty).rejects.toThrow(ZodError);
    const oversizedText = "x".repeat(8001);
    const oversized = sendMessage(test.left, test.right, oversizedText);
    await expect(oversized).rejects.toThrow(ZodError);
  });

  it("does not duplicate overlapping polls and retries failed injection", async () => {
    const test = await setup();
    await sendMessage(test.left, test.right, "hello");
    test.right.activity.failDelivery = true;
    const failed = test.right.runtime.poll();
    await expect(failed).rejects.toThrow("injection failed");
    test.right.activity.failDelivery = false;
    const first = test.right.runtime.poll();
    const second = test.right.runtime.poll();
    await Promise.all([first, second]);
    expect(test.right.delivered).toHaveLength(1);
    expect(test.right.delivered[0]?.text).toContain("Read the messenger skill");
    await test.right.runtime.stop();
    await test.right.runtime.poll();
    await test.right.runtime.stop();
    expect(test.right.delivered).toHaveLength(1);
  });

  it("allows simultaneous bidirectional sends without a transport deadlock", async () => {
    const test = await setup();
    const left = sendMessage(test.left, test.right, "left");
    const right = sendMessage(test.right, test.left, "right");
    await Promise.all([left, right]);
    const leftHistory = test.left.runtime.history(1, 1);
    expect(leftHistory).toContain("Showing 1 of 2; offset=1");
    const rightHistory = test.right.runtime.history(20, 0);
    expect(rightHistory).toContain("Showing 2 of 2");
  });
});
