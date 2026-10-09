import { describe, expect, it } from "vitest";
import { formatPeers, formatReceived, type AgentRecord } from "./protocol.ts";

const peer = (id: string, status: AgentRecord["status"]): AgentRecord => ({
  id,
  instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  projectPath: "/home/user/dev/projects/tools",
  status,
});

describe("messenger peers", () => {
  it("shows full IDs, full paths, and live presence for distinct conversations", () => {
    const peers = [
      peer("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "idle"),
      peer("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "busy"),
    ];
    const output = formatPeers(peers);
    expect(output).toBe(
      "id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nproject: /home/user/dev/projects/tools\nstatus: idle\n\nid: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\nproject: /home/user/dev/projects/tools\nstatus: busy",
    );
  });

  it("reports an empty online peer list", () => {
    const output = formatPeers([]);
    expect(output).toBe("No online peers.");
  });

  it("formats replies using the sender path carried by the message", () => {
    const text = formatReceived({
      id: "11111111-1111-4111-8111-111111111111",
      senderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      senderProjectPath: "/project/A",
      recipientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      priority: "normal",
      message: "ACK",
      replyTo: "22222222-2222-4222-8222-222222222222",
      sentAt: 0,
    });
    expect(text).toContain("project: /project/A");
    expect(text).toContain("reply-to: 22222222-2222-4222-8222-222222222222");
  });
});
