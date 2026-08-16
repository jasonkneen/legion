import { chromium } from "playwright";
const base = "http://localhost:3000";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 950 } });
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await p.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
if (await p.getByRole("button", { name: /Need an account/i }).count()) {
  await p.getByRole("button", { name: /Need an account/i }).click();
  await p.getByLabel("Name").fill("Settings");
  await p.getByLabel("Email").fill(`set${Date.now()}@test.com`);
  await p.getByLabel("Password").fill("password123");
  await p.getByRole("button", { name: /Create account/i }).click();
}
await p.waitForTimeout(7000);
await p.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
await p.getByRole("navigation", { name: "Settings sections" }).waitFor({ state: "visible", timeout: 90000 });
const sections = await p.getByRole("navigation", { name: "Settings sections" }).locator("button").allInnerTexts();
console.log("sections:", sections.map(s => s.trim()).join(" | "));
for (const name of ["Accounts", "Tools", "Provider keys", "Providers", "Ranks"]) {
  await p.getByRole("button", { name, exact: true }).click();
  await p.waitForTimeout(1200);
  const h1 = await p.locator("h1").first().innerText();
  console.log(`  ${name} → h1="${h1.trim()}"`);
}
// The whole app must still not scroll.
await p.mouse.wheel(0, 500);
await p.waitForTimeout(300);
console.log("page scrollY:", await p.evaluate(() => window.scrollY));
await p.getByRole("button", { name: "Accounts", exact: true }).click();
await p.waitForTimeout(9000);
await p.screenshot({ path: "/private/tmp/claude-501/-Users-jkneen-Documents-GitHub-legion/5c4eae13-e694-46ed-8560-32bedc25a5b8/scratchpad/settings2.png" });
await b.close();
