import { readFileSync } from "node:fs";

export const coreVersion = (): string =>
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
