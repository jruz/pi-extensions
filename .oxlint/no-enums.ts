import { defineRule } from "@oxlint/plugins";

const noEnums = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow TypeScript enum declarations",
    },
    messages: {
      noEnums: "Use a union type or an as-const object instead of an enum.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSEnumDeclaration(node) {
        context.report({ node, messageId: "noEnums" });
      },
    };
  },
});

export default noEnums;
