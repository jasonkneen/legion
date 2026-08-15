/**
 * Approval UI end to end, parameterised by prompt so each seat kind can be
 * driven through the same flow: ask for something that needs permission, wait
 * for the panel, click a scope, confirm the turn resumes.
 */
import { chromium } from "playwright";

const base = "http://127.0.0.1:5312";
const prompt = process.argv[2] ?? "@grok use run_command to run: echo hello . Then report its output.";
const scope = process.argv[3] ?? "Allow once";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

await p.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
if (await p.getByRole("button", { name: /Need an account/i }).count()) {
  await p.getByRole("button", { name: /Need an account/i }).click();
  await p.getByLabel("Name").fill("Approval Tester");
  await p.getByLabel("Email").fill(`approve${Date.now()}@test.com`);
  await p.getByLabel("Password").fill("password123");
  await p.getByRole("button", { name: /Create account/i }).click();
}
await p.waitForTimeout(7000);

await p.getByText(process.argv[4] ?? "Council", { exact: true }).first().click();
await p.waitForTimeout(4000);

await p.locator("textarea").first().fill(prompt);
await p.locator("textarea").first().press("Enter");

const panel = p.getByText(/wants to run/);
let appeared = false;
for (let i = 0; i < 90; i += 1) {
  await p.waitForTimeout(1000);
  if (await panel.count()) {
    appeared = true;
    break;
  }
}
if (!appeared) {
  console.log("PANEL NEVER APPEARED (expected when the handle is not seated)");
  const articles = await p.locator("article").allInnerTexts();
  console.log("seat messages after the ask:", articles.length, "(0 means no rank spoke)");
  const note = await p.locator("text=/not seated in this chat/").count();
  console.log("system note shown:", note > 0);
  if (note) console.log("  •", (await p.locator("text=/not seated in this chat/").first().innerText()).slice(0, 200));
  await b.close();
  process.exit(1);
}

console.log("panel:", (await panel.first().innerText()).trim());
await p.getByRole("button", { name: scope }).click();
console.log(`clicked "${scope}"; waiting for the turn…`);
for (let i = 0; i < 90; i += 1) {
  await p.waitForTimeout(2000);
  if ((await panel.count()) === 0 && (await p.locator("text=/Enter to send/").count())) break;
}
const articles = await p.locator("article").allInnerTexts();
console.log("panel still up:", (await panel.count()) > 0);
console.log("last message:", (articles.at(-1) ?? "(none)").replace(/\n+/g, " | ").slice(0, 400));
await b.close();
