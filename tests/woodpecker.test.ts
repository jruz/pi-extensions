import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  changedPipelines,
  formatPipeline,
  pipelineSchema,
} from "../extensions/woodpecker/client.ts";

const running = {
  id: 1,
  number: 42,
  status: "running",
  branch: "feature",
  commit: "abc123",
};

describe("Woodpecker status changes", () => {
  it("does not repeat unchanged pipelines", () => {
    const changes = changedPipelines([running], [running]);
    assert.deepEqual(changes, []);
  });
  it("reports terminal transitions", () => {
    const failed = { ...running, status: "failure" };
    const changes = changedPipelines([running], [failed]);
    assert.deepEqual(changes, [failed]);
  });
  it("reports newly discovered pipelines", () => {
    const changes = changedPipelines([], [running]);
    assert.deepEqual(changes, [running]);
  });
  it("reports restarted pipelines", () => {
    const changes = changedPipelines(
      [{ ...running, status: "failure" }],
      [running],
    );
    assert.deepEqual(changes, [running]);
  });
  it("does not report pipelines disappearing from the polling window", () => {
    const changes = changedPipelines([running], []);
    assert.deepEqual(changes, []);
  });
  it("includes repository, branch, pipeline, status and commit", () => {
    const text = formatPipeline("owner/repo", running);
    assert.equal(
      text,
      "owner/repo branch feature: pipeline #42 running (commit abc123)",
    );
  });
  it("rejects malformed API data", () => {
    assert.equal(pipelineSchema.safeParse({ id: "1" }).success, false);
  });
});
