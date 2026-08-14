import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const html = `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;background:#050505;color:#ececec;font-family:Geist,IBM Plex Sans,system-ui,sans-serif}
  .wrap{width:1200px;height:630px;display:flex;flex-direction:column;justify-content:space-between;padding:64px 72px;box-sizing:border-box;background:
    radial-gradient(900px 420px at 88% 0%, rgba(22,119,255,.18), transparent 60%), #050505;}
  .mark{width:64px;height:64px;border-radius:18px;background:#1677ff;display:grid;place-items:center}
  .mark span{font-size:34px;font-weight:600;color:#fff;letter-spacing:-.04em}
  h1{margin:28px 0 0;font-size:64px;letter-spacing:-.04em;font-weight:600}
  p{margin:14px 0 0;font-size:22px;color:#9a9a9a;max-width:720px;line-height:1.45}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .chip{border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:8px 14px;font-size:14px;color:#bdbdbd}
</style></head>
<body><div class="wrap">
  <div>
    <div class="mark"><span>L</span></div>
    <h1>Lumen</h1>
    <p>One table for Grok, Sol, Claude, Gemini, DeepSeek, Kimi, and MiniMax. Add keys. @ them. They share the thread.</p>
  </div>
  <div class="row">
    <span class="chip">Multi-model</span>
    <span class="chip">Group chat</span>
    <span class="chip">Your API keys</span>
  </div>
</div></body></html>`;

writeFileSync("/tmp/og.html", html);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto("file:///tmp/og.html", { waitUntil: "load" });
await page.screenshot({ path: "/workspace/public/og.jpg", type: "jpeg", quality: 90 });
await browser.close();
console.log("wrote /workspace/public/og.jpg");
