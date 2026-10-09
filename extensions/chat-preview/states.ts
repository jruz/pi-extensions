import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { pipelineStyle } from "../woodpecker/presentation.ts";

export const statePreviewSchema = z.enum(["running", "pending"]);
export type StatePreview = z.infer<typeof statePreviewSchema>;

type StateStyle = Readonly<{
  title: string;
  color: ThemeColor;
}>;

export const stateStyles: Readonly<Record<StatePreview, StateStyle>> = {
  running: pipelineStyle("running"),
  pending: pipelineStyle("pending"),
};
