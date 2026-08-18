/**
 * Regression tests for the chat core: tools, approvals, todos, questions.
 *
 * These modules are TypeScript under `src/`, so the suite boots Vite's SSR
 * loader once and imports them the same way the server does — no build step, no
 * duplicate implementation to drift.
 *
 * The invariants here are the ones that are dangerous to get wrong: a write
 * tool must never run unattended, a path must never escape the workspace, an
 * "allow once" must not silently become "allow forever". Each was verified by
 * hand when written; this is what keeps them true.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

/** A workspace the tools are allowed to see, isolated from the real repo. */
const root = mkdtempSync(join(tmpdir(), "legion-tools-"));
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "hello.txt"), "hello from the workspace\n");
writeFileSync(join(root, "sub", "nested.txt"), "nested\n");

// Point the tools and the database at scratch space before anything imports them.
process.env.LEGION_TOOLS_ROOT = root;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "legion-data-"));

let server;
let tools;
let approvals;
let todos;
let questions;

before(async () => {
  const { createServer } = await import("vite");
  server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  tools = await server.ssrLoadModule("/src/lib/chat/tools.server.ts");
  approvals = await server.ssrLoadModule("/src/lib/chat/approvals.server.ts");
  todos = await server.ssrLoadModule("/src/lib/chat/todos.server.ts");
  questions = await server.ssrLoadModule("/src/lib/chat/questions.server.ts");
});

