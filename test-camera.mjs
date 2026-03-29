import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "test-frames");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

async function run() {
  console.log("Launching Chrome with fake camera...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--allow-file-access-from-files",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); // iPhone-like

  // Grant camera permission
  const context = browser.defaultBrowserContext();
  await context.overridePermissions("http://localhost:3000", ["camera"]);

  console.log("Navigating to localhost:3000...");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle0", timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, "00-start-screen.png") });
  console.log("Captured: start screen");

  // Click "Abrir Cámara"
  console.log("Clicking 'Abrir Cámara'...");
  const btn = await page.waitForSelector("button");
  await btn.click();

  // Wait for camera to initialize
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(OUT, "01-after-click.png") });
  console.log("Captured: after click (2s)");

  // Capture 5 frames over 3 seconds
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const fname = `02-frame-${i}.png`;
    await page.screenshot({ path: path.join(OUT, fname) });
    console.log(`Captured: ${fname}`);
  }

  // Analyze frames - check if they're all black
  console.log("\n--- PIXEL ANALYSIS ---");
  for (const file of fs.readdirSync(OUT).sort()) {
    const result = await page.evaluate(async (imgPath) => {
      const resp = await fetch(`data:image/png;base64,${imgPath}`);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let nonBlack = 0;
      let total = data.length / 4;
      // Sample center area (40-60% of image)
      const startX = Math.floor(bmp.width * 0.3);
      const endX = Math.floor(bmp.width * 0.7);
      const startY = Math.floor(bmp.height * 0.3);
      const endY = Math.floor(bmp.height * 0.7);
      let centerNonBlack = 0;
      let centerTotal = 0;
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const i = (y * bmp.width + x) * 4;
          centerTotal++;
          if (data[i] > 15 || data[i + 1] > 15 || data[i + 2] > 15) centerNonBlack++;
        }
      }
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 15 || data[i + 1] > 15 || data[i + 2] > 15) nonBlack++;
      }
      return {
        width: bmp.width,
        height: bmp.height,
        totalPixels: total,
        nonBlackPixels: nonBlack,
        percentNonBlack: ((nonBlack / total) * 100).toFixed(1),
        centerNonBlack: centerTotal > 0 ? ((centerNonBlack / centerTotal) * 100).toFixed(1) : "N/A",
      };
    }, fs.readFileSync(path.join(OUT, file)).toString("base64"));

    const status = parseFloat(result.centerNonBlack) > 10 ? "OK" : "BLACK";
    console.log(`${file}: ${result.width}x${result.height} | center non-black: ${result.centerNonBlack}% | total: ${result.percentNonBlack}% | ${status}`);
  }

  // Also check if video element has dimensions
  const videoInfo = await page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return { exists: false };
    return {
      exists: true,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      readyState: v.readyState,
      paused: v.paused,
      srcObject: !!v.srcObject,
      display: getComputedStyle(v).display,
    };
  });
  console.log("\n--- VIDEO ELEMENT ---");
  console.log(JSON.stringify(videoInfo, null, 2));

  await browser.close();
  console.log("\nDone. Frames saved in:", OUT);
}

run().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
