// 顏色辨識管線的驗證頁：合成帶有品牌 logo、反光、不同曝光的魔方照片，
// 走完 取樣 → 分群 → 六面重建與糾錯，比對已知的 facelet 答案。
// 開發時打開 /dev-tests/color-test.html 即可執行。
import { sampleThreeByThreeFromSource } from "../src/domain/color-sampling";
import { reconstructScan } from "../src/domain/scan-reconstruction";
import { FACELET_FACE_ORDER, type ScanFace } from "../src/domain/scanner-state";

const EXPECTED_RAW = "DLUBUDBRFLBBLRFBRRDUUFFURDDULLRDFFDULRRBLLDDBLBFUBUFFR";

type Palette = Record<ScanFace, string>;

const PALETTE: Palette = {
  U: "#f8f8f3",
  R: "#e4493f",
  F: "#2fbd72",
  D: "#ffd84f",
  L: "#f3943b",
  B: "#3478e5",
};

// 實拍常見：紅橘很接近、白色偏藍、黃色偏淡。
const HARD_PALETTE: Palette = {
  U: "#e9eef2",
  R: "#d0342c",
  F: "#1fa65a",
  D: "#e8d23a",
  L: "#ee6a2a",
  B: "#1f5fc9",
};

interface Scenario {
  name: string;
  palette?: Palette;
  logo: "none" | "glyph" | "cap";
  logoFaces: readonly ScanFace[];
  glare: boolean;
  // 拍攝順序（預設 U R F D L B）與每張照片的旋轉次數
  order?: readonly ScanFace[];
  rotations?: readonly number[];
  // 每張照片的 CSS 濾鏡，模擬自動曝光與白平衡變化
  filters?: readonly string[];
  // 對位框偏移（相對魔方大小的比例）
  offset?: { x: number; y: number };
  // 在某一格上蓋一塊強反光
  glareSticker?: { face: ScanFace; index: number };
  // 允許自動糾錯的最多格數（確認畫面會標出來給使用者看）
  maxCorrections?: number;
}

const SHUFFLED: readonly ScanFace[] = ["F", "R", "B", "L", "U", "D"];
const LIGHTING = [
  "brightness(1.12)",
  "brightness(0.74)",
  "brightness(1.05) sepia(0.14)",
  "brightness(0.86) saturate(0.85)",
  "brightness(0.95) hue-rotate(-5deg)",
  "brightness(1.18) contrast(0.9)",
];

const SCENARIOS: readonly Scenario[] = [
  { name: "無 logo（迴歸測試）", logo: "none", logoFaces: [], glare: false },
  { name: "白色中心有品牌 logo", logo: "glyph", logoFaces: ["U"], glare: false },
  { name: "六面中心都有 logo", logo: "glyph", logoFaces: FACELET_FACE_ORDER, glare: false },
  { name: "白色中心大面積圓蓋 logo", logo: "cap", logoFaces: ["U"], glare: false },
  { name: "logo + 斜角反光", logo: "glyph", logoFaces: ["U", "F"], glare: true },
  {
    name: "任意拍攝順序 + 每面不同旋轉",
    logo: "glyph",
    logoFaces: ["U"],
    glare: false,
    order: SHUFFLED,
    rotations: [1, 2, 3, 0, 1, 3],
  },
  {
    name: "每張照片曝光/白平衡都不同",
    logo: "glyph",
    logoFaces: ["U"],
    glare: false,
    order: SHUFFLED,
    rotations: [0, 1, 2, 3, 0, 1],
    filters: LIGHTING,
    maxCorrections: 2,
  },
  {
    name: "紅橘相近配色 + 曝光變化",
    palette: HARD_PALETTE,
    logo: "none",
    logoFaces: [],
    glare: false,
    order: SHUFFLED,
    rotations: [2, 0, 1, 3, 2, 0],
    filters: LIGHTING,
    maxCorrections: 2,
  },
  {
    name: "沒對準框線（偏 7%）",
    logo: "glyph",
    logoFaces: ["U"],
    glare: false,
    offset: { x: 0.07, y: -0.05 },
  },
  {
    name: "一格被強反光蓋住（需要糾錯）",
    logo: "none",
    logoFaces: [],
    glare: false,
    glareSticker: { face: "R", index: 2 },
    maxCorrections: 1,
  },
];

const SIZE = 720;
const BOARD = { x: 118, y: 118, size: 484 };
const STICKER = { size: 144, positions: [136, 288, 440] };
const CLOCKWISE_SOURCE = [6, 3, 0, 7, 4, 1, 8, 5, 2];

function faceSlice(face: ScanFace): string {
  const index = FACELET_FACE_ORDER.indexOf(face);
  return EXPECTED_RAW.slice(index * 9, index * 9 + 9);
}

// 照片順時針轉 rotation 次後，第 p 格對應到面上的哪一格（跟重建時的旋轉定義一致）。
function rotatedSlice(face: ScanFace, rotation: number): string {
  const slice = faceSlice(face);
  let source = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let count = 0; count < rotation; count += 1) source = CLOCKWISE_SOURCE.map((index) => source[index]);
  const photo = new Array<string>(9);
  source.forEach((from, position) => {
    photo[from] = slice[position];
  });
  return photo.join("");
}

