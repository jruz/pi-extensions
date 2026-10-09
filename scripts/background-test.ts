import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import {
  isJsonObject,
  parseJson,
  readNumber,
} from "../extensions/shared/validation.ts";
import { log } from "./lib/log.ts";

type Probe = Readonly<{
  directory: string;
  socket: string;
  controlSocket: string;
  groups: Set<number>;
  processes: Set<number>;
  servers: Map<string, number>;
}>;

const execute = promisify(execFile);
const fixture = resolve(
  import.meta.dirname,
  "../tests/fixtures/background/fast.ts",
);

const tmux = async (
  socket: string,
  args: readonly string[],
): Promise<string> => {
  try {
    const result = await execute(
      "tmux",
      ["-f", "/dev/null", "-S", socket, ...args],
      {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      },
    );
    return result.stdout.trim();
  } catch (error) {
    log.error(`tmux test: ${String(error)}`);
    throw error;
  }
};

const waitFor = async (
  predicate: () => Promise<boolean>,
  attempts: number,
): Promise<void> => {
  if (await predicate()) return;
  if (attempts === 0) throw new Error("host observation: timed out");
  await setTimeout(100);
  return waitFor(predicate, attempts - 1);
};

const groupExists = (group: number): boolean => {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (isJsonObject(error) && error["code"] === "ESRCH") return false;
    log.error(`owned group: ${String(error)}`);
    throw error;
  }
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isJsonObject(error) && error["code"] === "ESRCH") return false;
    log.error(`owned process: ${String(error)}`);
    throw error;
  }
};

const stopProcess = async (pid: number): Promise<void> => {
  if (!processExists(pid)) return;
  process.kill(pid, "SIGKILL");
  const exited = (): Promise<boolean> => Promise.resolve(!processExists(pid));
  await waitFor(exited, 50);
};

const stopGroup = async (group: number): Promise<void> => {
  if (!groupExists(group)) return;
  process.kill(-group, "SIGKILL");
  const exited = (): Promise<boolean> => Promise.resolve(!groupExists(group));
  await waitFor(exited, 50);
};

const recordGroup = async (probe: Probe, pidText: string): Promise<number> => {
  const pid = Number(pidText);
  const validPid = Number.isSafeInteger(pid) && pid > 1;
  assert.ok(validPid);
  const result = await execute("ps", ["-o", "pgid=", "-p", pidText], {
    timeout: 5000,
  });
  const groupText = result.stdout.trim();
  const group = Number(groupText);
  assert.equal(group, pid);
  probe.groups.add(group);
  return group;
};

const startServer = async (probe: Probe, socket: string): Promise<void> => {
  const pidText = await tmux(socket, [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    "anchor",
    "sleep",
    "60",
  ]);
  await recordGroup(probe, pidText);
  const serverPidText = await tmux(socket, ["display-message", "-p", "#{pid}"]);
  const serverPid = Number(serverPidText);
  const validPid = Number.isSafeInteger(serverPid) && serverPid > 1;
  assert.ok(validPid);
  probe.servers.set(socket, serverPid);
  await tmux(socket, ["set-option", "-g", "remain-on-exit", "on"]);
};

const stopServer = async (probe: Probe, socket: string): Promise<void> => {
  const files = await readdir(probe.directory);
  const name = basename(socket);
  if (!files.includes(name)) return;
  await tmux(socket, ["kill-server"]);
  const serverPid = probe.servers.get(socket);
  if (serverPid === undefined) throw new Error("server PID: required");
  const exited = (): Promise<boolean> => {
    const gone = !processExists(serverPid);
    return Promise.resolve(gone);
  };
  await waitFor(exited, 50);
};

const cleanup = async (probe: Probe): Promise<void> => {
  const groups = Array.from(probe.groups);
  const groupStops = groups.map(stopGroup);
  const groupResults = await Promise.allSettled(groupStops);
  const sockets = [probe.socket, probe.controlSocket];
  const stop = (socket: string): Promise<void> => stopServer(probe, socket);
  const serverStops = sockets.map(stop);
  const serverResults = await Promise.allSettled(serverStops);
  const processStops = Array.from(probe.processes).map(stopProcess);
  const processResults = await Promise.allSettled(processStops);
  const failures = [
    ...groupResults,
    ...serverResults,
    ...processResults,
  ].flatMap((result) => {
    if (result.status === "fulfilled") return [];
    const failure: unknown = result.reason;
    return [failure];
  });
  if (failures.length !== 0) {
    failures.forEach((failure) => {
      log.error(`host cleanup: ${String(failure)}`);
    });
    throw new AggregateError(failures, "host cleanup failed");
  }
  await rm(probe.directory, { recursive: true });
};

