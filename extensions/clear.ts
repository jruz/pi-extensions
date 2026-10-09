import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const clear = async (_args: string, ctx: ExtensionCommandContext) => {
    await ctx.newSession();
  };

  pi.registerCommand("clear", {
    description: "Start a new session",
    handler: clear,
  });

  pi.registerCommand("clw", {
    description: "Alias for /clear",
    handler: clear,
  });
}