function drawFace(canvas: HTMLCanvasElement, face: ScanFace, scenario: Scenario, rotation: number, filter: string): void {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const palette = scenario.palette ?? PALETTE;

  ctx.filter = "none";
  const bg = ctx.createRadialGradient(SIZE * 0.45, SIZE * 0.38, 40, SIZE * 0.45, SIZE * 0.38, SIZE * 0.72);
  bg.addColorStop(0, "#f2f4f6");
  bg.addColorStop(1, "#aeb7c2");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.save();
  ctx.filter = filter;
  const shiftX = (scenario.offset?.x ?? 0) * BOARD.size;
  const shiftY = (scenario.offset?.y ?? 0) * BOARD.size;
  ctx.translate(shiftX, shiftY);

  ctx.fillStyle = "#161b22";
  ctx.beginPath();
  ctx.roundRect(BOARD.x, BOARD.y, BOARD.size, BOARD.size, 30);
  ctx.fill();

  const slice = rotatedSlice(face, rotation);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const color = slice[row * 3 + col] as ScanFace;
      const x = STICKER.positions[col];
      const y = STICKER.positions[row];
      ctx.fillStyle = palette[color];
      ctx.strokeStyle = "#111820";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.roundRect(x, y, STICKER.size, STICKER.size, 18);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (scenario.logo !== "none" && scenario.logoFaces.includes(face)) {
    const cx = STICKER.positions[1] + STICKER.size / 2;
    const cy = STICKER.positions[1] + STICKER.size / 2;
    ctx.fillStyle = "#171c24";
    ctx.strokeStyle = "#171c24";
    if (scenario.logo === "cap") {
      ctx.beginPath();
      ctx.arc(cx, cy, STICKER.size * 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, STICKER.size * 0.24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = "700 30px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("GAN", cx, cy);
    }
  }

  if (scenario.glareSticker?.face === face) {
    const index = scenario.glareSticker.index;
    const x = STICKER.positions[index % 3];
    const y = STICKER.positions[Math.floor(index / 3)];
    ctx.fillStyle = "rgba(255, 252, 235, 0.9)";
    ctx.beginPath();
    ctx.roundRect(x + 6, y + 6, STICKER.size - 12, STICKER.size - 12, 14);
    ctx.fill();
  }
  ctx.restore();

  if (scenario.glare) {
    const glare = ctx.createRadialGradient(BOARD.x + 60, BOARD.y + 60, 10, BOARD.x + 60, BOARD.y + 60, 420);
    glare.addColorStop(0, "rgba(255,255,255,0.30)");
    glare.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glare;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
}

function diffCount(a: string, b: string): number {
  let count = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) count += 1;
  }
  return count;
}

interface ScenarioResult {
  name: string;
  observedErrors: number;
  corrections: number;
  reconstructionValid: boolean;
  finalMatches: boolean;
  ms: number;
  ok: boolean;
  detail: string;
}

function runScenario(scenario: Scenario, gallery: HTMLElement): ScenarioResult {
  const workCanvas = document.createElement("canvas");
  const order = scenario.order ?? FACELET_FACE_ORDER;
  const captures = order.map((face, captureIndex) => {
    const faceCanvas = document.createElement("canvas");
    drawFace(faceCanvas, face, scenario, scenario.rotations?.[captureIndex] ?? 0, scenario.filters?.[captureIndex] ?? "none");
    if (captureIndex === 0) gallery.appendChild(faceCanvas);
    return sampleThreeByThreeFromSource(faceCanvas, SIZE, SIZE, workCanvas);
  });

  const started = performance.now();
  const result = reconstructScan(captures);
  const ms = performance.now() - started;
  const finalMatches = result.raw === EXPECTED_RAW;
  const corrections = result.corrected.length;
  const ok = result.valid && finalMatches && corrections <= (scenario.maxCorrections ?? 0);

  return {
    name: scenario.name,
    observedErrors: diffCount(result.observed, EXPECTED_RAW),
    corrections,
    reconstructionValid: result.valid,
    finalMatches,
    ms,
    ok,
    detail: ok ? "PASS" : `FAIL raw=${result.raw} reason=${result.reason}`,
  };
}

function main(): void {
  const report = document.getElementById("report");
  const verdict = document.getElementById("verdict");
  const gallery = document.getElementById("gallery");
  if (!report || !verdict || !gallery) return;

  const results = SCENARIOS.map((scenario) => runScenario(scenario, gallery));
  const allOk = results.every((result) => result.ok);

  verdict.textContent = allOk ? "ALL PASS" : "SOME FAILED";
  report.textContent = results
    .map(
      (result) =>
        `[${result.ok ? "PASS" : "FAIL"}] ${result.name}\n` +
        `  照片直接判讀錯誤格數: ${result.observedErrors}/54  自動糾錯: ${result.corrections} 格  耗時: ${result.ms.toFixed(1)}ms\n` +
        `  重建合法: ${result.reconstructionValid}  最終結果正確: ${result.finalMatches}\n` +
        (result.ok ? "" : `  ${result.detail}\n`)
    )
    .join("\n");

  (window as unknown as { __colorTestResults: ScenarioResult[] }).__colorTestResults = results;
}

main();
