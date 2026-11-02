import type { TableBorder, TableColumn } from "./table.types.ts";

const cellAt = (cells: readonly string[], index: number): string => {
  const cell = cells[index];
  if (cell === undefined) throw new Error(`missing table cell: ${index}`);
  return cell;
};

const measureColumn = (
  heading: string,
  index: number,
  rows: readonly (readonly string[])[],
): TableColumn => {
  const widths = rows.map((row) => {
    const cell = cellAt(row, index);
    return Bun.stringWidth(cell);
  });
  const headingWidth = Bun.stringWidth(heading);
  return { index, width: Math.max(headingWidth, ...widths) };
};

const formatBorder = (
  columns: readonly TableColumn[],
  border: TableBorder,
): string => {
  const [left, separator, right] = border;
  const segments = columns.map(({ width }) => "─".repeat(width + 2));
  return `${left}${segments.join(separator)}${right}`;
};

const formatRow = (
  cells: readonly string[],
  columns: readonly TableColumn[],
): string => {
  const padded = columns.map(({ index, width }) => {
    const cell = cellAt(cells, index);
    const visibleWidth = Bun.stringWidth(cell);
    const padding = " ".repeat(width - visibleWidth);
    return ` ${cell}${padding} `;
  });
  return `│${padded.join("│")}│`;
};

export const formatTable = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string => {
  if (header.length === 0) throw new Error("empty table header");
  rows.forEach((row) => {
    if (row.length !== header.length)
      throw new Error(
        `table column count: ${row.length}, expected ${header.length}`,
      );
  });
  const columns = header.map((heading, index) =>
    measureColumn(heading, index, rows),
  );
  const body = rows.map((row) => formatRow(row, columns));
  const lines = [
    formatBorder(columns, ["┌", "┬", "┐"]),
    formatRow(header, columns),
    formatBorder(columns, ["├", "┼", "┤"]),
    ...body,
    formatBorder(columns, ["└", "┴", "┘"]),
  ];
  return lines.join("\n");
};
