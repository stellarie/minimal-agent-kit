import { join } from "node:path";
import { loungeHome } from "./config.ts";
import { tokensFile } from "./auth/tokens.ts";
import { startCore } from "./api/http.ts";
import { BUNDLED_SKILLS } from "./skills/seed.ts";
import { UPDATE_EXIT_CODE } from "./update/service.ts";

// One probe a minute keeps spawns rare.
const PROBE_MS = 60_000;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const home = loungeHome();
const installRoot = join(import.meta.dirname, "..", "..", "..");

try {
  const core = await startCore({
    home,
    probeMs: PROBE_MS,
    schedule: true,
    bundledSkills: BUNDLED_SKILLS,
    update: {
      installRoot,
      everyMs: UPDATE_CHECK_MS,
      onApply: () => void core.close().finally(() => process.exit(UPDATE_EXIT_CODE)),
    },
  });
  console.log(`agent-lounge core listening on ${core.url}`);
  console.log(`tokens file: ${tokensFile(home)}`);
  const stop = () => {
    core.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("shutdown failed:", err);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (err) {
  console.error(`agent-lounge core failed to start: ${(err as Error).message}`);
  process.exitCode = 1;
}
