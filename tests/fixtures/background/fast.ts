import { log } from "./log.ts";

log.info("fast-start\nfast-final");
process.exitCode = 3;