const createProbe = async (): Promise<Probe> => {
  const temporaryDirectory = tmpdir();
  const prefix = join(temporaryDirectory, "pi-background-host-test-'%雪-");
  const directory = await mkdtemp(prefix);
  return {
    directory,
    socket: join(directory, "owned.sock"),
    controlSocket: join(directory, "control.sock"),
    groups: new Set<number>(),
    processes: new Set<number>(),
    servers: new Map<string, number>(),
  };
};

const fastExit = async (probe: Probe): Promise<void> => {
  await tmux(probe.socket, [
    "new-session",
    "-d",
    "-s",
    "fast",
    process.execPath,
    fixture,
  ]);
  const exited = async (): Promise<boolean> => {
    const dead = await tmux(probe.socket, [
      "display-message",
      "-p",
      "-t",
      "fast",
      "#{pane_dead}",
    ]);
    return dead === "1";
  };
  await waitFor(exited, 50);
  const status = await tmux(probe.socket, [
    "display-message",
    "-p",
    "-t",
    "fast",
    "#{pane_dead_status}",
  ]);
  const output = await tmux(probe.socket, [
    "capture-pane",
    "-p",
    "-t",
    "fast",
    "-S",
    "-",
  ]);
  assert.equal(status, "3");
  assert.match(output, /fast-start/);
  assert.match(output, /fast-final/);
  await tmux(probe.socket, ["kill-session", "-t", "fast"]);
};

const startResistant = async (probe: Probe): Promise<number> => {
  const command =
    'read -r launch; trap "" HUP TERM INT; printf "resistant-ready\\n"; sleep 60 & wait';
  const pidText = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    "resistant",
    "bash",
    "--noprofile",
    "--norc",
    "-c",
    command,
  ]);
  const group = await recordGroup(probe, pidText);
  await tmux(probe.socket, [
    "send-keys",
    "-l",
    "-t",
    "resistant",
    "--",
    "start",
  ]);
  await tmux(probe.socket, ["send-keys", "-t", "resistant", "Enter"]);
  const ready = async (): Promise<boolean> => {
    const output = await tmux(probe.socket, [
      "capture-pane",
      "-p",
      "-t",
      "resistant",
    ]);
    return output.includes("resistant-ready");
  };
  await waitFor(ready, 50);
  return group;
};

const resistantCleanup = async (probe: Probe, group: number): Promise<void> => {
  process.kill(-group, "SIGTERM");
  await setTimeout(100);
  const survivedTerm = groupExists(group);
  assert.equal(survivedTerm, true);
  await tmux(probe.socket, ["kill-session", "-t", "resistant"]);
  const survivedPaneRemoval = groupExists(group);
  assert.equal(survivedPaneRemoval, true);
  await stopGroup(group);
};

const fixturePath = (name: string): string =>
  resolve(import.meta.dirname, `../tests/fixtures/background/${name}.ts`);

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const readOwnedFile = async (path: string): Promise<string> => {
  const directory = resolve(path, "..");
  const files = await readdir(directory);
  const name = basename(path);
  if (!files.includes(name)) return "";
  return readFile(path, "utf8");
};

const awaitText = async (path: string, text: string): Promise<void> => {
  const contains = async (): Promise<boolean> => {
    const contents = await readOwnedFile(path);
    return contents.includes(text);
  };
  await waitFor(contains, 50);
};

const paneStatus = async (probe: Probe, name: string): Promise<string> => {
  const exited = async (): Promise<boolean> => {
    const dead = await tmux(probe.socket, [
      "display-message",
      "-p",
      "-t",
      name,
      "#{pane_dead}",
    ]);
    return dead === "1";
  };
  await waitFor(exited, 50);
  return tmux(probe.socket, [
    "display-message",
    "-p",
    "-t",
    name,
    "#{pane_dead_status}",
  ]);
};

