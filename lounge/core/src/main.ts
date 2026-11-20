import { loungeHome } from "./config.ts";
import { tokensFile } from "./auth/tokens.ts";
import { startCore } from "./api/http.ts";
import { BUNDLED_SKILLS } from "./skills/seed.ts";

// One probe a minute keeps spawns rare.
const PROBE_MS = 60_000;
const home = loungeHome();

try {
  const core = await startCore({ home, probeMs: PROBE_MS, schedule: true, bundledSkills: BUNDLED_SKILLS });
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
