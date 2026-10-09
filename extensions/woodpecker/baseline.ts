import { formatPipeline, type Pipeline } from "./client.ts";
import { formatWatchTarget, type WatchTarget } from "./target.ts";

export const formatWatchBaseline = (
  repo: string,
  target: WatchTarget,
  pipelines: readonly Pipeline[],
): string => {
  const heading = `Watching Woodpecker CI for ${repo} · ${formatWatchTarget(target)}.`;
  const scope =
    target.kind === "commit"
      ? "Push and tag pipelines for this commit are monitored. Push success does not imply release success."
      : "Tags are not matched as branches.";
  const introduction = `${heading}\n${scope}`;
  if (pipelines.length === 0)
    return `${introduction}\nNo pipelines match this exact ${target.kind} filter in the latest 20 pipelines. Awaiting a matching pipeline, not success.`;
  const statuses = pipelines.map((pipeline) => formatPipeline(repo, pipeline));
  return `${introduction}\nCurrent pipelines (baseline only; existing failures are not replayed):\n${statuses.join("\n")}`;
};