const captureProbe = async (
  probe: Probe,
  name: string,
  status: string,
  injectFailure: boolean,
  pauseCollector: boolean,
): Promise<void> => {
  const label = pauseCollector ? `${name}-paused` : name;
  const gate = join(probe.directory, `${label}.gate`);
  const output = join(probe.directory, `${label}.log`);
  const metadata = join(probe.directory, `${label}.json`);
  await execute("mkfifo", ["--mode=600", gate]);
  const workload = fixturePath(name);
  const capture = fixturePath("capture");
  const pid = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    name,
    "-c",
    probe.directory,
    "bash",
    "--noprofile",
    "--norc",
    "-c",
    'IFS= read -r launch < "$1"; shift; exec "$@"',
    "background-gate",
    gate,
    process.execPath,
    workload,
  ]);
  await recordGroup(probe, pid);
  const collector = [process.execPath, capture, output, metadata, "4096"];
  const collectorCommand = collector.map(quote).join(" ");
  const pidPath = join(probe.directory, `${label}.collector.pid`);
  const quotedPidPath = quote(pidPath);
  const ownedCollector = `echo "$$" > ${quotedPidPath}; exec ${collectorCommand}`;
  const escapedCommand = ownedCollector.replaceAll("%", "%%");
  await tmux(probe.socket, ["pipe-pane", "-O", "-t", name, escapedCommand]);
  await awaitText(pidPath, "\n");
  const collectorPidText = await readFile(pidPath, "utf8");
  const collectorPidValue = collectorPidText.trim();
  const collectorPid = Number(collectorPidValue);
  const validCollectorPid =
    Number.isSafeInteger(collectorPid) && collectorPid > 1;
  assert.ok(validCollectorPid);
  probe.processes.add(collectorPid);
  if (injectFailure) throw new Error("injected capture failure");
  if (pauseCollector) process.kill(collectorPid, "SIGSTOP");
  await writeFile(gate, "start\n");
  if (pauseCollector) {
    await setTimeout(300);
    const pausedStatus = await tmux(probe.socket, [
      "display-message",
      "-p",
      "-t",
      name,
      "#{pane_dead}",
    ]);
    assert.equal(pausedStatus, "0");
    const pausedOutput = await readOwnedFile(output);
    assert.equal(pausedOutput, "");
    process.kill(collectorPid, "SIGCONT");
  }
  const actualStatus = await paneStatus(probe, name);
  assert.equal(actualStatus, status);
  await awaitText(output, `${name}-final`);
  const firstRead = await readFile(output);
  const secondRead = await readFile(output);
  assert.deepEqual(firstRead, secondRead);
  if (name === "fast") {
    const text = firstRead.toString();
    assert.match(text, /fast-start/);
  }
  await tmux(probe.socket, ["kill-session", "-t", name]);
  await awaitText(metadata, '"finished":true');
  const collectorExited = (): Promise<boolean> => {
    const gone = !processExists(collectorPid);
    return Promise.resolve(gone);
  };
  await waitFor(collectorExited, 50);
  const metadataText = await readFile(metadata, "utf8");
  const value = parseJson(metadataText);
  const validMetadata = isJsonObject(value);
  assert.ok(validMetadata);
  const from = readNumber(value, "availableFrom");
  const to = readNumber(value, "availableTo");
  const capacity = readNumber(value, "capacity");
  assert.equal(capacity, 4096);
  assert.equal(to - from, firstRead.byteLength);
  if (name === "flood") {
    assert.ok(from > 0);
    assert.equal(firstRead.byteLength, capacity);
  }
  const outputStat = await stat(output);
  const metadataStat = await stat(metadata);
  const directoryStat = await stat(probe.directory);
  assert.equal(outputStat.mode & 0o777, 0o600);
  assert.equal(metadataStat.mode & 0o777, 0o600);
  assert.equal(directoryStat.mode & 0o777, 0o700);
};

const sendText = async (
  probe: Probe,
  name: string,
  text: string,
): Promise<void> => {
  await tmux(probe.socket, ["send-keys", "-l", "-t", name, "--", text]);
  await tmux(probe.socket, ["send-keys", "-t", name, "Enter"]);
};

