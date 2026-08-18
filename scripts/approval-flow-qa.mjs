/**
 * End-to-end check of the approval flow, in a real browser.
 *
 * Unit tests cover the registry — park, decide, scope — but nothing had ever
 * driven the actual path a human takes: a seat asks, the prompt appears in the
 * chat, a button is pressed, and the file either exists afterwards or does not.
 * The two halves can disagree (a request that never reaches the panel, a
 * decision that never reaches the turn) and everything still looks healthy.
 *
 * Point this at a throwaway server, not the one you are using:
 *   DATA_DIR=/tmp/qa-data LEGION_TOOLS_ROOT=/tmp/qa-workspace \
 *     node node_modules/.bin/vite dev --port 3100
 *   node scripts/approval-flow-qa.mjs http://localhost:3100 /tmp/qa-workspace
 */
import { chromium } from "playwright";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3100";
const workspace = process.argv[3];
if (!workspace) {
  console.error("Pass the server's LEGION_TOOLS_ROOT so the file can be checked on disk.");
  process.exit(2);
}

const target = join(workspace, "qa-approval-note.txt");
rmSync(target, { force: true });

const browser = await chromium.launch({ headless: true });
const page = await browser
  .newContext({ viewport: { width: 1280, height: 1000 } })
  .then((c) => c.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Need an account/ }).click();
await page.locator("#name").fill("Approval QA");
await page.locator("#email").fill(`approval${Date.now()}@legion.test`);
await page.locator("#password").fill(`qa-${Date.now()}`);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });

// Studio seats Claude, which is the one CLI that can ask before it writes.
await page.getByRole("button", { name: /Studio/ }).first().click();
await page.waitForURL(/\/c\//, { timeout: 30000 });
await page.waitForTimeout(1500);

await page.locator("textarea").click();
await page.locator("textarea").pressSequentially(
  "@claude Create a file called qa-approval-note.txt containing the word hello. Then reply DONE.",
  { delay: 5 },
);
await page.getByRole("button", { name: "Send" }).click();

// --- 1. The request must reach the panel.
const allowOnce = page.getByRole("button", { name: /Allow once/ });
let asked = false;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  if (await allowOnce.count()) {
    asked = true;
    break;
  }
  await page.waitForTimeout(1000);
}
console.log("approval prompt appeared:", asked ? "yes" : "NO — the turn never asked, or the panel never showed it");

if (!asked) {
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  console.log("   chat said:", body.slice(-400));
  console.log("   file on disk:", existsSync(target) ? "WRITTEN WITHOUT ASKING" : "absent (nothing was written)");
  await browser.close();
  process.exit(1);
}

// The whole card, not just its first line: what the human is asked to approve
// has to name the file, or "Allow once" is a coin toss.
const card = await page
  .locator("div", { has: page.locator("text=wants to run") })
  .last()
  .innerText()
  .catch(() => "");
console.log("   panel says:", card.replace(/\s+/g, " ").slice(0, 200));
console.log(
  "   names the file:",
  /qa-approval-note\.txt/.test(card) ? "yes" : "NO — approving blind",
);
console.log("   file before deciding:", existsSync(target) ? "ALREADY WRITTEN — the gate did not hold" : "absent, correct");

// --- 2. The decision must reach the turn.
await allowOnce.first().click();
const wrote = await waitFor(() => existsSync(target), 60_000);
console.log("file written after Allow once:", wrote ? "yes" : "NO — the decision never reached the turn");

// --- 3. The turn must finish rather than hang on an answered prompt.
const finished = await waitFor(async () => {
  const body = await page.locator("body").innerText();
  return /DONE/i.test(body) && !/is (thinking|working)/i.test(body);
}, 60_000);
console.log("turn finished after approval:", finished ? "yes" : "no (still running or no reply)");

console.log("page errors:", errors.length ? errors.slice(0, 3).join(" | ") : "none");
rmSync(target, { force: true });
await browser.close();
process.exit(wrote ? 0 : 1);

async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
