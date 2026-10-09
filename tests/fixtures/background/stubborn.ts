import { log } from "./log.ts";

log.info(`pid=${process.pid}`);
process.on("SIGTERM", () => {
  log.info("ignored-term");
});
process.on("SIGINT", () => {
  log.info("ignored-int");
});
setInterval(() => undefined, 60_000);
