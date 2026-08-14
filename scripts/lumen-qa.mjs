import { chromium } from "playwright";

const base = "http://127.0.0.1:8080";
const browser = await chromium.launch({ headless: true });
const errors = [];

async function shot(page, name) {
  await page.screenshot({ path: `/workspace/screenshots/${name}.png`, fullPage: false });
  console.log("shot", name);
}

const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await desktop.newPage();
page.on("pageerror", (err) => {
  errors.push(err.message);
  console.log("PAGEERROR", err.message);
});
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE", msg.text());
});

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await shot(page, "login");

const email = `lumen${Date.now()}@demo.test`;
await page.getByRole("button", { name: "Need an account? Create one" }).click();
await page.locator("#name").fill("Host");
await page.locator("#email").fill(email);
await page.locator("#password").fill("lumen-pass-1");
await page.getByRole("button", { name: "Create account" }).click();
await page.waitForURL((url) => url.pathname === "/", { timeout: 20000 });
await page.waitForTimeout(600);
await shot(page, "home");

await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await shot(page, "settings");
const settingsText = await page.locator("body").innerText();
if (!/xAI|OpenAI|Anthropic|DeepSeek|Codex|Connect ChatGPT|setup-token|Also in LobeChat/.test(settingsText)) {
  console.log("WARN settings missing oauth/providers");
  console.log(settingsText.slice(0, 800));
} else {
  console.log("SETTINGS_OK");
}

await page.getByRole("button", { name: /more providers/i }).click();
await page.waitForTimeout(300);
await shot(page, "settings-more");
const moreText = await page.locator("body").innerText();
if (!/OpenRouter|Groq|Ollama|GitHub Models/.test(moreText)) {
  console.log("WARN more providers missing");
}

await page.goto(`${base}/discover`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
await shot(page, "discover");
const discoverText = await page.locator("body").innerText();
if (!/Codex|Studio/.test(discoverText)) console.log("WARN discover missing Codex/Studio");

await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Just Chat/ }).first().click();
await page.waitForURL(/\/c\//, { timeout: 20000 });
await page.waitForTimeout(600);
await shot(page, "chat-empty");

await page.locator("textarea").click();
await page.locator("textarea").pressSequentially("Say only hello.", { delay: 8 });
await page.getByRole("button", { name: "Send" }).click();
await page.waitForTimeout(800);
await shot(page, "chat-thinking");
const chatText = await page.locator("body").innerText();
console.log("CHAT", chatText.replace(/\s+/g, " ").slice(0, 500));

await page.waitForTimeout(2500);
await shot(page, "chat-after");

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mpage = await mobile.newPage();
await mpage.goto(`${base}/login`, { waitUntil: "networkidle" });
await shot(mpage, "login-mobile");
await mpage.locator("#email").fill(email);
await mpage.locator("#password").fill("lumen-pass-1");
await mpage.getByRole("button", { name: "Sign in" }).click();
await mpage.waitForURL((url) => url.pathname === "/" || url.pathname.startsWith("/c/"), { timeout: 20000 });
await mpage.waitForTimeout(500);
await shot(mpage, "home-mobile");
await mpage.goto(`${base}/settings`, { waitUntil: "networkidle" });
await mpage.waitForTimeout(500);
await shot(mpage, "settings-mobile");

console.log("ERRORS", errors);
await browser.close();
if (errors.length) process.exit(1);
