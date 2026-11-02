import { describe, expect, test } from "bun:test";
import { formatTable } from "./table.ts";

const header = ["JOB", "STATUS", "HEALTH"];
const rows = [
  ["alloy", "running", "OK"],
  ["vaultwarden", "running", "OK"],
];

const expectAligned = (output: string): void => {
  const lines = output.split("\n");
  const widths = lines.map((line) => Bun.stringWidth(line));
  const distinctWidths = new Set(widths);
  expect(distinctWidths.size).toBe(1);
};

describe("light-border tables", () => {
  test("draws an outer border and header separator without row dividers", () => {
    const output = formatTable(header, rows);
    const expected = [
      "┌─────────────┬─────────┬────────┐",
      "│ JOB         │ STATUS  │ HEALTH │",
      "├─────────────┼─────────┼────────┤",
      "│ alloy       │ running │ OK     │",
      "│ vaultwarden │ running │ OK     │",
      "└─────────────┴─────────┴────────┘",
    ].join("\n");
    expect(output).toBe(expected);
  });

  test("renders an empty table using header widths", () => {
    const output = formatTable(["JOB"], []);
    const expected = ["┌─────┐", "│ JOB │", "├─────┤", "└─────┘"].join("\n");
    expect(output).toBe(expected);
  });

  test("preserves empty cells", () => {
    const output = formatTable(["A", "B"], [["", "value"]]);
    expect(output).toContain("│   │ value │");
    expectAligned(output);
  });

  test("measures visible width without counting ANSI color codes", () => {
    const colored = "\x1b[32mOK\x1b[0m";
    const output = formatTable(["HEALTH"], [[colored], ["FAILED"]]);
    expect(output).toContain(`│ ${colored}     │`);
    expect(output).toContain("│ FAILED │");
    expectAligned(output);
  });

  test("aligns wide characters, emoji and combining marks", () => {
    const output = formatTable(["NAME"], [["東京"], ["🚀"], ["e\u0301"]]);
    expect(output).toContain("│ 東京 │");
    expect(output).toContain("│ 🚀   │");
    expect(output).toContain("│ e\u0301    │");
    expectAligned(output);
  });

  test("preserves long values without terminal-dependent truncation", () => {
    const job = "vaultwarden-backup/periodic-1792337113";
    const output = formatTable(["JOB"], [[job]]);
    expect(output).toContain(`│ ${job} │`);
    expectAligned(output);
  });

  test("rejects a missing header", () => {
    expect(() => formatTable([], [])).toThrow("empty table header");
  });

  test.each([
    { cells: ["alloy"] },
    { cells: ["alloy", "running", "OK", "extra"] },
  ])("rejects a mismatched column count: $cells", ({ cells }) => {
    expect(() => formatTable(header, [cells])).toThrow("table column count");
  });
});

test("does not mutate headers, rows or cells", () => {
  const headings = Object.freeze(["JOB", "HEALTH"]);
  const cells = Object.freeze(["alloy", "OK"]);
  const immutableRows = Object.freeze([cells]);
  formatTable(headings, immutableRows);
  expect(headings).toEqual(["JOB", "HEALTH"]);
  expect(cells).toEqual(["alloy", "OK"]);
});
