import type { LoginView } from "./api.ts";

export const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
export const SKILL_NAME_HINT = "1 to 64 characters: a-z, 0-9, hyphen.";

export function validSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

export type SkillDraft =
  | { mode: "new"; name: string; description: string; body: string }
  | { mode: "edit"; text: string; saved: string };

// Whether the form may save, and what is wrong with it.
export function skillState(draft: SkillDraft): { canSave: boolean; hint: string } {
  if (draft.mode === "edit") return { canSave: draft.text !== draft.saved && draft.text.trim() !== "", hint: "" };
  const nameOk = validSkillName(draft.name);
  const hint = draft.name !== "" && !nameOk ? SKILL_NAME_HINT : "";
  return { canSave: nameOk && draft.description.trim() !== "", hint };
}

export function loginSummary(view: LoginView): string {
  if (view.state === "signed-in") return "Signed in. Codex agents run with the lounge login.";
  if (view.state === "running") return "Waiting for the sign-in in your browser.";
  const base = "Not signed in. A Codex agent cannot run until you sign in.";
  return view.error ? `${base} Last error: ${view.error}` : base;
}

export function loginBusy(view: LoginView): boolean {
  return view.state === "running";
}
