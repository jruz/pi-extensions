export const log = {
  info: (msg: string) => {
    console.log(`[\x1b[34mINFO\x1b[0m] ${msg}`);
  },
  warn: (msg: string) => {
    console.warn(`[\x1b[33mWARN\x1b[0m] ${msg}`);
  },
  ok: (msg: string) => {
    console.log(`[\x1b[32mOK\x1b[0m] ${msg}`);
  },
  raw: (msg: string) => {
    console.log(msg);
  },
  error: (msg: string) => {
    console.error(`[\x1b[31mERROR\x1b[0m] ${msg}`);
  },
};
