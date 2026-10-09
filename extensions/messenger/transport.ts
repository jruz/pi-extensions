import { mkdir, readdir, rm, stat } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Socket,
  type Server,
} from "node:net";
import { join } from "node:path";
import { z } from "zod";
import {
  conversationIdSchema,
  requestSchema,
  responseSchema,
  REQUEST_TIMEOUT_MS,
  type AgentRecord,
  type ConversationId,
  type MessageRecord,
  type TransportRequest,
  type TransportResponse,
} from "./protocol.ts";

const socketPath = (directory: string, id: ConversationId): string =>
  join(directory, `${conversationIdSchema.parse(id)}.sock`);

const readFrame = async (socket: Socket): Promise<unknown> => {
  const frame = { content: "" };
  socket.setEncoding("utf8");
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
    const error = new Error("messenger: recipient did not respond");
    socket.destroy(error);
  });
  const text = await new Promise<string>((resolve, reject) => {
    socket.on("data", (chunk: string) => {
      frame.content += chunk;
      const end = frame.content.indexOf("\n");
      if (end === -1) return;
      const content = frame.content.slice(0, end);
      resolve(content);
    });
    socket.once("error", reject);
    socket.once("end", () => {
      const error = new Error("messenger: incomplete response");
      reject(error);
    });
  });
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new Error("messenger: invalid transport JSON", { cause: error });
  }
};

const exchange = async (
  path: string,
  payload: TransportRequest,
): Promise<TransportResponse> => {
  const socket = createConnection(path);
  const frame = readFrame(socket);
  socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
  try {
    const body = await frame;
    const result = responseSchema.parse(body);
    if (result.type === "error") throw new Error(result.message);
    return result;
  } finally {
    socket.destroy();
  }
};

const connectionError = (error: unknown): string | undefined => {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  if (!parsed.success) return undefined;
  return parsed.data.code;
};

const endpointInode = async (path: string): Promise<number | undefined> => {
  try {
    const metadata = await stat(path);
    return metadata.ino;
  } catch (error) {
    if (connectionError(error) !== "ENOENT") throw error;
    return undefined;
  }
};

const removeEndpoint = async (path: string, inode: number): Promise<void> => {
  if ((await endpointInode(path)) !== inode) return;
  await rm(path, { force: true });
};

const liveAgent = async (
  directory: string,
  id: ConversationId,
): Promise<AgentRecord | undefined> => {
  const path = socketPath(directory, id);
  const inode = await endpointInode(path);
  try {
    const response = await exchange(path, { action: "me" });
    if (response.type !== "identity" || response.agent.id !== id)
      throw new Error(`messenger: invalid peer identity: ${id}`);
    return response.agent;
  } catch (error) {
    const code = connectionError(error);
    if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    if (inode === undefined) return undefined;
    const current = await endpointInode(path);
    if (current === undefined) return undefined;
    if (current !== inode) return liveAgent(directory, id);
    await removeEndpoint(path, inode);
    return undefined;
  }
};

const listen = async (server: Server, path: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
};

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const accept = (
  receive: (instanceId: string, message: MessageRecord) => void,
  instanceId: string,
  message: MessageRecord,
): TransportResponse => {
  receive(instanceId, message);
  return { type: "accepted" };
};

export const createTransport = (
  directory: string,
  reportError: (error: unknown) => void,
) => {
  const servers = new Map<Server, Readonly<{ path: string; inode: number }>>();
  const peers = async (): Promise<readonly AgentRecord[]> => {
    const files = await readdir(directory);
    const ids = files
      .filter((file) => file.endsWith(".sock"))
      .map((file) => {
        const id = file.slice(0, -5);
        return conversationIdSchema.parse(id);
      });
    const discovered = ids.map((id) => liveAgent(directory, id));
    const agents = await Promise.all(discovered);
    return agents.filter((agent) => agent !== undefined);
  };
  return {
    start: async (
      identity: () => AgentRecord,
      receive: (instanceId: string, message: MessageRecord) => void,
    ): Promise<void> => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await peers();
      const agent = identity();
      const previous = await liveAgent(directory, agent.id);
      if (previous !== undefined)
        throw new Error(`messenger: conversation already online: ${agent.id}`);
      const server = createServer((socket) => {
        const respond = async (): Promise<void> => {
          try {
            const body = await readFrame(socket);
            const payload = requestSchema.parse(body);
            const result: TransportResponse =
              payload.action === "me"
                ? { type: "identity", agent: identity() }
                : accept(receive, payload.instanceId, payload.message);
            socket.end(`${JSON.stringify(result)}\n`);
          } catch (error) {
            reportError(error);
            const message =
              error instanceof Error ? error.message : String(error);
            socket.end(`${JSON.stringify({ type: "error", message })}\n`);
          }
        };
        respond().catch(reportError);
      });
      const path = socketPath(directory, agent.id);
      await listen(server, path);
      server.on("error", reportError);
      const metadata = await stat(path);
      servers.set(server, { path, inode: metadata.ino });
    },
    peers,
    identity: async (id: ConversationId): Promise<AgentRecord> => {
      const agent = await liveAgent(directory, id);
      if (agent === undefined)
        throw new Error(`messenger: recipient offline: ${id}`);
      return agent;
    },
    send: async (
      recipient: AgentRecord,
      message: MessageRecord,
    ): Promise<void> => {
      const path = socketPath(directory, recipient.id);
      const response = await exchange(path, {
        action: "receive",
        instanceId: recipient.instanceId,
        message,
      });
      if (response.type !== "accepted")
        throw new Error("messenger: recipient did not accept message");
    },
    stop: async (): Promise<void> => {
      const entries = servers.entries();
      const running = Array.from(entries);
      servers.clear();
      const stopped = running.map(async ([server, endpoint]) => {
        await close(server);
        await removeEndpoint(endpoint.path, endpoint.inode);
      });
      await Promise.all(stopped);
    },
  };
};

export type MessengerTransport = ReturnType<typeof createTransport>;
