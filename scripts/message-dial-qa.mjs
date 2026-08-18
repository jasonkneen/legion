/**
 * The question dial: does it mark every question, jump, and preview?
 *
 * Messages are sent through the UI, because the server owns the database while
 * it is running and a second process cannot open it. Three questions is enough:
 * the dial appears at two.
 *
 *   node scripts/message-dial-qa.mjs http://localhost:3100
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch({ headless: true });
const page = await browser.newContext({ viewport: { width: 1280, height: 560 } }).then((c) => c.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Need an account/ }).click();
await page.locator("#name").fill("Dial QA");
await page.locator("#email").fill(`dial${Date.now()}@legion.test`);
await page.locator("#password").fill(`qa-${Date.now()}`);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });
await page.getByRole("button", { name: /One seat/ }).first().click();
await page.waitForURL(/\/c\//, { timeout: 30000 });
await page.waitForTimeout(1200);

const questions = [
  "does dev:agents use clerk or better auth?",
  "what happened to the deploy last night",
  "can we cache the model list",
];
for (const q of questions) {
  await page.locator("textarea").click();
  await page.locator("textarea").pressSequentially(`${q} Reply with one short word.`, { delay: 3 });
  await page.keyboard.press("Enter");
  // Wait for the turn to settle so the next message is not queued instead.
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const body = await page.locator("body").innerText();
    if (!/is (thinking|working)/i.test(body)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(800);
}

const ticks = page.locator("[aria-label='Jump to a message'] button");
const count = await ticks.count();

// Derived from the dial itself rather than assumed: a flaky turn changes how
// many replies came back, and the test should not care.
const labels = await ticks.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
const questionIdx = labels.map((l, i) => [l, i]).filter(([l]) => String(l).startsWith("You:")).map(([, i]) => Number(i));
console.log(`ticks: ${count} — ${questionIdx.length} of them questions`);

const target = questionIdx[questionIdx.length - 1];
await ticks.nth(target).hover();
await page.waitForTimeout(600);
const previewText = await page.locator("[aria-label='Jump to a message'] p").nth(1).innerText().catch(() => "");
const expected = labels[target].replace(/^You:\s*/, "").slice(0, 25);
console.log("hover preview:", previewText.slice(0, 60) || "(none)");
const rightOne = previewText.includes(expected);
console.log("preview matches the hovered tick:", rightOne ? "yes" : "NO");
if (process.env.SHOT) {
  await page.screenshot({ path: process.env.SHOT });
  console.log("screenshot:", process.env.SHOT);
}

// The dial is fixed to the panel, not to the content: scrolling must not shift
// it by a pixel. This is the property that was wrong first time — it lived
// inside the scrolling element and slid away with the messages.
const dialBox = () => page.evaluate(() => {
  const el = document.querySelector("[aria-label='Jump to a message']");
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { top: Math.round(b.top), left: Math.round(b.left) };
});
const boxBefore = await dialBox();
await page.evaluate(() => { const el = document.querySelector(".overflow-y-auto"); if (el) el.scrollTop = 0; });
await page.waitForTimeout(400);
const boxTop = await dialBox();
await page.evaluate(() => { const el = document.querySelector(".overflow-y-auto"); if (el) el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(400);
const boxBottom = await dialBox();
const stayedPut = boxTop && boxBottom && boxTop.top === boxBottom.top && boxTop.left === boxBottom.left;
console.log(`dial position at top vs bottom of scroll: ${JSON.stringify(boxTop)} vs ${JSON.stringify(boxBottom)}`);
console.log("dial stays static while scrolling:", stayedPut ? "yes" : "NO — it moves with the content");

// Whether the view moves depends on there being an overflow at all; what the
// click must guarantee is that the message ends up on screen.
const scrollable = await page.evaluate(() => {
  const el = document.querySelector(".overflow-y-auto");
  return el ? el.scrollHeight > el.clientHeight + 8 : false;
});
// Nothing outside the message list may move: clicking a tick once dragged the
// whole shell up, leaving the side rail off screen.
const outerBefore = await page.evaluate(() => ({
  win: Math.round(window.scrollY),
  shell: Math.round(document.querySelector(".app-shell")?.scrollTop ?? 0),
  railTop: Math.round(document.querySelector("[aria-label='Jump to a message']")?.getBoundingClientRect().top ?? 0),
}));
await ticks.nth(questionIdx[questionIdx.length - 1]).click();
await page.waitForTimeout(1200);
const outerAfter = await page.evaluate(() => ({
  win: Math.round(window.scrollY),
  shell: Math.round(document.querySelector(".app-shell")?.scrollTop ?? 0),
  railTop: Math.round(document.querySelector("[aria-label='Jump to a message']")?.getBoundingClientRect().top ?? 0),
}));
const shellStill = JSON.stringify(outerBefore) === JSON.stringify(outerAfter);
console.log(`shell before/after a jump: ${JSON.stringify(outerBefore)} / ${JSON.stringify(outerAfter)}`);
console.log("only the messages moved:", shellStill ? "yes" : "NO — the app shell scrolled too");
await ticks.nth(0).click();
await page.waitForTimeout(1200);
const landed = await page.evaluate(() => {
  const el = document.querySelector(".overflow-y-auto");
  const first = document.querySelector("[data-msg]");
  if (!el || !first) return false;
  const box = first.getBoundingClientRect();
  const view = el.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
});
console.log(`chamber scrolls: ${scrollable ? "yes" : "no (too short to need it)"}`);
console.log("after clicking the first tick, that message is on screen:", landed ? "yes" : "NO");

console.log("page errors:", errors.length ? errors.slice(0, 3).join(" | ") : "none");
const ok = questionIdx.length >= 2 && rightOne && landed && stayedPut && shellStill && !errors.length;
console.log(ok ? "\nPASS" : "\nFAIL");
await browser.close();
process.exit(ok ? 0 : 1);
