import { describe, expect, it, vi } from "vitest";
import {
  changedPipelines,
  createPipelineReader,
  formatPipeline,
  matchingPipelines,
  apiPipelineSchema,
} from "./client.ts";
import { formatWatchBaseline } from "./baseline.ts";
import { pipelineQuery, subscriptionKey, watchTargetSchema } from "./target.ts";

const commit = "1895fede547fb80dc198689ad33622c48e453a49";
const push = {
  id: 69,
  number: 20,
  status: "success",
  branch: "main",
  commit,
  event: "push",
  ref: "refs/heads/main",
};
const tag = {
  ...push,
  id: 70,
  number: 21,
  status: "running",
  branch: "",
  event: "tag",
  ref: "refs/tags/v0.4.3",
};
const target = watchTargetSchema.parse({ commit });

describe("commit watching", () => {
  it("requires exactly one branch or full commit SHA", () => {
    const branch = watchTargetSchema.parse({ branch: "main" });
    expect(branch).toEqual({
      kind: "branch",
      value: "main",
    });
    expect(target).toEqual({ kind: "commit", value: commit });
    [
      {},
      { branch: "main", commit },
      { branch: "" },
      { commit: "1895fed" },
      { commit: "main" },
    ].forEach((input) => {
      const parsed = watchTargetSchema.safeParse(input);
      expect(parsed.success).toBe(false);
    });
  });

  it("does not send a branch filter for commit watches", () => {
    const commitParameters = pipelineQuery(target);
    const query = new URLSearchParams(commitParameters);
    const hasBranch = query.has("branch");
    const pageSize = query.get("perPage");
    expect(hasBranch).toBe(false);
    expect(pageSize).toBe("20");
    const branchParameters = pipelineQuery({
      kind: "branch",
      value: "feature/a b",
    });
    const branchQuery = new URLSearchParams(branchParameters);
    const branch = branchQuery.get("branch");
    expect(branch).toBe("feature/a b");
  });

  it("requests repository-wide pipelines then validates and filters exact commits", async () => {
    const request =
      vi.fn<(path: string, signal: AbortSignal) => Promise<unknown>>();
    const unrelated = { ...push, id: 71, commit: "a".repeat(40) };
    request.mockResolvedValueOnce([tag, unrelated, push]);
    const read = createPipelineReader(request);
    const signal = new AbortController().signal;
    const commitPipelines = await read(9, target, signal);
    expect(commitPipelines).toEqual([tag, push]);
    expect(request).toHaveBeenCalledWith(
      "/api/repos/9/pipelines?perPage=20",
      signal,
    );
    request.mockResolvedValueOnce([push]);
    const branchPipelines = await read(
      9,
      { kind: "branch", value: "main" },
      signal,
    );
    expect(branchPipelines).toEqual([push]);
    expect(request).toHaveBeenLastCalledWith(
      "/api/repos/9/pipelines?perPage=20&branch=main",
      signal,
    );
    request.mockResolvedValueOnce([{ ...tag, ref: undefined }]);
    const malformedRequest = read(9, target, signal);
    await expect(malformedRequest).rejects.toThrow();
    request.mockRejectedValueOnce(new Error("request failed"));
    const failedRequest = read(9, target, signal);
    await expect(failedRequest).rejects.toThrow("request failed");
  });

  it("captures push and tag pipelines but excludes unrelated commits", () => {
    const unrelated = { ...push, id: 71, commit: "a".repeat(40) };
    const commitPipelines = matchingPipelines([tag, unrelated, push], target);
    const branchPipelines = matchingPipelines([tag, push], {
      kind: "branch",
      value: "main",
    });
    expect(commitPipelines).toEqual([tag, push]);
    expect(branchPipelines).toEqual([push]);
  });

  it("discovers a delayed tag after a successful push and tracks its failure", () => {
    const baseline = matchingPipelines([push], target);
    const current = matchingPipelines([tag, push], target);
    const discovered = changedPipelines(baseline, current);
    expect(discovered).toEqual([tag]);
    const failed = { ...tag, status: "failure" };
    const failures = changedPipelines(current, [failed, push]);
    const unchanged = changedPipelines([failed, push], [failed, push]);
    expect(failures).toEqual([failed]);
    expect(unchanged).toEqual([]);
  });

  it("separates branch and commit subscription keys", () => {
    const commitKey = subscriptionKey("owner/repo", target);
    const branchKey = subscriptionKey("owner/repo", {
      kind: "branch",
      value: commit,
    });
    const otherRepoKey = subscriptionKey("other/repo", target);
    expect(commitKey).not.toBe(branchKey);
    expect(otherRepoKey).not.toBe(commitKey);
  });

  it("shows the event and tag rather than an empty branch", () => {
    const pushText = formatPipeline("owner/repo", push);
    const tagText = formatPipeline("owner/repo", tag);
    const malformed = apiPipelineSchema.safeParse({
      ...push,
      event: undefined,
    });
    expect(pushText).toContain("main · push");
    expect(tagText).toContain("v0.4.3 · tag");
    expect(malformed.success).toBe(false);
  });

  it("shows both baseline pipelines and warns against treating push success as release success", () => {
    const text = formatWatchBaseline("owner/repo", target, [
      push,
      { ...tag, status: "failure" },
    ]);
    expect(text).toContain(`commit ${commit}`);
    expect(text).toContain("pipeline #20 success");
    expect(text).toContain("pipeline #21 failure");
    expect(text).toContain("Push success does not imply release success");
    expect(text).toContain("existing failures are not replayed");
  });

  it("does not claim success when no matching commit is in the polling window", () => {
    const text = formatWatchBaseline("owner/repo", target, []);
    expect(text).toContain("No pipelines match this exact commit filter");
    expect(text).toContain("Awaiting a matching pipeline, not success");
  });
});
