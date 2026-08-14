import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8080";
const outDir = "/workspace/screenshots";

const browser = await chromium.launch({ headless: true });
const email = `host${Date.now()}@chamber.test`;
const password = "chamber-pass-1";

async function shot(page, name) {
  await page.screenshot({ path: `${outDir}/${name}`, fullPage: false });
  console.log("wrote", name);
}

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("PAGEERROR", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE", msg.text());
});

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Need an account? Create one" }).click();
await page.locator("#name").fill("Jason");
await page.locator("#email").fill(email);
await page.locator("#password").fill(password);
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((url) => url.pathname === "/", { timeout: 20000 });
await page.waitForTimeout(600);
await shot(page, "home.png");

await page.getByRole("button", { name: /Council/ }).click();
await page.waitForURL(/\/c\//, { timeout: 20000 });
await page.waitForTimeout(800);
await shot(page, "chat.png");

await page.getByRole("button", { name: "Add a seat" }).first().click();
await page.waitForTimeout(400);
await shot(page, "add-seat.png");
await page.keyboard.press("Escape");

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const mpage = await mobile.newPage();
await mpage.goto(`${base}/login`, { waitUntil: "networkidle" });
await shot(mpage, "login-mobile.png");
await mpage.locator("#email").fill(email);
await mpage.locator("#password").fill(password);
await mpage.getByRole("button", { name: "Sign in" }).click();
await mpage.waitForURL((url) => url.pathname === "/" || url.pathname.startsWith("/c/"), { timeout: 20000 });
await mpage.waitForTimeout(800);
await shot(mpage, "home-mobile.png");

await browser.close();
console.log("qa done");