const attachDetach = async (probe: Probe): Promise<void> => {
  const command = [
    "tmux",
    "-f",
    "/dev/null",
    "-S",
    probe.socket,
    "attach-session",
    "-t",
    "input",
  ];
  const shellCommand = command.map(quote).join(" ");
  const shellResult = await execute("which", ["bash"]);
  const shell = shellResult.stdout.trim();
  assert.notEqual(shell, "");
  const attachment = execute(
    "script",
    ["--quiet", "--return", "--command", shellCommand, "/dev/null"],
    {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, TERM: "xterm-256color", SHELL: shell },
    },
  );
  const completion = attachment.then(
    () => ({ error: undefined }),
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "unknown failure";
      log.error(`attachment: ${message}`);
      return { error };
    },
  );
  const attached = async (): Promise<boolean> => {
    const clients = await tmux(probe.socket, [
      "list-clients",
      "-t",
      "input",
      "-F",
      "#{client_session}",
    ]);
    return clients === "input";
  };
  try {
    await waitFor(attached, 40);
    await tmux(probe.socket, ["detach-client", "-s", "input"]);
    const result = await completion;
    if (result.error !== undefined) {
      throw new Error("attachment: failed", { cause: result.error });
    }
  } finally {
    attachment.child.kill("SIGKILL");
    await completion;
  }
};

const inputProbe = async (probe: Probe): Promise<void> => {
  const output = join(probe.directory, "input.events");
  const pid = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    "input",
    "-c",
    probe.directory,
    process.execPath,
    fixturePath("worker"),
    output,
  ]);
  const group = await recordGroup(probe, pid);
  await awaitText(output, "ready\n");
  const text = `Enter C-c; $(touch never-created) 'quoted' \\ 雪`;
  await sendText(probe, "input", text);
  const literalMarker = `input=${JSON.stringify(text)}`;
  await awaitText(output, literalMarker);
  await tmux(probe.socket, ["send-keys", "-t", "input", "C-c"]);
  await awaitText(output, "sigint\n");
  await attachDetach(probe);
  const alive = groupExists(group);
  assert.equal(alive, true);
  await sendText(probe, "input", "after-detach");
  await awaitText(output, 'input="after-detach"');
  await sendText(probe, "input", "exit");
  const status = await paneStatus(probe, "input");
  assert.equal(status, "7");
  await awaitText(output, "final\n");
  const files = await readdir(probe.directory);
  const executed = files.includes("never-created");
  assert.equal(executed, false);
  await tmux(probe.socket, ["kill-session", "-t", "input"]);
};

const contextProbe = async (probe: Probe): Promise<void> => {
  await tmux(probe.socket, [
    "set-environment",
    "-g",
    "AGENT_CONFIG_PHASE1_TEST_MARKER",
    "first",
  ]);
  await tmux(probe.socket, [
    "set-option",
    "-g",
    "update-environment",
    "AGENT_CONFIG_PHASE1_TEST_MARKER",
  ]);
  const output = join(probe.directory, "context.json");
  await execute(
    "tmux",
    [
      "-f",
      "/dev/null",
      "-S",
      probe.socket,
      "new-session",
      "-d",
      "-E",
      "-s",
      "context",
      "-c",
      probe.directory,
      process.execPath,
      fixturePath("launch-context"),
      output,
    ],
    {
      timeout: 5000,
      env: { ...process.env, AGENT_CONFIG_PHASE1_TEST_MARKER: "later" },
    },
  );
  const status = await paneStatus(probe, "context");
  assert.equal(status, "0");
  const contents = await readFile(output, "utf8");
  const actual = parseJson(contents);
  assert.deepEqual(actual, { cwd: probe.directory, marker: "first" });
  await tmux(probe.socket, ["kill-session", "-t", "context"]);
  const contextFixture = fixturePath("launch-context");
  const cwd = process.cwd();
  await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-s",
    "override",
    "-c",
    cwd,
    "-e",
    "AGENT_CONFIG_PHASE1_TEST_MARKER=later",
    process.execPath,
    contextFixture,
    output,
  ]);
  const overrideStatus = await paneStatus(probe, "override");
  assert.equal(overrideStatus, "0");
  const overriddenText = await readFile(output, "utf8");
  const overridden = parseJson(overriddenText);
  assert.deepEqual(overridden, { cwd, marker: "later" });
  await tmux(probe.socket, ["kill-session", "-t", "override"]);
  await tmux(probe.socket, ["set-option", "-g", "update-environment", ""]);
};

