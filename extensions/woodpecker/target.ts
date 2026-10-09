import { z } from "zod";

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const watchTargetSchema = z
  .union([
    z.object({ branch: z.string().min(1), commit: z.never().optional() }),
    z.object({ commit: commitSchema, branch: z.never().optional() }),
  ])
  .transform((input) => {
    if (input.branch !== undefined)
      return { kind: "branch" as const, value: input.branch };
    return { kind: "commit" as const, value: input.commit };
  });

export type WatchTarget = Readonly<z.infer<typeof watchTargetSchema>>;

export const formatWatchTarget = (target: WatchTarget): string =>
  `${target.kind} ${target.value}`;

export const subscriptionKey = (repo: string, target: WatchTarget): string =>
  JSON.stringify([repo, target.kind, target.value]);

export const pipelineQuery = (target: WatchTarget): string => {
  const parameters = new URLSearchParams({ perPage: "20" });
  if (target.kind === "branch") parameters.set("branch", target.value);
  return parameters.toString();
};
