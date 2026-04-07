import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "test-frames");

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions("http://localhost:3000", ["camera"]);

  await page.goto("http://localhost:3000", { waitUntil: "networkidle0", timeout: 15000 });
  const btn = await page.waitForSelector("button");
  await btn.click();
  await new Promise(r => setTimeout(r, 2500));

  await page.screenshot({ path: path.join(OUT, "zoom-1x.png") });

  // Check borders: sample pixels at edges
  const result = await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    // We can't easily screenshot canvas from inside, so check video element bounds
    const v = document.querySelector("video");
    if (!v) return { error: "no video" };
    const rect = v.getBoundingClientRect();
    const style = getComputedStyle(v);
    return {
      videoRect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      videoNaturalSize: { w: v.videoWidth, h: v.videoHeight },
      display: style.display,
      transform: style.transform,
      // Check if video covers viewport
      coversLeft: rect.left <= 0,
      coversRight: rect.right >= window.innerWidth,
      coversTop: rect.top <= 0,
      coversBottom: rect.bottom >= window.innerHeight,
      fullCoverage: rect.left <= 0 && rect.right >= window.innerWidth && rect.top <= 0 && rect.bottom >= window.innerHeight,
    };
  });

  console.log("Video coverage at zoom 1.0x:");
  console.log(JSON.stringify(result, null, 2));
  console.log(result.fullCoverage ? "\nRESULT: FULL COVERAGE - no borders" : "\nRESULT: HAS BORDERS - needs fix");

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