const eofProbe = async (probe: Probe): Promise<void> => {
  const output = join(probe.directory, "eof.events");
  const worker = fixturePath("worker");
  const pid = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    "eof",
    process.execPath,
    worker,
    output,
  ]);
  await recordGroup(probe, pid);
  await awaitText(output, "ready\n");
  await tmux(probe.socket, ["send-keys", "-t", "eof", "C-d"]);
  const status = await paneStatus(probe, "eof");
  assert.equal(status, "0");
  await tmux(probe.socket, ["kill-session", "-t", "eof"]);
};

const interruptedCapture = async (): Promise<void> => {
  const probe = await createProbe();
  try {
    await startServer(probe, probe.socket);
    await startServer(probe, probe.controlSocket);
    await captureProbe(probe, "fast", "3", true, false);
  } finally {
    await cleanup(probe);
  }
};

const boundaryProbe = async (
  probe: Probe,
  detached: boolean,
): Promise<void> => {
  const name = detached ? "detached" : "normal";
  const pidPath = join(probe.directory, `${name}.child.pid`);
  const launch = detached ? "setsid sleep 60" : "sleep 60";
  const command = `read -r launch; ${launch} & echo "$!" > "$1"; wait`;
  const pid = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    name,
    "bash",
    "--noprofile",
    "--norc",
    "-c",
    command,
    "boundary",
    pidPath,
  ]);
  await recordGroup(probe, pid);
  await sendText(probe, name, "start");
  await awaitText(pidPath, "\n");
  const childText = await readFile(pidPath, "utf8");
  const childValue = childText.trim();
  const childPid = Number(childValue);
  const validChildPid = Number.isSafeInteger(childPid) && childPid > 1;
  assert.ok(validChildPid);
  probe.processes.add(childPid);
  const groupResult = await execute("ps", [
    "-o",
    "pgid=",
    "-p",
    String(childPid),
  ]);
  const childGroupValue = groupResult.stdout.trim();
  const childGroup = Number(childGroupValue);
  const expectedGroup = detached ? childPid : Number(pid);
  assert.equal(childGroup, expectedGroup);
  await tmux(probe.socket, ["kill-session", "-t", name]);
  if (detached) {
    const survived = processExists(childPid);
    assert.equal(survived, true);
    await stopProcess(childPid);
    return;
  }
  const exited = (): Promise<boolean> =>
    Promise.resolve(!processExists(childPid));
  await waitFor(exited, 50);
};

const foregroundProbe = async (probe: Probe): Promise<void> => {
  const pidPath = join(probe.directory, "foreground.pid");
  const workload = 'trap "" HUP TERM INT; echo "$$" > "$1"; sleep 60 & wait';
  const quotedWorkload = quote(workload);
  const quotedPath = quote(pidPath);
  const command = `read -r launch; bash --noprofile --norc -c ${quotedWorkload} worker ${quotedPath}; :`;
  const pidText = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    "foreground",
    "bash",
    "--noprofile",
    "--norc",
    "-i",
    "-c",
    command,
  ]);
  const launchGroup = await recordGroup(probe, pidText);
  await sendText(probe, "foreground", "start");
  await awaitText(pidPath, "\n");
  const workerText = await readFile(pidPath, "utf8");
  const workerPid = workerText.trim();
  const foregroundGroup = await recordGroup(probe, workerPid);
  assert.notEqual(foregroundGroup, launchGroup);
  const terminalResult = await execute("ps", [
    "-o",
    "sid=,tpgid=",
    "-p",
    pidText,
  ]);
  const terminalFields = terminalResult.stdout.trim().split(/\s+/).map(Number);
  assert.deepEqual(terminalFields, [launchGroup, foregroundGroup]);
  const workerResult = await execute("ps", ["-o", "sid=", "-p", workerPid]);
  const workerSessionText = workerResult.stdout.trim();
  const workerSession = Number(workerSessionText);
  assert.equal(workerSession, launchGroup);
  await tmux(probe.socket, ["kill-session", "-t", "foreground"]);
  const survived = groupExists(foregroundGroup);
  assert.equal(survived, true);
  await stopGroup(launchGroup);
  const survivedLaunchEscalation = groupExists(foregroundGroup);
  assert.equal(survivedLaunchEscalation, true);
  await stopGroup(foregroundGroup);
};

