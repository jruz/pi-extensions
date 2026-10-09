import { z } from "zod";
import { Box, Text } from "@earendil-works/pi-tui";
import { pipelineSchema } from "../woodpecker/client.ts";
import type { CardTheme } from "../woodpecker/presentation.ts";

export const monitoringPreviewSchema = z
  .object({
    repo: z.string(),
    branch: z.string(),
    reason: z.string(),
    lastPipeline: pipelineSchema.nullable(),
  })
  .readonly();
export type MonitoringPreview = z.infer<typeof monitoringPreviewSchema>;

export const monitoringSample: MonitoringPreview = {
  repo: "owner/repo",
  branch: "main",
  reason: "Request timed out",
  lastPipeline: {
    id: 42,
    number: 42,
    status: "running",
    branch: "main",
    commit: "a1b2c3d",
  },
};

export const monitoringLines = (
  preview: MonitoringPreview,
  theme: CardTheme,
): readonly string[] => {
  const heading = theme.bold("! Woodpecker CI · Monitoring stopped");
  const { repo, branch, reason, lastPipeline } = preview;
  const quotedRepo = `'${repo.replaceAll("'", "'\\''")}'`;
  const quotedBranch = `'${branch.replaceAll("'", "'\\''")}'`;
  const checkCommand = `woodpecker-cli pipeline ls ${quotedRepo} --branch ${quotedBranch} --limit 1`;
  const watchArgs = JSON.stringify({ repo, branch });
  const resumeCommand = `woodpecker_watch(${watchArgs})`;
  const lastKnown =
    lastPipeline === null
      ? "  No last-known pipeline status available."
      : `  Last known: #${lastPipeline.number} ${lastPipeline.status} · ${lastPipeline.commit.slice(0, 7)} (may be stale)`;
  return [
    theme.fg("error", heading),
    theme.fg("text", `  ${repo} · ${branch} · Sample data`),
    "",
    theme.fg("text", `  Reason: ${reason}`),
    theme.fg("muted", lastKnown),
    "",
    theme.fg("muted", "  View current status:"),
    theme.fg("accent", `    ${checkCommand}`),
    "",
    theme.fg("muted", "  Resume monitoring:"),
    theme.fg("accent", `    ${resumeCommand}`),
  ];
};

export const renderMonitoringPreview = (
  preview: MonitoringPreview,
  theme: CardTheme,
) => {
  const lines = monitoringLines(preview, theme);
  const content = lines.join("\n");
  const text = new Text(content, 0, 0);
  const card = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
  card.addChild(text);
  return card;
};
