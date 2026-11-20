import { randomBytes } from "node:crypto";
import { judge, stronger, toAction, type GuardAction, type Verdict } from "../../../../core/guard/rules.js";
import type { Approvals } from "./approvals.ts";
import type { Audit, AuditEntry } from "./audit.ts";
import { CLASSIFY_MS, MAX_CONTENT, classifyRequest, isMutating, parseClassifier, type ClassifyRequest, type ToolMode } from "./modes.ts";

export type { GuardAction, Verdict, ToolMode };

export interface PluginGuard {
  plugin: string;
  fn(action: GuardAction, ctx: { agent: string }): unknown;
}

export interface GuardResult {
  decision: "allow" | "deny";
  reason?: string;
  asked: boolean;
}

const PLUGIN_MS = 2_000;
const VERDICTS = new Set(["allow", "ask", "block"]);

// The card shows what the check saw.
const EXCERPT = MAX_CONTENT;

function summaryOf(action: GuardAction): string {
  if (action.kind === "shell") return action.command ?? "";
  return action.path ?? action.tool;
}

// A plugin that throws, hangs, or answers badly gives ask.
async function runPlugin(g: PluginGuard, action: GuardAction, agent: string): Promise<Verdict & { source: string }> {
  const source = `plugin:${g.plugin}`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), PLUGIN_MS);
    });
    const raw = await Promise.race([Promise.resolve(g.fn({ ...action }, { agent })), timeout]);
    if (raw === undefined || raw === null) return { verdict: "allow", source };
    const v = raw as { verdict?: unknown; reason?: unknown };
    if (typeof v.verdict !== "string" || !VERDICTS.has(v.verdict)) {
      return { verdict: "ask", reason: `plugin ${g.plugin} gave a bad verdict`, source };
    }
    return {
      verdict: v.verdict as Verdict["verdict"],
      reason: typeof v.reason === "string" ? v.reason : `plugin ${g.plugin} rule`,
      source,
    };
  } catch (err) {
    return { verdict: "ask", reason: `plugin ${g.plugin} guard failed: ${(err as Error).message}`, source };
  } finally {
    clearTimeout(timer);
  }
}

