/**
 * The two approval scopes where a mistake is worst, driven in a real browser.
 *
 * `Decline` must actually stop the write — not merely look like it while the
 * turn writes anyway. `Always allow` must persist past the chamber it was
 * granted in, which is the whole point of it and also the reason it is the most
 * dangerous button on the screen: nothing else here outlives the session.
 *
 * Point this at a throwaway server, never the one you are using:
 *   DATA_DIR=/tmp/qa-data LEGION_TOOLS_ROOT=/tmp/qa-workspace \
 *     node node_modules/.bin/vite dev --port 3100
 *   node scripts/approval-scopes-qa.mjs http://localhost:3100 /tmp/qa-workspace
 */
import { chromium } from "playwright";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3100";
const workspace = process.argv[3];
if (!workspace) {
  console.error("Pass the server's LEGION_TOOLS_ROOT so files can be checked on disk.");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser
  .newContext({ viewport: { width: 1280, height: 1000 } })
  .then((c) => c.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Need an account/ }).click();
await page.locator("#name").fill("Scope QA");
await page.locator("#email").fill(`scope${Date.now()}@legion.test`);
await page.locator("#password").fill(`qa-${Date.now()}`);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });

// ---------------------------------------------------------------- Decline
console.log("\nDecline");
let target = await askClaudeToWrite("qa-declined.txt");
let prompted = await waitForPrompt();
check("the seat asked before writing", prompted);
if (prompted) {
  await page.getByRole("button", { name: /Decline/ }).first().click();
  // Give the turn long enough that a write would certainly have landed.
  await page.waitForTimeout(20_000);
  check("the file was NOT written", !existsSync(target), existsSync(target) ? "decline was ignored" : "");
  const body = await page.locator("body").innerText();
  check(
    "the chat says it could not",
    /declin|could not|blocked|permission|unable/i.test(body),
    "so the human is not left guessing",
  );
}
await waitForQuiet();

// ------------------------------------------------------- Always allow
console.log("\nAlways allow");
target = await askClaudeToWrite("qa-always-first.txt");
prompted = await waitForPrompt();
check("the first write still asks", prompted);
if (prompted) {
  await page.getByRole("button", { name: /Always allow/ }).first().click();
  check("the file was written", await waitFor(() => existsSync(target), 60_000));
}
await waitForQuiet();

// The real question: does the grant survive a different chamber?
console.log("\nAlways allow, in a new chamber");
await page.goto(base, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Studio/ }).first().click();
await page.waitForURL(/\/c\//, { timeout: 30000 });
await page.waitForTimeout(1500);

const second = await askClaudeToWrite("qa-always-second.txt", false);
const askedAgain = await waitForPrompt(25_000);
check("it did NOT ask again", !askedAgain, askedAgain ? "the standing grant was not honoured" : "");
if (askedAgain) await page.getByRole("button", { name: /Allow once/ }).first().click();
check("the file was written", await waitFor(() => existsSync(second), 60_000));

console.log("\npage errors:", errors.length ? errors.slice(0, 3).join(" | ") : "none");
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");

for (const name of ["qa-declined.txt", "qa-always-first.txt", "qa-always-second.txt"]) {
  rmSync(join(workspace, name), { force: true });
}
await browser.close();
process.exit(failures ? 1 : 0);

/** Seat a chamber if needed, then ask Claude to write a named file. */
async function askClaudeToWrite(name, seatFirst = true) {
  if (seatFirst && !/\/c\//.test(page.url())) {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Studio/ }).first().click();
    await page.waitForURL(/\/c\//, { timeout: 30000 });
    await page.waitForTimeout(1500);
  }
  const path = join(workspace, name);
  rmSync(path, { force: true });
  await page.locator("textarea").click();
  await page.locator("textarea").pressSequentially(
    `@claude Create a file called ${name} containing the word hello. Then reply DONE.`,
    { delay: 5 },
  );
  await page.getByRole("button", { name: "Send" }).click();
  return path;
}

async function waitForPrompt(timeoutMs = 90_000) {
  return waitFor(async () => (await page.getByRole("button", { name: /Allow once/ }).count()) > 0, timeoutMs);
}

/** Let the turn settle so the next case does not start mid-stream. */
async function waitForQuiet() {
  await waitFor(async () => {
    const body = await page.locator("body").innerText();
    return !/is (thinking|working)/i.test(body);
  }, 60_000);
  await page.waitForTimeout(1500);
}

async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
