import { it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import noComments from "./no-comments.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

await it("rejects comments and accepts shebangs and comment-like strings", () => {
  tester.run("no-comments", noComments, {
    valid: [
      "const total = 1;",
      "#!/usr/bin/env node\nconst total = 1;",
      'const url = "https://adsmart.cl";',
      'const pattern = "/* not a comment */";',
    ],
    invalid: [
      {
        code: "// line comment\nconst total = 1;",
        errors: [{ messageId: "noComments" }],
      },
      {
        code: "/* block comment */\nconst total = 1;",
        errors: [{ messageId: "noComments" }],
      },
      {
        code: "/** JSDoc comment */\nexport const total = 1;",
        errors: [{ messageId: "noComments" }],
      },
      {
        code: "const element = <div>{/* jsx comment */}</div>;",
        errors: [{ messageId: "noComments" }],
      },
      {
        code: "// @ts-expect-error\nconst total: string = 1;",
        errors: [{ messageId: "noComments" }],
      },
    ],
  });
});
