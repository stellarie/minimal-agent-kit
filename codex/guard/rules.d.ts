export type ActionKind = "shell" | "write" | "read" | "patch" | "other";

export interface GuardAction {
  tool: string;
  kind: ActionKind;
  command?: string;
  path?: string;
  content?: string;
  glob?: string;
  paths?: string[];
  cwd?: string;
  // The raw tool input, for a danger pass.
  input?: unknown;
  // A patch with two different texts.
  ambiguous?: boolean;
}

export type VerdictKind = "allow" | "ask" | "block";

export interface Verdict {
  verdict: VerdictKind;
  reason?: string;
  // The owner may approve this block by hand.
  // A block without it always denies.
  askable?: true;
}

export interface RuleOptions {
  home?: string;
  tmp?: string;
  projectsRoot?: string;
  loungeHome?: string;
  // True when a drive with this letter exists. Tests pass their own.
  driveExists?: (letter: string) => boolean;
  // True when the root folder of the cwd drive holds a folder with this name. Tests pass their own.
  rootHas?: (letter: string) => boolean;
}

export declare function toAction(tool: string, input: unknown, cwd?: string): GuardAction;
export declare function judge(action: GuardAction, opts?: RuleOptions): Verdict;
export declare function stronger(a: Verdict, b: Verdict): Verdict;
export declare function normPath(raw: string, cwd?: string, home?: string, tmp?: string): string | undefined;
export declare function readOnlyShell(
  command: string,
  cwd?: string,
  loungeHome?: string,
  opts?: Pick<RuleOptions, "driveExists" | "rootHas">,
): boolean;
