import { appendFileSync, renameSync, statSync } from "node:fs";

export type DropReason = "idle" | "cap" | "revoke" | "close";

export type SessionEvent =
  | { kind: "drop"; reason: DropReason; caller: string; session: string; ageMs: number }
  | { kind: "404"; method: string; caller: string; session: string }
  | { kind: "stateless"; caller: string; session: string };

export const SESSION_LOG_MAX_BYTES = 1024 * 1024;
const SESSION_PREFIX = 8;

// A client sets the session id and the method.
// Keep one line per event.
function clean(value: string): string {
  return value.replace(/[^A-Za-z0-9:._@-]/g, "_");
}

function fields(event: SessionEvent): string[] {
  const session = clean(event.session.slice(0, SESSION_PREFIX));
  switch (event.kind) {
    case "drop":
      return [`reason=${event.reason}`, `caller=${clean(event.caller)}`, `session=${session}`, `ageMs=${Math.round(event.ageMs)}`];
    case "404":
      return [`method=${clean(event.method)}`, `caller=${clean(event.caller)}`, `session=${session}`];
    case "stateless":
      return [`caller=${clean(event.caller)}`, `session=${session}`];
  }
}

export function sessionLog(file: string, now: () => Date = () => new Date()): (event: SessionEvent) => void {
  return (event) => {
    try {
      const line = `${now().toISOString()} ${event.kind} ${fields(event).join(" ")}\n`;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // No file yet.
      }
      if (size > 0 && size + Buffer.byteLength(line) > SESSION_LOG_MAX_BYTES) {
        try {
          renameSync(file, `${file}.1`);
        } catch {
          // A reader may hold the file. Append anyway.
        }
      }
      appendFileSync(file, line);
    } catch {
      // A log fault must not fail the request.
    }
  };
}
