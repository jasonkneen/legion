/**
 * Browser check for the shared poll and the seat-reach note.
 *
 * The claims being tested are ones static checks cannot see: that four panels
 * now share one request, that an idle chamber settles to the slow cadence, and
 * that the seat menu says what a seat can actually reach. Uses a throwaway
 * account on the local server, the same way the other QA scripts do.
 *
 * Usage: node scripts/chamber-pulse-qa.mjs [baseUrl]
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (err) => errors.push(`PAGEERROR ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`CONSOLE ${msg.text()}`);
});

/** Every server-function call, so the poll can be counted rather than assumed. */
const calls = [];
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("_serverFn") || url.includes("serverFn")) calls.push({ at: Date.now(), url });
});

const email = `pulse${Date.now()}@legion.test`;
await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Need an account/ }).click();
await page.locator("#name").fill("Pulse QA");
await page.locator("#email").fill(email);
await page.locator("#password").fill(`qa-${Date.now()}`);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((url) => url.pathname === "/", { timeout: 30000 });

// Any preset will do; the point is a chamber with at least one seat.
const preset = page.getByRole("button", { name: /Grok|Duo|Panel|Council/ }).first();
await preset.click();
await page.waitForURL(/\/c\//, { timeout: 30000 });
await page.waitForTimeout(1500);

// --- 1. Idle polling: how many server calls in 20 seconds, and to what?
calls.length = 0;
const windowMs = 20_000;
await page.waitForTimeout(windowMs);
const byName = {};
for (const c of calls) {
  const name = decodeURIComponent(c.url).match(/"export":"(\w+)/)?.[1] ?? c.url.split("/").pop().slice(0, 40);
  byName[name] = (byName[name] ?? 0) + 1;
}
console.log(`\nidle ${windowMs / 1000}s — ${calls.length} server call(s)`);
for (const [name, n] of Object.entries(byName).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${n.toString().padStart(3)}  ${name}`);
}
const expectedIdle = Math.floor(windowMs / 8000);
console.log(
  `   expected ~${expectedIdle} at the 8s idle cadence; ` +
    (calls.length <= expectedIdle + 3 ? "OK" : "TOO MANY — panels may still be polling separately"),
);

// --- 2. The seat menu should say what the seat can reach.
const seatButton = page.locator("header button").filter({ hasText: /@|\w/ }).first();
await seatButton.click().catch(() => undefined);
await page.waitForTimeout(1200);
const menu = await page.locator("[role='menu']").innerText().catch(() => "");
console.log("\nseat menu:", menu.replace(/\s+/g, " ").slice(0, 220) || "(no menu opened)");
console.log(
  "   reach note:",
  /Read-only|Can edit with your approval/.test(menu) ? "shown" : "MISSING",
);
await page.keyboard.press("Escape");

// --- 3. A failed turn must offer a way to run it again.
await page.route("**/api/reply", (route) => route.fulfill({ status: 500, body: "nope" }));
await page.locator("textarea").click();
await page.locator("textarea").pressSequentially("Say hello.", { delay: 5 });
await page.getByRole("button", { name: "Send" }).click();
await page.waitForTimeout(4000);
const retry = page.getByRole("button", { name: /Try again/ });
// One row per seat that failed, so the count tracks the number of seats.
const before = await retry.count();
console.log(`\nfailed turn — ${before} retry button(s) offered:`, before ? "yes" : "MISSING");
if (before) {
  // Pressing it must replace that row, not stack a second one beside it.
  await retry.first().click();
  await page.waitForTimeout(4000);
  const after = await page.getByRole("button", { name: /Try again/ }).count();
  console.log(`   after one retry (which fails again): ${after} — ${after === before ? "OK, replaced" : "WRONG, rows are stacking"}`);
}

// --- 4. Nothing may be broken by the refactor.
// The 500s below are this script's own doing; anything else is a real fault.
const realErrors = errors.filter((e) => !/status of 500/.test(e));
console.log("\npage errors (excluding the injected 500s):", realErrors.length ? realErrors.slice(0, 5).join(" | ") : "none");

await browser.close();
process.exit(0);
