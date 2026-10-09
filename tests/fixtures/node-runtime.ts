import assert from "node:assert/strict";
import messenger from "../../extensions/messenger/index.ts";
import { createRuntime } from "../../extensions/messenger/runtime.ts";
import { createTransport } from "../../extensions/messenger/transport.ts";
import statusLine from "../../extensions/status-line.ts";
import woodpecker from "../../extensions/woodpecker/index.ts";

assert.equal("Bun" in globalThis, false);
[messenger, createRuntime, createTransport, statusLine, woodpecker].forEach(
  (value) => {
    assert.equal(typeof value, "function");
  },
);
