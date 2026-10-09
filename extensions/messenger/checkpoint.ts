import { truncateHead } from "@earendil-works/pi-coding-agent";

export const checkpointPages = (content: string): readonly string[] => {
  const page = truncateHead(content, { maxBytes: 48_000, maxLines: 1900 });
  if (!page.truncated) return [content];
  if (page.firstLineExceedsLimit)
    throw new Error(
      "messenger: incoming message line exceeds checkpoint output limit",
    );
  const rest = content.slice(page.content.length);
  return [page.content, ...checkpointPages(rest)];
};
