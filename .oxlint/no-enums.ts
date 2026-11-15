import { defineRule } from "@oxlint/plugins";

const noEnums = defineRule({
  create(context) {
    return {
      TSEnumDeclaration(node) {
        context.report({ messageId: "noEnums", node });
      },
    };
  },
  meta: {
    docs: {
      description: "Disallow TypeScript enum declarations",
    },
    messages: {
      noEnums: "Use a union type or an as-const object instead of an enum.",
    },
    schema: [],
    type: "problem",
  },
});

export default noEnums;
