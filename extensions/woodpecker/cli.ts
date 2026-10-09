import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractEvidence, type RunCli } from "./diagnostics.ts";

export const createCliRunner =
  (exec: ExtensionAPI["exec"], signal: AbortSignal | undefined): RunCli =>
  async (args) => {
    const options =
      signal === undefined ? { timeout: 30000 } : { signal, timeout: 30000 };
    const result = await exec(
      "woodpecker-cli",
      ["--disable-update-check", ...args],
      options,
    );
    if (result.killed)
      throw new Error(
        "woodpecker: diagnostic request interrupted or timed out",
      );
    if (result.code !== 0) {
      const evidence = extractEvidence(result.stderr);
      const stderr = evidence.map(({ text }) => text).join("\n");
      throw new Error(
        `woodpecker: Woodpecker CLI exited ${result.code}\n${stderr}`,
      );
    }
    return result.stdout;
  };
