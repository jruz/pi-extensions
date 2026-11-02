import { defineRule } from "@oxlint/plugins";

const noComments = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow comments",
    },
    messages: {
      noComments:
        "Comments are not allowed. Make the code self-explanatory instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang")
          .forEach((comment) => {
            context.report({ loc: comment.loc, messageId: "noComments" });
          });
      },
    };
  },
});

export default noComments;
