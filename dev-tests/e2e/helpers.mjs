// 端到端測試共用工具：用 playwright-core 開手機尺寸的 headless Chromium。
// 瀏覽器路徑：環境變數 PLAYWRIGHT_CHROMIUM，否則自動找 ~/.cache/ms-playwright 裡最新的 headless shell。
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const EXPECTED_TEST_SCAN = "DLUBUDBRFLBBLRFBRRDUUFFURDDULLRDFFDULRRBLLDDBLBFUBUFFR";

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const name of candidates) {
    const path = join(root, name, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(path)) return path;
  }
  return undefined;
}

export async function launch(extraArgs = []) {
  return chromium.launch({
    executablePath: findChromium(),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", ...extraArgs],
  });
}

export function createReporter(suite) {
  let failures = 0;
  return {
    check(condition, message) {
      console.log(`${condition ? "PASS" : "FAIL"} [${suite}] ${message}`);
      if (!condition) failures += 1;
    },
    get failures() {
      return failures;
    },
  };
}

// 開新頁面並清掉進度；預設略過第一次的手勢說明。
export async function openApp(context, base, query = "", { skipCoach = true } = {}) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.goto(`${base}/${query}`, { waitUntil: "networkidle" });
  await page.evaluate((skip) => {
    localStorage.clear();
    if (skip) localStorage.setItem("kids-rubiks.gesture-coach.seen", "1");
  }, skipCoach);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  return page;
}

export const debug = (page, fn, arg) => page.evaluate(fn, arg);

export async function waitIdle(page, maxMs = 30000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (!(await page.evaluate(() => window.__rubiksDebug.isBusy()))) return;
    await page.waitForTimeout(60);
  }
}

export const stickerPoint = (page, face, index) =>
  page.evaluate(([f, i]) => window.__rubiksDebug.stickerScreenPoint(f, i), [face, index]);

// 用滑鼠從貼紙 A 拖向貼紙 B（fraction 可拖短或拖長），放開後等轉動動畫結束。
export async function dragSticker(page, from, to, { fraction = 1, steps = 14 } = {}) {
  const a = await stickerPoint(page, ...from);
  const target = await stickerPoint(page, ...to);
  const b = { x: a.x + (target.x - a.x) * fraction, y: a.y + (target.y - a.y) * fraction };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(a.x + ((b.x - a.x) * step) / steps, a.y + ((b.y - a.y) * step) / steps);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
  await waitIdle(page);
}

// 透過 CDP 送真實觸控事件（多指）。
export async function touchDriver(context, page) {
  const cdp = await context.newCDPSession(page);
  const send = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
    });
  return {
    send,
    async swipe(a, b, steps = 12) {
      await send("touchStart", [[a.x, a.y]]);
      for (let step = 1; step <= steps; step += 1) {
        await send("touchMove", [[a.x + ((b.x - a.x) * step) / steps, a.y + ((b.y - a.y) * step) / steps]]);
        await page.waitForTimeout(16);
      }
      await send("touchEnd", []);
      await page.waitForTimeout(450);
    },
  };
}
