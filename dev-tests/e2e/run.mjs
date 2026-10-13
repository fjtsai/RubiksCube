// 端到端回歸測試：手勢（含中間層）、觸控、主要流程、相機掃描、持久化、顏色管線、閒置重繪。
// 用法：先 `npm run dev`，再執行 `node dev-tests/e2e/run.mjs [baseUrl] [suite...]`
// 例如 `node dev-tests/e2e/run.mjs http://localhost:5173 gestures camera`
import {
  EXPECTED_TEST_SCAN,
  createReporter,
  debug,
  dragSticker,
  launch,
  openApp,
  stickerPoint,
  touchDriver,
  waitIdle,
} from "./helpers.mjs";

const [baseArg, ...suiteArgs] = process.argv.slice(2);
const base = (baseArg ?? "http://localhost:5173").replace(/\/$/, "");
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };

const suites = {
  async gestures(browser) {
    const report = createReporter("gestures");
    const context = await browser.newContext(PHONE);
    const expectMove = async (page, name, from, to, expected, options) => {
      const before = (await debug(page, () => window.__rubiksDebug.history())).length;
      await dragSticker(page, from, to, options);
      const history = await debug(page, () => window.__rubiksDebug.history());
      const got = history.length > before ? history[history.length - 1] : "(none)";
      report.check(got === expected, `${name}: expected ${expected}, got ${got}`);
      if (history.length > before) {
        await page.click("#btn-undo");
        await page.waitForTimeout(250);
        await waitIdle(page);
      }
    };

    let page = await openApp(context, base);
    await expectMove(page, "3x3 前面中間直排往下", ["F", 1], ["F", 7], "M");
    await expectMove(page, "3x3 前面中間直排往上", ["F", 7], ["F", 1], "M'");
    await expectMove(page, "3x3 前面中間橫排往右", ["F", 3], ["F", 5], "E");
    await expectMove(page, "3x3 頂面中間排往右", ["U", 3], ["U", 5], "S");
    await expectMove(page, "3x3 前面頂排往右", ["F", 0], ["F", 2], "U'");
    await expectMove(page, "3x3 右面後排往下（角落貼紙）", ["R", 2], ["R", 8], "B'");
    await expectMove(page, "3x3 右面前排往上", ["R", 6], ["R", 0], "F'");
    await expectMove(page, "3x3 右面頂排往後", ["R", 0], ["R", 2], "U'");
    await expectMove(page, "3x3 頂面左排往前", ["U", 0], ["U", 6], "L");
    await expectMove(page, "3x3 頂面角落往右", ["U", 0], ["U", 2], "B'");
    await expectMove(page, "3x3 拖太短會彈回", ["F", 3], ["F", 5], "(none)", { fraction: 0.2 });
    await expectMove(page, "3x3 長拖轉半圈", ["F", 3], ["F", 5], "E2", { fraction: 1.7, steps: 24 });
    report.check(await debug(page, () => window.__rubiksDebug.isSolved()), "3x3 復原後回到完成狀態");
    await page.close();

    page = await openApp(context, base, "?cube=5");
    await expectMove(page, "5x5 正中間直排", ["F", 2], ["F", 22], "M");
    await expectMove(page, "5x5 第二直排", ["F", 1], ["F", 21], "2L");
    await expectMove(page, "5x5 第四直排", ["F", 3], ["F", 23], "2R'");
    await expectMove(page, "5x5 正中間橫排", ["F", 10], ["F", 14], "E");
    await expectMove(page, "5x5 第二橫排", ["F", 5], ["F", 9], "2U'");
    await expectMove(page, "5x5 頂面正中間排", ["U", 10], ["U", 14], "S");
    await expectMove(page, "5x5 右面正中間直排", ["R", 22], ["R", 2], "S'");
    await expectMove(page, "5x5 頂面第二排", ["U", 5], ["U", 9], "2B'");
    await expectMove(page, "5x5 前面頂排", ["F", 0], ["F", 4], "U'");
    report.check(await debug(page, () => window.__rubiksDebug.isSolved()), "5x5 復原後回到完成狀態");
    await context.close();
    return report.failures;
  },

  async touch(browser) {
    const report = createReporter("touch");
    const context = await browser.newContext({ ...PHONE, deviceScaleFactor: 2 });
    const page = await openApp(context, base);
    const touch = await touchDriver(context, page);
    const center = { x: 195, y: 520 };

    await touch.swipe(await stickerPoint(page, "F", 1), await stickerPoint(page, "F", 7));
    report.check((await debug(page, () => window.__rubiksDebug.history())).at(-1) === "M", "單指拖中間直排 → M");

    const beforeOrbit = await stickerPoint(page, "F", 4);
    await touch.send("touchStart", [[center.x - 60, center.y], [center.x + 60, center.y]]);
    for (let step = 1; step <= 12; step += 1) {
      await touch.send("touchMove", [[center.x - 60 + step * 10, center.y], [center.x + 60 + step * 10, center.y]]);
      await page.waitForTimeout(16);
    }
    await touch.send("touchEnd", []);
    await page.waitForTimeout(300);
    const afterOrbit = await stickerPoint(page, "F", 4);
    report.check((await debug(page, () => window.__rubiksDebug.history())).length === 1, "雙指滑動不會轉層");
    report.check(Math.hypot(afterOrbit.x - beforeOrbit.x, afterOrbit.y - beforeOrbit.y) > 30, "雙指滑動會旋轉視角");

    for (let tap = 0; tap < 2; tap += 1) {
      await touch.send("touchStart", [[16, 430]]);
      await touch.send("touchEnd", []);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(700);
    const reset = await stickerPoint(page, "F", 4);
    const fresh = await openApp(context, base);
    const expected = await stickerPoint(fresh, "F", 4);
    await fresh.close();
    report.check(Math.hypot(reset.x - expected.x, reset.y - expected.y) < 6, "點兩下空白處回到預設視角");

    const span = async () => {
      const a = await stickerPoint(page, "U", 0);
      const b = await stickerPoint(page, "D", 8);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const before = await span();
    await touch.send("touchStart", [[center.x - 40, center.y], [center.x + 40, center.y]]);
    for (let step = 1; step <= 10; step += 1) {
      await touch.send("touchMove", [[center.x - 40 - step * 6, center.y], [center.x + 40 + step * 6, center.y]]);
      await page.waitForTimeout(16);
    }
    await touch.send("touchEnd", []);
    await page.waitForTimeout(300);
    const zoomed = await span();
    report.check(zoomed > before * 1.15 && zoomed < before * 1.5, `雙指捏合放大且有上限（${Math.round(before)} → ${Math.round(zoomed)}）`);
    await page.click("#btn-view-reset");
    await page.waitForTimeout(700);
    report.check(Math.abs((await span()) - before) < 4, "視角回正按鈕恢復縮放");

    await touch.swipe({ x: 16, y: 640 }, { x: 16, y: 470 }, 16);
    await touch.swipe(await stickerPoint(page, "D", 3), await stickerPoint(page, "D", 5));
    report.check((await debug(page, () => window.__rubiksDebug.history())).at(-1) === "S'", "從底部視角拖 D 面中間排 → S'");
    await context.close();
    return report.failures;
  },

  async flows(browser) {
    const report = createReporter("flows");
    const context = await browser.newContext({ ...PHONE, deviceScaleFactor: 2 });
    const page = await openApp(context, base);

    await page.click("#btn-scramble");
    await page.waitForTimeout(300);
    await waitIdle(page);
    await page.click("#btn-pad-toggle");
    for (const move of ["R", "R", "R"]) await page.click(`[data-move="${move}"]`);
    await page.waitForTimeout(200);
    await waitIdle(page);
    const tail = (await debug(page, () => window.__rubiksDebug.history())).slice(-3).join(" ");
    report.check(tail === "R R R", `快速連點按鈕會排隊執行（${tail}）`);
    await page.click('[data-depth="middle"]');
    for (const move of ["M", "E'", "S"]) {
      await page.click(`[data-move="${move}"]`);
      await page.waitForTimeout(300);
      await waitIdle(page);
    }
    const centers = await debug(page, () => {
      const raw = window.__rubiksDebug.facelets();
      return [4, 13, 22, 31, 40, 49].map((index) => raw[index]).join("");
    });
    report.check(centers !== "URFDLB", `中間層轉動會讓中心換位（${centers}）`);
    await page.click("#btn-hint");
    await page.waitForFunction(() => window.__rubiksDebug.plan(), null, { timeout: 15000 });
    await page.click("#btn-step");
    await page.waitForTimeout(300);
    await waitIdle(page);
    report.check((await debug(page, () => window.__rubiksDebug.plan()))?.index === 1, "一步會沿著解法前進");
    await page.click("#btn-auto");
    await page.waitForTimeout(300);
    await waitIdle(page, 60000);
    report.check(await debug(page, () => window.__rubiksDebug.isSolved()), "中心換位後自動解仍能解開");
    report.check(await page.isVisible("#celebration"), "完成時顯示慶祝畫面");
    await page.click("#btn-celebration-close");

    await page.click("#btn-import-facelets");
    await page.click("#btn-facelet-test");
    await page.waitForSelector(".review-apply:not([disabled])", { timeout: 15000 });
    await page.click(".review-apply");
    await page.waitForFunction(() => window.__rubiksDebug.plan(), null, { timeout: 15000 });
    report.check((await debug(page, () => window.__rubiksDebug.facelets())) === EXPECTED_TEST_SCAN, "示範照片掃描結果正確");
    for (let step = 0; step < 3; step += 1) {
      await page.click("#btn-step");
      await page.waitForTimeout(300);
      await waitIdle(page);
    }
    await page.click("#btn-undo");
    await page.waitForTimeout(300);
    await waitIdle(page);
    report.check((await debug(page, () => window.__rubiksDebug.plan()))?.index === 2, "上一步會讓解題步驟倒退");
    await page.click("#btn-auto");
    await page.waitForTimeout(300);
    await waitIdle(page, 60000);
    report.check(await debug(page, () => window.__rubiksDebug.isSolved()), "掃描的魔方可以解開");
    await context.close();
    return report.failures;
  },

  async camera(browser) {
    const report = createReporter("camera");
    for (const [mode, width, height] of [["manual", 390, 844], ["auto", 390, 844], ["manual", 844, 390]]) {
      const context = await browser.newContext({ ...PHONE, viewport: { width, height } });
      // 用 1280x720 橫向的合成相機串流取代實體相機（很多手機直拿時也會回傳橫向畫面）。
      await context.addInitScript(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext("2d");
        const camera = (window.__fakeCam = { image: null, rect: null, rotation: 0, filter: "none" });
        const draw = () => {
          ctx.filter = "none";
          ctx.fillStyle = "#4a4f57";
          ctx.fillRect(0, 0, 1280, 720);
          if (camera.image && camera.rect) {
            ctx.save();
            ctx.translate(camera.rect.cx, camera.rect.cy);
            ctx.rotate((camera.rotation * Math.PI) / 2);
            ctx.filter = camera.filter;
            ctx.drawImage(camera.image, -camera.rect.size / 2, -camera.rect.size / 2, camera.rect.size, camera.rect.size);
            ctx.restore();
          }
          setTimeout(draw, 33);
        };
        draw();
        const stream = canvas.captureStream(30);
        navigator.mediaDevices.getUserMedia = async () => stream;
      });
      const page = await openApp(context, base);
      await page.evaluate((auto) => localStorage.setItem("kids-rubiks.scanner.auto", auto ? "1" : "0"), mode === "auto");
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      await page.click("#btn-import-facelets");
      await page.click("#btn-facelet-scan");
      await page.waitForTimeout(1000);
      const shots = [["F", 0, "none"], ["R", 1, "brightness(0.78)"], ["B", 2, "brightness(1.15) sepia(0.12)"], ["L", 3, "saturate(0.85)"], ["U", 1, "brightness(0.9) hue-rotate(-6deg)"], ["D", 2, "brightness(1.08)"]];
      for (const [index, [face, rotation, filter]] of shots.entries()) {
        // 把魔方畫在「畫面上的框線」對應到影片像素的位置，模擬使用者對準框線。
        await page.evaluate(async ({ face, rotation, filter }) => {
          const image = new Image();
          image.src = `/test-scans/scan-${face}.svg`;
          await image.decode();
          const video = document.querySelector(".scanner-video").getBoundingClientRect();
          const frame = document.querySelector(".scanner-frame").getBoundingClientRect();
          const scale = Math.max(video.width / 1280, video.height / 720);
          const offsetX = (video.width - 1280 * scale) / 2;
          const offsetY = (video.height - 720 * scale) / 2;
          Object.assign(window.__fakeCam, {
            image,
            rotation,
            filter,
            rect: {
              cx: (frame.left + frame.width / 2 - video.left - offsetX) / scale,
              cy: (frame.top + frame.height / 2 - video.top - offsetY) / scale,
              size: (frame.width / scale) * (720 / 484),
            },
          });
        }, { face, rotation, filter });
        await page.waitForTimeout(450);
        if (mode === "auto") {
          await page.waitForFunction((count) => document.querySelectorAll(".scanner-chip.done").length >= count || !document.querySelector(".scanner-review.hidden"), index + 1, { timeout: 8000 });
        } else {
          await page.click(".scanner-shutter");
        }
        await page.waitForTimeout(300);
      }
      await page.waitForSelector(".review-apply:not([disabled])", { timeout: 8000 });
      await page.click(".review-apply");
      await page.waitForTimeout(1200);
      report.check((await debug(page, () => window.__rubiksDebug.facelets())) === EXPECTED_TEST_SCAN, `${mode} 拍攝 ${width}x${height}：重建出正確狀態`);
      await context.close();
    }
    return report.failures;
  },

  async persistence(browser) {
    const report = createReporter("persistence");
    const context = await browser.newContext(PHONE);
    const page = await openApp(context, base, "", { skipCoach: false });
    await page.evaluate(() => {
      localStorage.setItem("kids-rubiks.moves", JSON.stringify(["R", "U", "R'", "F2"]));
      localStorage.setItem("kids-rubiks.sound", "0");
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    report.check((await debug(page, () => window.__rubiksDebug.history())).join(" ") === "R U R' F2", "讀得到舊版的移動紀錄");
    report.check(await page.evaluate(() => document.getElementById("btn-sound").classList.contains("muted")), "沿用舊版的音效設定");
    report.check(await page.isVisible("#gesture-coach"), "舊玩家會看到一次新手勢說明");
    await page.click("#btn-gesture-coach-close");
    await page.click("#btn-pad-toggle");
    await page.click('[data-depth="middle"]');
    await page.click('[data-move="M"]');
    await page.waitForTimeout(350);
    await waitIdle(page);
    const before = await debug(page, () => window.__rubiksDebug.facelets());
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    report.check((await debug(page, () => window.__rubiksDebug.facelets())) === before, "含中間層的進度重新整理後還原");
    await context.close();
    return report.failures;
  },

  async colorPage(browser) {
    const report = createReporter("color-page");
    const page = await browser.newPage();
    await page.goto(`${base}/dev-tests/color-test.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__colorTestResults, null, { timeout: 30000 });
    const results = await page.evaluate(() => window.__colorTestResults);
    for (const result of results) report.check(result.ok, `${result.name}（糾錯 ${result.corrections} 格，${result.ms.toFixed(1)}ms）`);
    await page.close();
    return report.failures;
  },

  async idleRender(browser) {
    const report = createReporter("idle-render");
    const context = await browser.newContext(PHONE);
    const page = await openApp(context, base);
    const count = () => debug(page, () => window.__rubiksDebug.renderCount());
    const start = await count();
    await page.waitForTimeout(1500);
    report.check((await count()) - start === 0, "閒置時不重繪");
    await context.close();
    return report.failures;
  },
};

const selected = suiteArgs.length > 0 ? suiteArgs : Object.keys(suites);
const browser = await launch();
let failures = 0;
for (const name of selected) {
  const suite = suites[name];
  if (!suite) {
    console.log(`未知的測試組：${name}（可用：${Object.keys(suites).join(", ")}）`);
    failures += 1;
    continue;
  }
  failures += await suite(browser);
}
await browser.close();
console.log(failures === 0 ? "\nALL E2E PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
