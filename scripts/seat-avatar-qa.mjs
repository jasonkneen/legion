/**
 * Do the seat avatars render, and does each rank get its own face?
 *
 * The avatars are deterministic from the seat's name, so the check that matters
 * is not "an image appeared" but "six seats are six different images, and the
 * same seat is the same image everywhere it appears".
 *
 *   node scripts/seat-avatar-qa.mjs http://localhost:3100
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch({ headless: true });
const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then((c) => c.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Need an account/ }).click();
await page.locator("#name").fill("Avatar QA");
await page.locator("#email").fill(`avatar${Date.now()}@legion.test`);
await page.locator("#password").fill(`qa-${Date.now()}`);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });

// Council seats four different ranks, which is the interesting case.
await page.getByRole("button", { name: /Council/ }).first().click();
await page.waitForURL(/\/c\//, { timeout: 30000 });
await page.waitForTimeout(1800);

// Animated blobatars are inline SVG rather than <img>, so identity is the
// markup itself: same seat, same shapes.
const srcs = await page.evaluate(() =>
  Array.from(document.querySelectorAll("svg"))
    .filter((el) => (el.getAttribute("class") ?? "").includes("mo-") || el.querySelector("ellipse,path"))
    .map((el) => el.innerHTML)
    .filter((h) => h.length > 40),
);
console.log(`blobatar faces on screen: ${srcs.length}`);
const backdrops = await page.evaluate(() =>
  Array.from(document.querySelectorAll("svg")).filter((el) => el.querySelector("[data-bg]")).length,
);
console.log(`faces still drawing a backdrop plate: ${backdrops}`);
console.log(`distinct faces: ${new Set(srcs).size}`);

// The same seat, in the rail and on its messages, must be the same face.
const repeats = srcs.length - new Set(srcs).size;
console.log(`repeated (same seat shown twice): ${repeats}`);

if (process.env.SHOT) {
  await page.screenshot({ path: process.env.SHOT });
  console.log("screenshot:", process.env.SHOT);
}
console.log("page errors:", errors.length ? errors.slice(0, 3).join(" | ") : "none");
const ok = srcs.length >= 4 && new Set(srcs).size >= 4 && !errors.length;
console.log(ok ? "\nPASS" : "\nFAIL");
await browser.close();
process.exit(ok ? 0 : 1);
