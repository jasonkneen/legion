/**
 * Find what makes the document taller than the viewport.
 *
 * Reports every element whose bottom edge sits below the viewport bottom while
 * the page is at scrollTop 0 — the ones actually creating the scroll — plus the
 * usual suspects (body children, portals) with their heights.
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const [W, H] = (process.argv[3] ?? "1440x1150").split("x").map(Number);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 160)));

await p.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
if (await p.getByRole("button", { name: /Need an account/i }).count()) {
  await p.getByRole("button", { name: /Need an account/i }).click();
  await p.getByLabel("Name").fill("Overflow");
  await p.getByLabel("Email").fill(`ovf${Date.now()}@test.com`);
  await p.getByLabel("Password").fill("password123");
  await p.getByRole("button", { name: /Create account/i }).click();
}
await p.getByText("Council", { exact: true }).first().waitFor({ state: "visible", timeout: 120000 });
await p.getByText("Council", { exact: true }).first().click();
await p.locator("textarea").first().waitFor({ state: "visible", timeout: 40000 });
await p.waitForTimeout(2000);

const report = async (label) => {
  const m = await p.evaluate(() => {
    const vh = window.innerHeight;
    const doc = document.documentElement;
    const offenders = [];
    // Walk every element; record the ones extending past the viewport bottom.
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.bottom > vh + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 60),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          h: Math.round(r.height),
          pos: getComputedStyle(el).position,
        });
      }
    }
    return {
      vh,
      docScroll: doc.scrollHeight,
      bodyScroll: document.body.scrollHeight,
      scrollY: window.scrollY,
      bodyChildren: Array.from(document.body.children).map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 50),
        h: Math.round(el.getBoundingClientRect().height),
        pos: getComputedStyle(el).position,
      })),
      // Deepest-first keeps the actual culprit near the top of the list.
      offenders: offenders.sort((a, z) => z.bottom - a.bottom).slice(0, 8),
    };
  });
  console.log(`\n[${label}] vh=${m.vh} docScroll=${m.docScroll} bodyScroll=${m.bodyScroll} scrollY=${m.scrollY}`);
  console.log(`  overflow: ${m.docScroll - m.vh}px`);
  console.log("  body children:");
  for (const c of m.bodyChildren) console.log(`    <${c.tag}> h=${c.h} pos=${c.pos} ${c.cls}`);
  if (m.offenders.length) {
    console.log("  elements past the viewport bottom:");
    for (const o of m.offenders) console.log(`    <${o.tag}> top=${o.top} bottom=${o.bottom} h=${o.h} pos=${o.pos} ${o.cls}`);
  } else {
    console.log("  nothing extends past the viewport");
  }
};

await report("after opening a chat");

// Reproduce the user's state: several messages in the thread.
await p.locator("textarea").first().fill("@grok say hello in one short line");
await p.locator("textarea").first().press("Enter");
for (let i = 0; i < 60; i += 1) {
  await p.waitForTimeout(2000);
  if ((await p.locator("article").count()) > 0 && (await p.locator("text=/Enter to send/").count())) break;
}
await report("after a reply");

await p.mouse.wheel(0, 500);
await p.waitForTimeout(500);
console.log("scrollY after wheel:", await p.evaluate(() => window.scrollY));
await p.screenshot({
  path: "/private/tmp/claude-501/-Users-jkneen-Documents-GitHub-legion/5c4eae13-e694-46ed-8560-32bedc25a5b8/scratchpad/overflow.png",
});
await b.close();
