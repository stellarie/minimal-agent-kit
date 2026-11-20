import {
  CODEX_STORE_ARGS,
  codexHomeOf,
  codexLoginStatus,
  type CodexCommand,
} from "../../core/src/api/codex-login.ts";

export const CODEX_NOT_SIGNED_IN = "Codex not signed in: use Sign in to Codex";

export interface CodexIsolation {
  // Put before the other CLI flags.
  args: string[];
  // Added to the environment of the child.
  env: Record<string, string>;
}

// Codex runs with its own folder under the lounge home: no AGENTS.md and no skills of the user.
// The folder holds its own sign-in. The lounge never copies the sign-in file of the user,
// because a refresh token that rotates in one folder can break the login of the other.
// --ignore-user-config alone is not enough: the user's AGENTS.md and skills still load.
export function codexIsolationArgs(loungeHome: string): CodexIsolation {
  return { args: [...CODEX_STORE_ARGS], env: { CODEX_HOME: codexHomeOf(loungeHome) } };
}

// Why a Codex turn must not start, or undefined when a login exists.
// The caller starts no run when this gives a reason.
export async function codexSignInReason(loungeHome: string, cli: CodexCommand): Promise<string | undefined> {
  return (await codexLoginStatus(loungeHome, cli)) ? undefined : CODEX_NOT_SIGNED_IN;
}
