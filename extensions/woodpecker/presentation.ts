import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { formatPipelineLocation, type Pipeline } from "./client.ts";
import { selectErrorLines, type Diagnostics } from "./diagnostics.ts";
import type { Notification, PipelineUpdate } from "./notifications.ts";

type PipelineStyle = Readonly<{ title: string; color: ThemeColor }>;
export type CardTheme = Pick<Theme, "fg" | "bg" | "bold">;

export const pipelineStyle = (status: string): PipelineStyle => {
  switch (status) {
    case "success":
      return { title: "✓ Woodpecker CI · Passed", color: "success" };
    case "failure":
      return { title: "✗ Woodpecker CI · Failed", color: "error" };
    case "running":
      return { title: "● Woodpecker CI · Running", color: "accent" };
    case "pending":
      return { title: "○ Woodpecker CI · Pending", color: "muted" };
  }
  return { title: `Woodpecker CI · ${status}`, color: "muted" };
};

const displayValue = (value: string) =>
  stripVTControlCharacters(value).replace(/\p{Cc}/gu, " ");

const pipelineLines = (repo: string, pipeline: Pipeline, theme: CardTheme) => {
  const style = pipelineStyle(pipeline.status);
  const title = displayValue(style.title);
  const heading = theme.bold(title);
  const label = `  ${repo} · ${formatPipelineLocation(pipeline)} · #${pipeline.number} · ${pipeline.commit.slice(0, 7)}`;
  const identity = displayValue(label);
  return [theme.fg(style.color, heading), theme.fg("text", identity)];
};

const stepLines = (steps: Diagnostics["steps"], theme: CardTheme) => {
  if (steps.length === 0)
    return [
      theme.fg(
        "muted",
        "  No failed steps reported; inspect the pipeline logs.",
      ),
    ];
  return steps.flatMap((step) => {
    const duration = step.stopped - step.started;
    const title = `  ✗ ${step.workflow} / ${step.name} · exit ${step.exitCode} · ${duration}s`;
    const selected = selectErrorLines(step.evidence);
    const evidence = selected.map(({ line, text }) =>
      theme.fg("text", `    L${line}: ${text}`),
    );
    const error =
      step.error === "" ? [] : [theme.fg("error", `    ${step.error}`)];
    const emptyEvidence =
      selected.length === 0
        ? [
            theme.fg(
              "muted",
              '    No log lines containing "error" in selected excerpts.',
            ),
          ]
        : [];
    const command = theme.fg("accent", `    ${step.logsCommand}`);
    return [
      "",
      theme.fg("error", title),
      ...error,
      ...evidence,
      ...emptyEvidence,
      command,
    ];
  });
};

export const updateLines = (
  update: PipelineUpdate,
  theme: CardTheme,
): readonly string[] => {
  if (update.kind === "failure") {
    const { repo, pipeline, steps } = update.diagnostics;
    const header = pipelineLines(repo, pipeline, theme);
    const failures = stepLines(steps, theme);
    return [...header, ...failures];
  }
  const header = pipelineLines(update.repo, update.pipeline, theme);
  if (update.kind === "status") return header;
  const quotedRepo = `'${update.repo.replaceAll("'", "'\\''")}'`;
  const reason = theme.fg(
    "muted",
    `  Failed-step diagnostics unavailable: ${update.reason}`,
  );
  const command = theme.fg(
    "accent",
    `  woodpecker-cli pipeline log show ${quotedRepo} ${update.pipeline.number}`,
  );
  return [...header, "", reason, command];
};

export const renderUpdate = (
  update: PipelineUpdate,
  theme: CardTheme,
  padding: number,
  footer: readonly string[],
) => {
  const lines = updateLines(update, theme);
  const content = [...lines, ...footer].join("\n");
  const text = new Text(content, 0, 0);
  const card = new Box(padding, 1, (line) => theme.bg("customMessageBg", line));
  card.addChild(text);
  return card;
};

export const renderNotification = (
  notification: Notification,
  theme: CardTheme,
  padding: number,
) => {
  const group = new Container();
  notification.updates.forEach((update, index) => {
    if (index > 0) {
      const spacer = new Spacer(1);
      group.addChild(spacer);
    }
    const card = renderUpdate(update, theme, padding, []);
    group.addChild(card);
  });
  return group;
};