// A classifier that ignores the signal must not hold the turn.
function settle(pending: Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Guard {
  #home: string;
  #approvals: Approvals;
  #audit: Audit;
  #plugins: () => PluginGuard[];
  #secrets: () => string[];
  #now: () => Date;
  #mode: (agent: string) => ToolMode;
  #classify: (agent: string, request: ClassifyRequest, signal: AbortSignal) => Promise<string> | undefined;
  #classifyMs: number;
  #ruleAsks: () => boolean;
  #blockAsks: () => boolean;

  constructor(opts: {
    home: string;
    approvals: Approvals;
    audit: Audit;
    plugins?: () => PluginGuard[];
    // Token values to hide in cards and the audit.
    secrets?: () => string[];
    now?: () => Date;
    // Read on every call, so a change applies at once.
    mode?: (agent: string) => ToolMode;
    // Unset result: the agent's runtime has no classifier.
    classify?: (agent: string, request: ClassifyRequest, signal: AbortSignal) => Promise<string> | undefined;
    classifyMs?: number;
    // False: a rule ask does not open a card.
    ruleAsks?: () => boolean;
    // True: an askable block opens a card.
    blockAsks?: () => boolean;
  }) {
    this.#home = opts.home;
    this.#approvals = opts.approvals;
    this.#audit = opts.audit;
    this.#plugins = opts.plugins ?? (() => []);
    this.#secrets = opts.secrets ?? (() => []);
    this.#now = opts.now ?? (() => new Date());
    this.#mode = opts.mode ?? (() => "full");
    this.#classify = opts.classify ?? (() => undefined);
    this.#classifyMs = opts.classifyMs ?? CLASSIFY_MS;
    this.#ruleAsks = opts.ruleAsks ?? (() => true);
    this.#blockAsks = opts.blockAsks ?? (() => false);
  }

  action(tool: unknown, input: unknown, cwd: unknown): GuardAction {
    return toAction(String(tool ?? ""), input, typeof cwd === "string" && cwd ? cwd : undefined);
  }

  // pluginAsk: a plugin asked, even when rules won.
  async verdict(agent: string, action: GuardAction): Promise<Verdict & { source: string; pluginAsk?: true }> {
    let out: Verdict & { source: string } = { ...judge(action, { loungeHome: this.#home }), source: "rules" };
    let pluginAsk = false;
    for (const g of this.#plugins()) {
      const v = await runPlugin(g, action, agent);
      if (v.verdict === "ask") pluginAsk = true;
      // A plugin block is never askable.
      if (v.verdict === "block" && out.askable) {
        const { askable: _askable, ...floor } = out;
        out = floor;
      }
      if (stronger(out, v) === v && v.verdict !== out.verdict) out = v;
    }
    return pluginAsk ? { ...out, pluginAsk: true } : out;
  }

  // The decision for a Claude hook.
  async check(agent: string, action: GuardAction, signal?: AbortSignal): Promise<GuardResult> {
    const { danger: _danger, ...result } = await this.#decide(agent, action, signal);
    return result;
  }

  // danger: the owner allowed an askable block.
  async #decide(agent: string, action: GuardAction, signal?: AbortSignal): Promise<GuardResult & { danger?: true }> {
    const v = await this.verdict(agent, action);
    const reason = v.reason ?? "the guard stopped it";
    if (v.verdict === "block") {
      if (v.askable && this.#blockAsksOn()) return this.#askBlock(agent, action, v.source, reason, signal);
      this.#log(agent, action, v.verdict, v.source, reason, "blocked");
      return { decision: "deny", reason: `${reason}. This never runs; tell the owner.`, asked: false };
    }
    const mode = this.#modeOf(agent);
    if (mode === "read-only" && isMutating(action, this.#home)) {
      const why = `${agent} is in read-only mode; this call changes files or runs a command`;
      this.#log(agent, action, v.verdict, "mode", why, "denied");
      return { decision: "deny", reason: why, asked: false };
    }
    let skipped: string | undefined;
    if (v.verdict === "ask") {
      if (v.source !== "rules" || v.pluginAsk || this.#ruleAsksOn()) return this.#ask(agent, action, v.verdict, v.source, reason, signal);
      skipped = `rule asks are off: ${reason}`;
    }
    if (mode === "full" || !isMutating(action, this.#home)) {
      if (skipped) this.#log(agent, action, v.verdict, v.source, skipped, "allowed");
      return { decision: "allow", asked: false };
    }
    if (mode === "ask") {
      return this.#ask(agent, action, v.verdict, "mode", "ask mode: the owner approves each change", signal);
    }
    return this.#auto(agent, action, signal);
  }

  // A broken setting keeps the cards.
  #ruleAsksOn(): boolean {
    try {
      return this.#ruleAsks() !== false;
    } catch {
      return true;
    }
  }

  // A broken setting keeps the block.
  #blockAsksOn(): boolean {
    try {
      return this.#blockAsks() === true;
    } catch {
      return false;
    }
  }

  // Read-only still denies a change.
  // Rule asks do not apply here.
  async #askBlock(agent: string, action: GuardAction, source: string, reason: string, signal?: AbortSignal) {
    if (this.#modeOf(agent) === "read-only" && isMutating(action, this.#home)) {
      const why = `${agent} is in read-only mode; this call changes files or runs a command`;
      this.#log(agent, action, "block", "mode", why, "denied");
      return { decision: "deny" as const, reason: why, asked: false };
    }
    const result = await this.#ask(agent, action, "block", source, reason, signal, 0, true);
    return { ...result, danger: true as const };
  }

  #modeOf(agent: string): ToolMode {
    try {
      return this.#mode(agent);
    } catch {
      return "ask";
    }
  }

  async #ask(
    agent: string,
    action: GuardAction,
    verdict: AuditEntry["verdict"],
    source: string,
    reason: string,
    signal?: AbortSignal,
    spentMs = 0,
    danger = false,
  ): Promise<GuardResult> {
    const answer = await this.#approvals.request(
      {
        agent,
        tool: action.tool,
        summary: this.#cardSummary(action),
        reason,
        ...(action.cwd ? { cwd: action.cwd } : {}),
        ...(danger ? { danger: true } : {}),
      },
      signal,
      spentMs,
    );
    const outcome = answer === true ? "allowed" : answer === "timeout" ? "timeout" : "denied";
    this.#log(agent, action, verdict, source, reason, outcome, danger);
    if (answer === true) return { decision: "allow", asked: true };
    const why = answer === "timeout" ? "nobody answered in time" : "the owner denied it";
    return { decision: "deny", reason: `${reason}; ${why}`, asked: true };
  }

  // A write card shows the start of the content, so the owner sees what lands.
  #cardSummary(action: GuardAction): string {
    const head = action.kind === "patch" && action.paths?.length ? action.paths.join("; ") : summaryOf(action);
    const body = action.kind === "write" || action.kind === "patch" ? (action.content ?? "") : "";
    if (body === "") return this.#redact(head);
    const clean = this.#redact(body);
    const excerpt = clean.length > EXCERPT ? `${clean.slice(0, EXCERPT)}\n[cut]` : clean;
    return `${this.#redact(head)}\n${excerpt}`;
  }

  // The agent's own runtime judges.
  // Unclear means a card.
  async #auto(agent: string, action: GuardAction, signal?: AbortSignal): Promise<GuardResult> {
    const prefix = "auto mode";
    const limit = this.#classifyMs;
    const started = performance.now();
    const spent = () => performance.now() - started;
    const request = classifyRequest(agent, action, (text) => this.#redact(text), randomBytes(8).toString("hex"));
    // A long write still goes to the check: its path is whole.
    if (request.commandCut) {
      return this.#ask(agent, action, "allow", "classifier", `${prefix}: the call is too long for the check`, signal);
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("timed out")), limit);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let text: string | undefined;
    let failure = "";
    try {
      const pending = this.#classify(agent, request, combined);
      if (pending === undefined) {
        clearTimeout(timer);
        return this.#ask(agent, action, "allow", "classifier", `${prefix}: no classifier for this runtime`, signal);
      }
      text = await settle(pending, combined);
    } catch (err) {
      failure = this.#redact(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    if (signal?.aborted) {
      const why = "the turn ended before the check finished";
      this.#log(agent, action, "allow", "classifier", `${prefix}: ${why}`, "denied");
      return { decision: "deny", reason: why, asked: false };
    }
    if (text === undefined) {
      return this.#ask(agent, action, "allow", "classifier", `${prefix}: the check failed: ${failure || "no answer"}`, signal, spent());
    }
    const parsed = parseClassifier(text);
    if (parsed.safe) {
      this.#log(agent, action, "allow", "classifier", `${prefix}: the check found it safe`, "auto-allowed");
      return { decision: "allow", asked: false };
    }
    return this.#ask(agent, action, "allow", "classifier", `${prefix}: ${this.#redact(parsed.reason)}`, signal, spent());
  }

  recent(): ReturnType<Audit["recent"]> {
    return this.#audit.recent();
  }

  #redact(text: string): string {
    let out = text;
    for (const s of this.#secrets()) {
      if (s.length >= 8) out = out.split(s).join("[token]");
    }
    return out.replace(/(bearer\s+)[\w.~+/=-]{8,}/gi, "$1[token]");
  }

  #log(
    agent: string,
    action: GuardAction,
    verdict: AuditEntry["verdict"],
    source: string,
    reason: string,
    outcome: AuditEntry["outcome"],
    danger = false,
  ): void {
    this.#audit.add({
      ...(danger ? { danger: true } : {}),
      at: this.#now().toISOString(),
      agent,
      tool: action.tool,
      summary: this.#redact(summaryOf(action)),
      verdict,
      outcome,
      reason,
      source,
    });
  }
}
