import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "./api.ts";
import { notify, notifyApproval, type Notifier } from "./notify.ts";

function message(author: Message["author"], text = "hi"): Message {
  return { id: 1, roomId: "lounge", author, text, createdAt: "2026-11-06T00:00:00Z" };
}

function recorder(result: () => unknown = () => undefined) {
  const sent: { title: string; body: string }[] = [];
  const notifier = {
    sendNotification(opts: { title: string; body: string }) {
      sent.push(opts);
      return result();
    },
  } as Notifier;
  return { sent, notifier };
}

test("a plugin that returns undefined still notifies and does not throw", () => {
  const { sent, notifier } = recorder();
  assert.doesNotThrow(() => notify(message("nana"), { hidden: true, notifier }));
  assert.deepEqual(sent, [{ title: "nana", body: "hi" }]);
});

test("a throwing plugin does not throw out of notify", () => {
  const { notifier } = recorder(() => {
    throw new Error("denied");
  });
  assert.doesNotThrow(() => notify(message("mika"), { hidden: true, notifier }));
});

test("no notification for the owner or a visible window", () => {
  const { sent, notifier } = recorder();
  notify(message("owner"), { hidden: true, notifier });
  notify(message("nana"), { hidden: false, notifier });
  assert.equal(sent.length, 0);
});

test("the body is cut to 120 characters", () => {
  const { sent, notifier } = recorder();
  notify(message("nana", "x".repeat(300)), { hidden: true, notifier });
  assert.equal(sent[0].body.length, 120);
});

test("a session room message does not notify", () => {
  const { sent, notifier } = recorder();
  const fromSession = { ...message("nana"), roomId: "session-abc" };
  notify(fromSession, { hidden: true, notifier });
  assert.deepEqual(sent, []);
});

test("a message in another channel notifies", () => {
  const { sent, notifier } = recorder();
  notify({ ...message("mika"), roomId: "games" }, { hidden: true, notifier });
  assert.equal(sent.length, 1);
});

test("a channel event does not notify", () => {
  const { sent, notifier } = recorder();
  notify({ ...message("nana"), kind: "event" }, { hidden: true, notifier });
  notify({ ...message("nana"), kind: "tool" }, { hidden: true, notifier });
  assert.deepEqual(sent, []);
});

test("the title uses the chosen display name", () => {
  const { sent, notifier } = recorder();
  notify(message("mika"), { hidden: true, notifier, name: () => "Whale" });
  assert.equal(sent[0]?.title, "Whale");
});

const approval = {
  id: "a1",
  agent: "nana",
  tool: "Bash",
  summary: "rm -rf /e/projects/x",
  reason: "recursive delete",
  createdAt: "2026-11-06T00:00:00Z",
  expiresAt: "2026-11-06T00:09:00Z",
};

test("an approval card notifies a hidden window with the tool and command", () => {
  const { sent, notifier } = recorder();
  notifyApproval(approval, { hidden: true, notifier, name: () => "Nana" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Nana needs approval");
  assert.match(sent[0].body, /^Bash: rm -rf/);
});

test("an approval card stays quiet in a visible window and without a notifier", () => {
  const { sent, notifier } = recorder();
  notifyApproval(approval, { hidden: false, notifier });
  assert.deepEqual(sent, []);
  assert.doesNotThrow(() => notifyApproval(approval, { hidden: true }));
});

test("a throwing notifier does not throw out of notifyApproval", () => {
  const { notifier } = recorder(() => {
    throw new Error("denied");
  });
  assert.doesNotThrow(() => notifyApproval(approval, { hidden: true, notifier }));
});
