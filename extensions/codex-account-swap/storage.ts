import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { z } from "zod";

const ACTIVE = "openai-codex";
const AuthKeySchema = z.string();
const AuthValueSchema = z.unknown();
const AuthSchema = z.record(AuthKeySchema, AuthValueSchema);
const CredentialSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
    accountId: z.string().min(1),
  })
  .loose()
  .readonly();
const AccountsSchema = z
  .record(AuthKeySchema, CredentialSchema)
  .refine((accounts) => {
    const names = Object.keys(accounts);
    return names.length === 2;
  })
  .readonly();

type Accounts = z.infer<typeof AccountsSchema>;

const parseAuth = (content: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(content);
    return AuthSchema.parse(value);
  } catch {
    throw new Error("account credentials: invalid auth.json");
  }
};

const readCredential = (auth: Record<string, unknown>, key: string) => {
  const result = CredentialSchema.safeParse(auth[key]);
  if (!result.success)
    throw new Error(`account credentials: missing or invalid ${key}`);
  return result.data;
};

const identifyAccount = (accountId: string, accounts: Accounts): string => {
  const entries = Object.entries(accounts);
  const ids = entries.map(([, credential]) => credential.accountId);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== entries.length)
    throw new Error(
      "account credentials: saved logins must identify different accounts",
    );
  const active = entries.find(
    ([, credential]) => credential.accountId === accountId,
  );
  if (active === undefined)
    throw new Error(
      "account credentials: active login matches neither saved account",
    );
  return active[0];
};

const readAccounts = (auth: Record<string, unknown>) => {
  const result = AccountsSchema.safeParse(auth["codex-account-swap"]);
  if (!result.success)
    throw new Error(
      "account credentials: codex-account-swap must contain two named OAuth entries",
    );
  return result.data;
};

export const readAccountStatus = async (
  authPath: string,
): Promise<
  Readonly<{ active: string; names: readonly string[] }> | undefined
> => {
  try {
    const content = await readFile(authPath, "utf8");
    const auth = parseAuth(content);
    if (auth["codex-account-swap"] === undefined) return;
    const current = readCredential(auth, ACTIVE);
    const accounts = readAccounts(auth);
    const active = identifyAccount(current.accountId, accounts);
    const names = Object.keys(accounts);
    return { active, names };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
};

const updateAuth = (auth: Record<string, unknown>, selection: string) => {
  const current = readCredential(auth, ACTIVE);
  const accounts = readAccounts(auth);
  const active = identifyAccount(current.accountId, accounts);
  const saved = { ...accounts, [active]: current };
  const entries = Object.entries(saved);
  const target = entries.find(([name]) =>
    selection === "" ? name !== active : name === selection,
  );
  if (target === undefined)
    throw new Error(`account swap: unknown account ${selection}`);
  const [selected, credential] = target;
  return {
    selected,
    auth: { ...auth, "codex-account-swap": saved, [ACTIVE]: credential },
  };
};

export const swapCredentials = async (
  authPath: string,
  selection: string,
): Promise<string> => {
  const lockPath = `${authPath}.lock`;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("account credentials: auth.json is busy; retry shortly", {
        cause: error,
      });
    throw error;
  }
  const id = randomUUID();
  const temporaryPath = `${authPath}.${id}.tmp`;
  try {
    const content = await readFile(authPath, "utf8");
    const auth = parseAuth(content);
    const updated = updateAuth(auth, selection);
    const serialized = JSON.stringify(updated.auth, null, 2);
    await writeFile(temporaryPath, serialized, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, authPath);
    return updated.selected;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } finally {
      await rmdir(lockPath);
    }
  }
};
