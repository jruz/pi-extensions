import { it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import noEnums from "./no-enums.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

await it("rejects enums and accepts union types and const objects", () => {
  tester.run("no-enums", noEnums, {
    invalid: [
      {
        code: "enum Status { Ready, Done }",
        errors: [{ messageId: "noEnums" }],
      },
      {
        code: 'enum Status { Ready = "ready", Done = "done" }',
        errors: [{ messageId: "noEnums" }],
      },
      {
        code: "const enum Status { Ready, Done }",
        errors: [{ messageId: "noEnums" }],
      },
      {
        code: "export enum Status { Ready, Done }",
        errors: [{ messageId: "noEnums" }],
      },
      {
        code: "declare enum Status { Ready, Done }",
        errors: [{ messageId: "noEnums" }],
      },
    ],
    valid: [
      'type Status = "ready" | "running" | "done";',
      'const Status = { Ready: "ready", Done: "done" } as const;',
      "const enumLabel = 'ready';",
    ],
  });
});