const captureFailureProbe = async (probe: Probe): Promise<void> => {
  const metadata = join(probe.directory, "failure.json");
  const output = join(probe.directory, "missing/output.log");
  const command =
    "read -r launch; echo healthy-ready; read -r input; echo healthy-input; read -r finish";
  const pid = await tmux(probe.socket, [
    "new-session",
    "-d",
    "-E",
    "-P",
    "-F",
    "#{pane_pid}",
    "-s",
    "failure",
    "bash",
    "--noprofile",
    "--norc",
    "-c",
    command,
  ]);
  const group = await recordGroup(probe, pid);
  const collector = [
    process.execPath,
    fixturePath("capture"),
    output,
    metadata,
    "4096",
  ];
  const collectorCommand = collector.map(quote).join(" ");
  const pidPath = join(probe.directory, "failure.collector.pid");
  const quotedPidPath = quote(pidPath);
  const ownedCollector = `echo "$$" > ${quotedPidPath}; exec ${collectorCommand}`;
  const escapedCommand = ownedCollector.replaceAll("%", "%%");
  await tmux(probe.socket, [
    "pipe-pane",
    "-O",
    "-t",
    "failure",
    escapedCommand,
  ]);
  await awaitText(pidPath, "\n");
  const collectorPidText = await readFile(pidPath, "utf8");
  const collectorPidValue = collectorPidText.trim();
  const collectorPid = Number(collectorPidValue);
  const validPid = Number.isSafeInteger(collectorPid) && collectorPid > 1;
  assert.ok(validPid);
  probe.processes.add(collectorPid);
  await sendText(probe, "failure", "start");
  await awaitText(metadata, "ENOENT");
  const exited = (): Promise<boolean> => {
    const gone = !processExists(collectorPid);
    return Promise.resolve(gone);
  };
  await waitFor(exited, 50);
  const alive = groupExists(group);
  assert.equal(alive, true);
  await sendText(probe, "failure", "still-healthy");
  const responds = async (): Promise<boolean> => {
    const screen = await tmux(probe.socket, [
      "capture-pane",
      "-p",
      "-t",
      "failure",
    ]);
    return screen.includes("healthy-input");
  };
  await waitFor(responds, 50);
  await tmux(probe.socket, ["kill-session", "-t", "failure"]);
};

const exercise = async (injectFailure: boolean): Promise<void> => {
  const probe = await createProbe();
  try {
    await startServer(probe, probe.socket);
    await startServer(probe, probe.controlSocket);
    await fastExit(probe);
    await captureProbe(probe, "fast", "3", false, false);
    await captureProbe(probe, "flood", "0", false, false);
    await captureProbe(probe, "flood", "0", false, true);
    await inputProbe(probe);
    await eofProbe(probe);
    await contextProbe(probe);
    await boundaryProbe(probe, false);
    await boundaryProbe(probe, true);
    await foregroundProbe(probe);
    await captureFailureProbe(probe);
    const group = await startResistant(probe);
    if (injectFailure) throw new Error("injected host failure");
    await resistantCleanup(probe, group);
    await tmux(probe.controlSocket, ["has-session", "-t", "anchor"]);
  } finally {
    await cleanup(probe);
  }
};

try {
  await exercise(false);
  log.ok(
    "Host tmux: persistent fast/flood capture, literal input/keys, attach/detach, launch context, cleanup boundaries, capture failure, server isolation",
  );
  const failedProbe = exercise(true);
  await assert.rejects(failedProbe, { message: "injected host failure" });
  log.ok("Host tmux: injected failure cleaned up all owned resources");
  const interrupted = interruptedCapture();
  await assert.rejects(interrupted, { message: "injected capture failure" });
  log.ok(
    "Host tmux: launch failure cleaned up gated worker and active collector",
  );
} catch (error) {
  log.error(`host test: ${String(error)}`);
  process.exitCode = 1;
}
