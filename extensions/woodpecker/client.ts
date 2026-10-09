import { z } from "zod";
import { requestJson } from "./request.ts";
import { pipelineQuery, type WatchTarget } from "./target.ts";

const repoSchema = z.object({ id: z.number() }).readonly();
export const pipelineSchema = z
  .object({
    id: z.number(),
    number: z.number(),
    status: z.string(),
    branch: z.string(),
    commit: z.string(),
    event: z.string().optional(),
    ref: z.string().optional(),
  })
  .readonly();
export type Pipeline = z.infer<typeof pipelineSchema>;

export const apiPipelineSchema = pipelineSchema
  .unwrap()
  .extend({ event: z.string(), ref: z.string() })
  .readonly();

export const matchingPipelines = (
  pipelines: readonly Pipeline[],
  target: WatchTarget,
): readonly Pipeline[] =>
  pipelines.filter((pipeline) =>
    target.kind === "branch"
      ? pipeline.branch === target.value
      : pipeline.commit === target.value,
  );

export const createPipelineReader =
  (request: (path: string, signal: AbortSignal) => Promise<unknown>) =>
  async (id: number, target: WatchTarget, signal: AbortSignal) => {
    const data = await request(
      `/api/repos/${id}/pipelines?${pipelineQuery(target)}`,
      signal,
    );
    const pipelines = z.array(apiPipelineSchema).readonly().parse(data);
    return matchingPipelines(pipelines, target);
  };

export const createClient = (report: (message: string) => void) => {
  const server = process.env["WOODPECKER_SERVER"];
  const token = process.env["WOODPECKER_TOKEN"];
  if (!server || !token)
    throw new Error(
      "woodpecker: WOODPECKER_SERVER and WOODPECKER_TOKEN are required",
    );
  const base = new URL(server);
  if (base.username || base.password)
    throw new Error("woodpecker: server URL must not contain credentials");

  const request = async (
    path: string,
    signal: AbortSignal,
  ): Promise<unknown> => {
    return requestJson(
      new URL(path, base),
      { Authorization: `Bearer ${token}` },
      signal,
      report,
    );
  };

  return {
    repo: async (name: string, signal: AbortSignal) => {
      const data = await request(
        `/api/repos/lookup/${name.split("/").map(encodeURIComponent).join("/")}`,
        signal,
      );
      return repoSchema.parse(data).id;
    },
    pipelines: createPipelineReader(request),
  };
};

export const changedPipelines = (
  previous: readonly Pipeline[],
  current: readonly Pipeline[],
): readonly Pipeline[] =>
  current.filter(
    (pipeline) =>
      !previous.some(
        (old) => old.id === pipeline.id && old.status === pipeline.status,
      ),
  );

export const formatPipelineLocation = (pipeline: Pipeline): string => {
  if (pipeline.event === undefined || pipeline.ref === undefined)
    return `branch ${pipeline.branch}`;
  if (pipeline.event === "tag")
    return `${pipeline.ref.replace(/^refs\/tags\//, "")} · tag`;
  return `${pipeline.branch} · ${pipeline.event}`;
};

export const formatPipeline = (repo: string, pipeline: Pipeline): string =>
  `${repo} ${formatPipelineLocation(pipeline)}: pipeline #${pipeline.number} ${pipeline.status} (commit ${pipeline.commit})`;
