import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./lib/log.ts";

const argumentsSchema = z.tuple([
  z.enum(["check", "render"]),
  z.string().min(1),
  z.string().min(1),
]);

const executable = (command: string): string => {
  const path = Bun.which(command);
  if (path === null) throw new Error(`missing executable: ${command}`);
  return path;
};

const renderDiagram = async (
  command: string,
  config: string,
  input: string,
  output: string,
): Promise<void> => {
  const child = Bun.spawn(
    [
      command,
      "--input",
      input,
      "--output",
      output,
      "--puppeteerConfigFile",
      config,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`mermaid render failed: ${input}`);
  log.ok(`Rendered ${input}`);
};

const renderDiagrams = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  const [mode, cli, browser] = argumentsSchema.parse(args);
  const command = executable(cli);
  const chromium = executable(browser);
  const glob = new Bun.Glob("docs/**/*.mmd");
  const scanned = glob.scanSync();
  const files = Array.from(scanned).toSorted();
  if (files.length === 0) throw new Error("no diagrams: docs/**/*.mmd");
  const temporaryRoot = tmpdir();
  const prefix = join(temporaryRoot, "mermaid-");
  const directory = await mkdtemp(prefix);
  try {
    const config = join(directory, "puppeteer.json");
    const serialized = JSON.stringify({
      executablePath: chromium,
      args: ["--no-sandbox"],
    });
    await writeFile(config, serialized);
    const initial = Promise.resolve();
    await files.reduce(async (previous, input) => {
      await previous;
      const output =
        mode === "check"
          ? join(directory, "diagram.svg")
          : input.replace(/\.mmd$/u, ".svg");
      await renderDiagram(command, config, input, output);
    }, initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

try {
  await renderDiagrams();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`mermaid: ${message}`);
  process.exitCode = 1;
}