after(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const ctx = { userId: "test-user", conversationId: "test-convo", actor: "grok" };

describe("tool sandbox", () => {
  test("reads a file inside the workspace", async () => {
    const out = await tools.runTool("read_file", { path: "hello.txt" }, ctx);
    assert.match(out, /hello from the workspace/);
  });

  test("refuses paths outside the workspace", async () => {
    for (const path of ["../etc/passwd", "/etc/passwd", "sub/../../..", "../../"]) {
      const out = await tools.runTool("read_file", { path }, ctx);
      assert.match(out, /outside the workspace root/, `expected refusal for ${path}`);
    }
  });

  test("unknown tools are reported, not thrown", async () => {
    assert.match(await tools.runTool("rm_rf", {}, ctx), /No such tool/);
  });

  test("a tool failure comes back as text, so a turn survives it", async () => {
    const out = await tools.runTool("read_file", { path: "does-not-exist.txt" }, ctx);
    assert.match(out, /failed|ENOENT/i);
  });
});

describe("write tools require a human", () => {
  test("refuse outright when there is nobody to ask", async () => {
    // The dangerous case: an unattended turn must not fall back to "allow".
    const out = await tools.runTool("write_file", { path: "sneaky.txt", content: "x" });
    assert.match(out, /needs an approval|Refused/i);
  });

  test("park until answered, then run", async () => {
    const call = tools.runTool("write_file", { path: "approved.txt", content: "written\n" }, ctx);
    const pending = await waitForApproval();
    assert.equal(pending.tool, "write_file");
    assert.ok(await approvals.decideApproval(ctx.userId, pending.id, "once"));
    assert.match(await call, /Created approved\.txt/);
  });

  test("a declined call tells the model not to retry", async () => {
    const call = tools.runTool("write_file", { path: "declined.txt", content: "x" }, ctx);
    const pending = await waitForApproval();
    await approvals.decideApproval(ctx.userId, pending.id, "deny");
    assert.match(await call, /declined|Do not retry/i);
  });
});

describe("approval scopes", () => {
  test("`once` does not persist — the next call asks again", async () => {
    const first = tools.runTool("write_file", { path: "a.txt", content: "1" }, ctx);
    await approvals.decideApproval(ctx.userId, (await waitForApproval()).id, "once");
    await first;

    const second = tools.runTool("write_file", { path: "b.txt", content: "2" }, ctx);
    const asked = await waitForApproval();
    assert.ok(asked, "a second call after `once` must ask again");
    await approvals.decideApproval(ctx.userId, asked.id, "once");
    await second;
  });

  test("`session` grants for this conversation only", async () => {
    const convo = { ...ctx, conversationId: "session-scope" };
    const first = tools.runTool("write_file", { path: "c.txt", content: "3" }, convo);
    await approvals.decideApproval(convo.userId, (await waitForApproval("session-scope")).id, "session");
    await first;

    // Same conversation: runs with no prompt at all.
    await tools.runTool("write_file", { path: "d.txt", content: "4" }, convo);
    assert.equal(approvals.pendingApprovals("session-scope").length, 0);

    // A different conversation must not inherit that grant.
    const other = { ...ctx, conversationId: "other-scope" };
    const call = tools.runTool("write_file", { path: "e.txt", content: "5" }, other);
    const asked = await waitForApproval("other-scope");
    assert.ok(asked, "a session grant must not leak into another conversation");
    await approvals.decideApproval(other.userId, asked.id, "deny");
    await call;
  });

  test("answering an unknown id is refused rather than silently accepted", async () => {
    assert.equal(await approvals.decideApproval(ctx.userId, "ap-nope", "once"), false);
  });
});

describe("shared plan", () => {
  test("normalises whatever status wording an agent sends", () => {
    const written = todos.writeTodos("plan-convo", "grok", [
      { text: "one", status: "in progress" },
      { text: "two", status: "DONE" },
      { text: "three", status: "whatever" },
    ]);
    assert.deepEqual(
      written.map((t) => t.status),
      ["in_progress", "completed", "pending"],
    );
  });

  test("keeps ids stable so a status change is not a new row", () => {
    const first = todos.writeTodos("stable-convo", "grok", [{ text: "ship it", status: "pending" }]);
    const second = todos.writeTodos("stable-convo", "claude", [{ text: "ship it", status: "completed" }]);
    assert.equal(second[0].id, first[0].id);
    assert.equal(second[0].status, "completed");
    assert.equal(second[0].actor, "claude");
  });

  test("folds a Codex plan into the same list", () => {
    todos.writeTodosFromCodexPlan("codex-convo", {
      plan: [
        { step: "read the code", status: "completed" },
        { step: "write the fix", status: "in_progress" },
      ],
    });
    const list = todos.listTodos("codex-convo");
    assert.equal(list.length, 2);
    assert.equal(list[0].actor, "codex");
    assert.equal(list[1].status, "in_progress");
  });

  test("one seat publishing does not erase another's steps", () => {
    // The case the app is built for: several seats answering one message. Before
    // this, whichever published last wiped the rest.
    todos.writeTodos("shared-room", "claude", [{ text: "Review the auth flow" }, { text: "Write the summary" }]);
    todos.writeTodos("shared-room", "codex", [{ text: "Patch the login bug" }]);
    const list = todos.listTodos("shared-room");
    assert.deepEqual(
      list.map((t) => t.text),
      ["Review the auth flow", "Write the summary", "Patch the login bug"],
    );
    assert.deepEqual(list.map((t) => t.actor), ["claude", "claude", "codex"]);
  });

  test("a seat can still drop its own step by omitting it", () => {
    todos.writeTodos("drop-room", "grok", [{ text: "one" }, { text: "two" }]);
    todos.writeTodos("drop-room", "grok", [{ text: "one" }]);
    assert.deepEqual(todos.listTodos("drop-room").map((t) => t.text), ["one"]);
  });

  test("a rewrite does not shuffle the list under the reader", () => {
    todos.writeTodos("order-room", "claude", [{ text: "first" }]);
    todos.writeTodos("order-room", "codex", [{ text: "second" }]);
    // Claude speaks again: its step must stay where it was, not jump to the end.
    todos.writeTodos("order-room", "claude", [{ text: "first", status: "completed" }]);
    assert.deepEqual(todos.listTodos("order-room").map((t) => t.text), ["first", "second"]);
    assert.equal(todos.listTodos("order-room")[0].status, "completed");
  });

  test("drops empty rows rather than showing blank todos", () => {
    const written = todos.writeTodos("empty-convo", "grok", [{ text: "  " }, { text: "real" }]);
    assert.equal(written.length, 1);
  });
});

describe("the plan outlives the server", () => {
  test("comes back after the process that wrote it is gone", async () => {
    const { getSql } = await server.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    await sql`insert into conversations (id, user_id, title) values ('plan-persist', 'test-user', 'Plan')
              on conflict (id) do nothing`;

    todos.writeTodos("plan-persist", "claude", [{ text: "read the code" }, { text: "write the fix" }]);
    todos.writeTodos("plan-persist", "codex", [{ text: "run the tests", status: "in_progress" }]);
    // The write is behind the call; give it a moment to land.
    await new Promise((r) => setTimeout(r, 500));

    todos.clearTodos("plan-persist");
    await new Promise((r) => setTimeout(r, 300));
    // clearTodos persists an empty list, so seed the rows again to stand in for
    // a restart rather than a deletion.
    todos.writeTodos("plan-persist", "claude", [{ text: "read the code" }, { text: "write the fix" }]);
    todos.writeTodos("plan-persist", "codex", [{ text: "run the tests", status: "in_progress" }]);
    await new Promise((r) => setTimeout(r, 500));

    // What a restart looks like: memory empty, rows intact.
    const store = globalThis.__legionTodos__;
    store?.delete("plan-persist");
    assert.equal(todos.listTodos("plan-persist").length, 0);

    const loaded = await todos.loadTodos("plan-persist");
    assert.deepEqual(loaded.map((t) => t.text), ["read the code", "write the fix", "run the tests"]);
    assert.deepEqual(loaded.map((t) => t.actor), ["claude", "claude", "codex"]);
    assert.equal(loaded[2].status, "in_progress");
  });

  test("a step added after reloading sorts after the ones already there", async () => {
    const store = globalThis.__legionTodos__;
    store?.delete("plan-persist");
    await todos.loadTodos("plan-persist");
    todos.writeTodos("plan-persist", "grok", [{ text: "a later thought" }]);
    assert.equal(todos.listTodos("plan-persist").at(-1).text, "a later thought");
  });

  test("ticking a step off does not reassign the whole plan to the host", () => {
    todos.writeTodos("tick-room", "claude", [{ text: "one" }, { text: "two" }]);
    const [first] = todos.listTodos("tick-room");
    todos.setTodoStatus("tick-room", first.id, "completed");
    const after = todos.listTodos("tick-room");
    assert.equal(after[0].status, "completed");
    assert.deepEqual(after.map((t) => t.actor), ["claude", "claude"], "owners must survive a tick");
  });
});

describe("activity history", () => {
  test("survives a restart of the process that logged it", async () => {
    const log = await server.ssrLoadModule("/src/lib/log.server.ts");
    const { getSql } = await server.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    await sql`insert into conversations (id, user_id, title) values ('act-convo', 'test-user', 'Activity')
              on conflict (id) do nothing`;

    log.logEvent({ kind: "tool:end", conversationId: "act-convo", actor: "grok", message: "ran a tool" });
    log.logEvent({ kind: "cli:spawn", conversationId: "act-convo", actor: "claude", message: "spawned" });
    await log.flushActivity();

    // What a restart looks like from here: the ring is gone, the rows are not.
    log.clearEvents();
    assert.equal(log.recentEvents("act-convo").length, 0);
    const stored = await log.storedEvents("act-convo");
    assert.deepEqual(
      stored.map((e) => e.message),
      ["ran a tool", "spawned"],
    );
    assert.equal(new Set(stored.map((e) => e.key)).size, 2, "keys must be unique across a restart");
  });

  test("an event for a chamber that no longer exists is dropped, not retried", async () => {
    const log = await server.ssrLoadModule("/src/lib/log.server.ts");
    log.logEvent({ kind: "tool:end", conversationId: "gone-convo", actor: "grok", message: "orphan" });
    await log.flushActivity();
    // The foreign key rejects it; the queue must not keep it forever.
    assert.equal((await log.storedEvents("gone-convo")).length, 0);
  });
});

describe("grok never writes with its own tools", () => {
  test("nothing in its allowlist touches the workstation", async () => {
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    // Not a style rule: grok reads its permission mode from the workstation's
    // own config, and "always-approve" there means its own write tool would run
    // unattended — it has no way to ask. It writes through Legion's MCP tools
    // instead, which gate themselves. See GROK_DENY_RULES for the measurement.
    const writes = cli.GROK_READONLY_TOOLS.filter((t) =>
      /write|edit|replace|terminal|command|exec|delete|move/i.test(t),
    );
    assert.deepEqual(writes, ["todo_write"], "todo_write writes to the shared plan, not to disk");
  });

  test("and the write tools are denied outright, not merely omitted", async () => {
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    for (const rule of ["Write", "Edit", "Bash", "run_terminal_command", "search_replace"]) {
      assert.ok(cli.GROK_DENY_RULES.includes(rule), `${rule} must be denied`);
    }
  });
});

describe("seat reach", () => {
  test("grok writes only through Legion's tools", async () => {
    const reach = await server.ssrLoadModule("/src/lib/chat/reach.server.ts");
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    const keys = await server.ssrLoadModule("/src/lib/chat/keys.server.ts");
    if (!keys.localCliFor("xai")) return;
    const r = await reach.seatReach("test-user", "xai");
    if (r.route !== "cli") return;

    // It can write — but never with its own tools, which is the whole point:
    // grok cannot ask a human, so it does not get to decide.
    assert.equal(r.canWrite, true);
    assert.deepEqual(r.writes, ["write_file", "run_command"]);
    assert.match(r.note, /cannot ask permission|switched off/i);
    // Derived, not retyped: the displayed reads come from the run path's list.
    for (const tool of r.reads) assert.ok(cli.GROK_READONLY_TOOLS.includes(tool));
  });

  test("an unconfigured provider is reported as mute, not as capable", async () => {
    const reach = await server.ssrLoadModule("/src/lib/chat/reach.server.ts");
    const r = await reach.seatReach("nobody-at-all", "openai");
    if (r.reads.length || r.writes.length) return; // a key is present in this env
    assert.equal(r.canWrite, false);
    assert.match(r.note, /cannot answer/i);
  });
});

describe("the chamber's shared poll", () => {
  test("one idle panel cannot slow the poll while a turn is running", async () => {
    const policy = await server.ssrLoadModule("/src/lib/chat/pulse-policy.ts");
    // The bug this guards: a collapsed panel mounting after the chat view and
    // setting the cadence to idle, so approval prompts take seconds to appear.
    assert.equal(policy.pulseCadence([{ live: false }, { live: true }]), policy.LIVE_MS);
    assert.equal(policy.pulseCadence([{ live: true }, { live: false }]), policy.LIVE_MS);
    assert.equal(policy.pulseCadence([{ live: false }]), policy.IDLE_MS);
    assert.equal(policy.pulseCadence([]), policy.IDLE_MS);
  });

  test("asks only for what a panel is showing", async () => {
    const policy = await server.ssrLoadModule("/src/lib/chat/pulse-policy.ts");
    // `changes` shells out to git, so an unwanted true here is real server work.
    assert.deepEqual(policy.pulseWants([{ wants: {} }, { wants: {} }]), {});
    assert.deepEqual(policy.pulseWants([{ wants: {} }, { wants: { changes: true } }]), { changes: true });
    assert.deepEqual(
      policy.pulseWants([{ wants: { activity: true } }, { wants: { changes: true } }]),
      { activity: true, changes: true },
    );
  });
});

describe("what an approval prompt shows", () => {
  test("names the target whichever word the agent used for it", async () => {
    // Found in a browser run: Claude Code's Write passes `file_path`, which the
    // first version did not recognise, so the human was asked to approve a
    // write with no path on screen.
    const cases = [
      [{ command: "rm -rf build" }, /rm -rf build/],
      [{ path: "src/app.ts" }, /src\/app\.ts/],
      [{ file_path: "/tmp/note.txt" }, /\/tmp\/note\.txt/],
      [{ filePath: "/tmp/camel.txt" }, /\/tmp\/camel\.txt/],
      [{ url: "https://example.com" }, /example\.com/],
    ];
    for (const [args, expected] of cases) {
      const view = approvals.toApprovalView({
        id: "ap-1", conversationId: "c", actor: "claude", tool: "Write",
        reason: "r", args, createdAt: Date.now(),
      });
      assert.match(view.detail, expected, `detail missing for ${JSON.stringify(args)}`);
    }
  });

  test("says how much is being written, not just where", () => {
    const view = approvals.toApprovalView({
      id: "ap-2", conversationId: "c", actor: "claude", tool: "Write",
      reason: "r", args: { file_path: "/tmp/x.txt", content: "one\ntwo\n" }, createdAt: Date.now(),
    });
    assert.match(view.detail, /8 chars, 3 lines/);
  });
});

describe("a shell grant covers one command, not the shell", () => {
  test("remembers Bash per command", () => {
    // The dangerous shape: approving one `npm test` for good, and thereby
    // authorising every future command the seat cares to run.
    assert.equal(approvals.permissionKey("Bash", { command: "npm test" }), "Bash(npm test)");
    assert.notEqual(
      approvals.permissionKey("Bash", { command: "npm test" }),
      approvals.permissionKey("Bash", { command: "rm -rf /" }),
    );
    assert.equal(approvals.permissionKey("codex:run_command", { command: "ls" }), "codex:run_command(ls)");
  });

  test("other tools stay per tool", () => {
    assert.equal(approvals.permissionKey("Write", { file_path: "/tmp/a.txt" }), "Write");
    assert.equal(approvals.permissionKey("read_file", { path: "a.txt" }), "read_file");
  });

  test("a shell with no command falls back to the tool rather than a broken key", () => {
    assert.equal(approvals.permissionKey("Bash", {}), "Bash");
    assert.equal(approvals.permissionKey("Bash", { command: "   " }), "Bash");
  });

  test("a session grant on one command does not cover another", async () => {
    const convo = { userId: "test-user", conversationId: "shell-scope", actor: "claude" };
    const first = tools.runTool("run_command", { command: "echo one" }, convo);
    await approvals.decideApproval(convo.userId, (await waitForApproval("shell-scope")).id, "session");
    await first;

    // Same command again: no prompt.
    void tools.runTool("run_command", { command: "echo one" }, convo);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(approvals.pendingApprovals("shell-scope").length, 0, "the same command should be remembered");

    // A different command must still ask.
    const other = tools.runTool("run_command", { command: "echo two" }, convo);
    const asked = await waitForApproval("shell-scope");
    assert.ok(asked, "a different command must not inherit the grant");
    await approvals.decideApproval(convo.userId, asked.id, "deny");
    await other;
  });
});

describe("a Codex approval names what it is about", () => {
  test("pulls the path and diff out of a fileChange item", async () => {
    // The approval request itself carries only ids; these facts arrive earlier
    // on item/started and have to be joined to it, or the human approves blind.
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    const facts = cli.codexItemFacts({
      type: "fileChange",
      id: "exec-1",
      changes: [{ path: "/w/notes.txt", kind: { type: "add" }, diff: "hello\n" }],
    });
    assert.equal(facts.path, "/w/notes.txt");
    assert.equal(facts.content, "hello\n");
  });

  test("summarises a multi-file change rather than naming only the first", async () => {
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    const facts = cli.codexItemFacts({
      type: "fileChange",
      changes: [{ path: "/w/a.ts", diff: "x" }, { path: "/w/b.ts", diff: "y" }],
    });
    assert.match(facts.path, /2 files: a\.ts, b\.ts/);
  });

  test("takes the command from a commandExecution item", async () => {
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    assert.equal(cli.codexItemFacts({ type: "commandExecution", command: "ls -la" }).command, "ls -la");
  });

  test("returns nothing for items that say nothing useful", async () => {
    const cli = await server.ssrLoadModule("/src/lib/chat/local-cli.server.ts");
    assert.equal(cli.codexItemFacts({ type: "reasoning" }), null);
    assert.equal(cli.codexItemFacts({ type: "fileChange", changes: [] }), null);
    assert.equal(cli.codexItemFacts(undefined), null);
  });
});

describe("what a seat is told after a refusal", () => {
  test("the standing instruction covers other routes, not just retrying", async () => {
    // Measured against Codex, four runs each way: with this line the seat asked
    // once and stopped; without it, it re-attempted in three of four runs, and
    // on a minimal prompt it reached for a shell command to do the same write.
    const prompts = await server.ssrLoadModule("/src/lib/chat/prompts.ts");
    const seat = {
      id: "s1", conversationId: "c", handle: "codex", displayName: "Codex",
      modelId: "gpt-5.6-codex", role: "", seatOrder: 0, createdAt: "",
    };
    const system = prompts.seatSystemPrompt(seat, [seat], null);
    assert.match(system, /declines a tool call/i);
    assert.match(system, /another route|shell command standing in/i);
  });

  test("a declined tool tells the model not to route around it", async () => {
    const call = tools.runTool("write_file", { path: "refused.txt", content: "x" }, ctx);
    await approvals.decideApproval(ctx.userId, (await waitForApproval()).id, "deny");
    const out = await call;
    assert.match(out, /declined/i);
    assert.match(out, /another way/i);
  });
});

describe("deleting a chamber releases what it was holding", () => {
  test("a turn parked on an approval is refused, not left hanging", async () => {
    const convo = { userId: "test-user", conversationId: "doomed-room", actor: "claude" };
    const call = tools.runTool("write_file", { path: "doomed.txt", content: "x" }, convo);
    await waitForApproval("doomed-room");

    // Without this the turn waits out the full five-minute timeout for an
    // answer nobody can give — the screen it would be given on is gone.
    const released = approvals.abandonConversation("doomed-room");
    assert.equal(released, 1);

    const out = await call;
    assert.match(out, /declined/i);
    assert.equal(approvals.pendingApprovals("doomed-room").length, 0);
  });

  test("its session grants do not linger in the process", async () => {
    const convo = { userId: "test-user", conversationId: "grant-room", actor: "claude" };
    const first = tools.runTool("write_file", { path: "g.txt", content: "1" }, convo);
    await approvals.decideApproval(convo.userId, (await waitForApproval("grant-room")).id, "session");
    await first;

    approvals.abandonConversation("grant-room");

    // A fresh call must ask again rather than ride the dead room's grant.
    const call = tools.runTool("write_file", { path: "h.txt", content: "2" }, convo);
    const asked = await waitForApproval("grant-room");
    assert.ok(asked, "the grant should have gone with the chamber");
    await approvals.decideApproval(convo.userId, asked.id, "deny");
    await call;
  });

  test("abandoning one chamber leaves another alone", async () => {
    const keep = { userId: "test-user", conversationId: "kept-room", actor: "claude" };
    const call = tools.runTool("write_file", { path: "k.txt", content: "1" }, keep);
    const asked = await waitForApproval("kept-room");
    approvals.abandonConversation("other-doomed-room");
    assert.equal(approvals.pendingApprovals("kept-room").length, 1, "an unrelated prompt must survive");
    await approvals.decideApproval(keep.userId, asked.id, "deny");
    await call;
  });
});

describe("a seat can bring in another agent", () => {
  const room = { userId: "test-user", conversationId: "seating-room", actor: "grok" };

  before(async () => {
    const { getSql } = await server.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    await sql`insert into conversations (id, user_id, title) values ('seating-room', 'test-user', 'Seating')
              on conflict (id) do nothing`;
  });

  test("adding one asks the human first", async () => {
    // Seating a rank spends the human's money on a model they did not choose,
    // so it belongs behind the same gate as writing to their disk.
    const ranks = await server
      .ssrLoadModule("/src/lib/chat/seats.server.ts")
      .then((m) => m.availableRanks(room.userId, room.conversationId));
    const target = ranks.find((r) => r.configured && !r.seated);
    if (!target) return; // nothing configured in this environment

    const call = tools.runTool("add_seat", { modelId: target.modelId, role: "Second opinion" }, room);
    const pending = await waitForApproval("seating-room");
    assert.equal(pending.tool, "add_seat");
    assert.match(pending.reason, /bring/i);
    await approvals.decideApproval(room.userId, pending.id, "once");
    assert.match(await call, /is now in this chat/i);
  });

  test("a declined one seats nobody", async () => {
    const seats = await server.ssrLoadModule("/src/lib/chat/seats.server.ts");
    const before = await seats.availableRanks(room.userId, room.conversationId);
    const target = before.find((r) => r.configured && !r.seated);
    if (!target) return;

    const call = tools.runTool("add_seat", { modelId: target.modelId, role: "Nope" }, room);
    await approvals.decideApproval(room.userId, (await waitForApproval("seating-room")).id, "deny");
    await call;
    const after = await seats.availableRanks(room.userId, room.conversationId);
    assert.equal(after.find((r) => r.modelId === target.modelId)?.seated, false);
  });

  test("refuses a rank that has no credential, rather than seating something mute", async () => {
    const seats = await server.ssrLoadModule("/src/lib/chat/seats.server.ts");
    const ranks = await seats.availableRanks(room.userId, room.conversationId);
    const mute = ranks.find((r) => !r.configured);
    if (!mute) return;
    // Refused before the approval, so the human is not asked about a dud.
    const out = await tools.runTool("add_seat", { modelId: mute.modelId, role: "x" }, room);
    assert.match(out, /no working credential/i);
    assert.equal(approvals.pendingApprovals("seating-room").length, 0);
  });

  test("an unknown rank is reported, not invented", async () => {
    const out = await tools.runTool("add_seat", { modelId: "gpt-9-imaginary", role: "x" }, room);
    assert.match(out, /no rank called/i);
  });

  test("list_ranks says who is available and who is already here", async () => {
    const out = await tools.runTool("list_ranks", {}, room);
    assert.match(out, /available|already seated|no credential/);
  });
});

describe("question parsing", () => {
  test("accepts a bare object instead of an array", () => {
    const parsed = questions.parseQuestions({
      header: "DB",
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    assert.equal(parsed.length, 1);
    assert.deepEqual(
      parsed[0].options.map((o) => o.label),
      ["Postgres", "SQLite"],
    );
  });

  test("drops questions that offer fewer than two answers", () => {
    const parsed = questions.parseQuestions([
      { question: "Only one?", options: ["yes"] },
      { question: "Two?", options: ["a", "b"] },
    ]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].question, "Two?");
  });

  test("caps at four questions so the form stays answerable", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      question: `q${i}`,
      options: ["a", "b"],
    }));
    assert.equal(questions.parseQuestions(many).length, 4);
  });

  test("falls back to the question text when no header is given", () => {
    const [q] = questions.parseQuestions([{ question: "Pick one", options: ["a", "b"] }]);
    assert.ok(q.header.length > 0);
  });
});

/** Wait for a parked approval to appear, so tests do not race the turn. */
async function waitForApproval(conversationId = ctx.conversationId, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    const [pending] = approvals.pendingApprovals(conversationId);
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no approval was requested");
}
