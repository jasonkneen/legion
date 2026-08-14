import { chromium } from "playwright";

const base = "http://127.0.0.1:8080";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("PAGEERROR", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE", msg.text());
});

const email = `chat${Date.now()}@chamber.test`;
await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Need an account? Create one" }).click();
await page.locator("#name").fill("Host");
await page.locator("#email").fill(email);
await page.locator("#password").fill("chamber-pass-1");
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((url) => url.pathname === "/", { timeout: 20000 });
await page.getByRole("button", { name: /Just Grok/ }).click();
await page.waitForURL(/\/c\//, { timeout: 20000 });
await page.waitForTimeout(800);
await page.locator("textarea").click();
await page.locator("textarea").pressSequentially("Say only: hello from grok.", { delay: 10 });
await page.getByRole("button", { name: "Send" }).click();

const started = Date.now();
while (Date.now() - started < 55000) {
  const body = await page.locator("body").innerText();
  const snippet = body.replace(/\s+/g, " ").slice(0, 400);
  console.log("tick", Date.now() - started, snippet);
  if (/thinking|hello from grok|couldn't finish|not connected|saved/i.test(body) && /Grok/.test(body)) {
    if (Date.now() - started > 2500) {
      // keep waiting if still thinking
      if (!/is thinking/.test(body) || Date.now() - started > 50000) break;
    }
  }
  await page.waitForTimeout(2000);
}

await page.screenshot({ path: "/workspace/screenshots/chat-live.png" });
console.log("FINAL", (await page.locator("body").innerText()).slice(0, 800));
await browser.close();
