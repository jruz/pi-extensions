import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const resolvePiLogDirectory = (
  xdgStateHome: string | undefined,
  homeDirectory: string,
): string => {
  if (xdgStateHome !== undefined && isAbsolute(xdgStateHome)) {
    return resolve(xdgStateHome, "pi", "log");
  }
  return resolve(homeDirectory, ".local", "state", "pi", "log");
};

const HOME_DIRECTORY = homedir();

export const PI_LOG_DIRECTORY = resolvePiLogDirectory(
  process.env["XDG_STATE_HOME"],
  HOME_DIRECTORY,
);
