/**
 * Can a permanent permission be taken back?
 *
 * "Always allow" is the only decision in the app that outlives the session, so
 * the round trip that matters is grant → see it → revoke it → be asked again.
 * A revoke that does not reach the next turn is the worst possible outcome:
 * the settings screen would show the permission gone while the tool kept
 * running unattended.
 *
 *   node scripts/standing-approval-qa.mjs http://localhost:3100 /tmp/qa-workspace
 */
import { chromium } from "playwright";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3100";
const workspace = process.argv[3];
if (!workspace) {
  console.error("Pass the server's LEGION_TOOLS_ROOT.");
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
await page.locator("#name").fill("Standing QA");
await page.locator("#email").fill(`standing${Date.now()}@legion.test`);
await page.locator("#password").fill(`qa-${Date.now()}`);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });

// --- Grant it.
console.log("\nGrant");
let target = await askClaudeToWrite("qa-standing-1.txt");
check("asked the first time", await waitForPrompt());
await page.getByRole("button", { name: /Always allow/ }).first().click();
check("wrote the file", await waitFor(() => existsSync(target), 60_000));
await waitForQuiet();

// --- See it.
console.log("\nReview in settings");
await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^Tools/ }).first().click().catch(() => undefined);
await page.waitForTimeout(1500);
let panel = await page.locator("text=Standing decisions").first().isVisible().catch(() => false);
check("the standing decisions panel is there", panel);
const listed = await page.locator("text=runs without asking").count();
check("the grant is listed", listed > 0, listed ? "" : "a permanent permission with nothing showing it");

// --- Take it back.
console.log("\nRevoke");
if (listed > 0) {
  await page.getByRole("button", { name: /Revoke/ }).first().click();
  await page.waitForTimeout(2000);
  check("it disappears from the list", (await page.locator("text=runs without asking").count()) === 0);

  // And it must survive a reload — the row could vanish in local state only.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Tools/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);
  check("still gone after a reload", (await page.locator("text=runs without asking").count()) === 0);
}

// --- The revoke must reach the next turn, not just the screen.
console.log("\nAsk again after revoking");
await page.goto(base, { waitUntil: "networkidle" });
target = await askClaudeToWrite("qa-standing-2.txt");
const askedAgain = await waitForPrompt();
check("the seat asks again", askedAgain, askedAgain ? "" : "REVOKE DID NOT REACH THE TURN — it wrote unattended");
if (askedAgain) await page.getByRole("button", { name: /Decline/ }).first().click();

console.log("\npage errors:", errors.length ? errors.slice(0, 3).join(" | ") : "none");
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
for (const n of ["qa-standing-1.txt", "qa-standing-2.txt"]) rmSync(join(workspace, n), { force: true });
await browser.close();
process.exit(failures ? 1 : 0);

async function askClaudeToWrite(name) {
  if (!/\/c\//.test(page.url())) {
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
