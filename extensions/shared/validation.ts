export type JsonObject = Readonly<Record<string, unknown>>;

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJson = (contents: string): unknown => {
  try {
    const value: unknown = JSON.parse(contents);
    return value;
  } catch (error) {
    throw new Error(
      `invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
};

export const readNumber = (record: JsonObject, key: string): number => {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`${key} is not a number`);
  return value;
};
