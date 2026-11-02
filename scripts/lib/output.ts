import { formatTable } from "./table.ts";

export const output = {
  text: (text: string): void => {
    console.log(text);
  },
  json: (value: unknown): void => {
    const text = JSON.stringify(value, null, 2);
    console.log(text);
  },
  table: (
    header: readonly string[],
    rows: readonly (readonly string[])[],
  ): void => {
    const text = formatTable(header, rows);
    console.log(text);
  },
};
