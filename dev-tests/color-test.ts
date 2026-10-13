// 顏色辨識管線的驗證頁：合成帶有品牌 logo、反光的魔方照片，
// 走完 取樣 → 分類 → 六面重建，比對已知的 facelet 答案。
// 開發時打開 /dev-tests/color-test.html 即可執行。
import { sampleThreeByThreeFromSource } from "../src/domain/color-sampling";
import { classifyCapturedFaces, type CapturedFaceSamples } from "../src/domain/color-classifier";
import { inferScanFaceOrderAndRotations } from "../src/domain/scan-reconstruction";
import { FACELET_FACE_ORDER, type ScanFace } from "../src/domain/scanner-state";

const EXPECTED_RAW = "DLUBUDBRFLBBLRFBRRDUUFFURDDULLRDFFDULRRBLLDDBLBFUBUFFR";

const PALETTE: Record<ScanFace, string> = {
  U: "#f8f8f3",
  R: "#e4493f",
  F: "#2fbd72",
  D: "#ffd84f",
  L: "#f3943b",
  B: "#3478e5",
};

interface Scenario {
  name: string;
  logo: "none" | "glyph" | "cap";
  logoFaces: readonly ScanFace[];
  glare: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "無 logo（迴歸測試）", logo: "none", logoFaces: [], glare: false },
  { name: "白色中心有品牌 logo", logo: "glyph", logoFaces: ["U"], glare: false },
  { name: "六面中心都有 logo", logo: "glyph", logoFaces: FACELET_FACE_ORDER, glare: false },
  { name: "白色中心大面積圓蓋 logo", logo: "cap", logoFaces: ["U"], glare: false },
  { name: "logo + 斜角反光", logo: "glyph", logoFaces: ["U", "F"], glare: true },
];

const SIZE = 720;
const BOARD = { x: 118, y: 118, size: 484 };
const STICKER = { size: 144, positions: [136, 288, 440] };

function faceSlice(face: ScanFace): string {
  const index = FACELET_FACE_ORDER.indexOf(face);
  return EXPECTED_RAW.slice(index * 9, index * 9 + 9);
}

function drawFace(canvas: HTMLCanvasElement, face: ScanFace, scenario: Scenario): void {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  const bg = ctx.createRadialGradient(SIZE * 0.45, SIZE * 0.38, 40, SIZE * 0.45, SIZE * 0.38, SIZE * 0.72);
  bg.addColorStop(0, "#f2f4f6");
  bg.addColorStop(1, "#aeb7c2");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = "#161b22";
  ctx.beginPath();
  ctx.roundRect(BOARD.x, BOARD.y, BOARD.size, BOARD.size, 30);
  ctx.fill();

  const slice = faceSlice(face);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const color = slice[row * 3 + col] as ScanFace;
      const x = STICKER.positions[col];
      const y = STICKER.positions[row];
      ctx.fillStyle = PALETTE[color];
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
  classifiedErrors: number;
  reconstructionValid: boolean;
  finalMatches: boolean;
  ok: boolean;
  detail: string;
}

function runScenario(scenario: Scenario, gallery: HTMLElement): ScenarioResult {
  const workCanvas = document.createElement("canvas");
  const samples = {} as Record<ScanFace, ReturnType<typeof sampleThreeByThreeFromSource>>;

  for (const face of FACELET_FACE_ORDER) {
    const faceCanvas = document.createElement("canvas");
    drawFace(faceCanvas, face, scenario);
    if (face === "U") gallery.appendChild(faceCanvas);
    samples[face] = sampleThreeByThreeFromSource(faceCanvas, SIZE, SIZE, workCanvas);
  }

  const classified = classifyCapturedFaces(samples as CapturedFaceSamples);
  const classifiedErrors = diffCount(classified.raw, EXPECTED_RAW);
  const reconstruction = inferScanFaceOrderAndRotations(classified);
  const finalMatches = reconstruction.result.raw === EXPECTED_RAW;
  const ok = reconstruction.valid && finalMatches;

  return {
    name: scenario.name,
    classifiedErrors,
    reconstructionValid: reconstruction.valid,
    finalMatches,
    ok,
    detail: ok
      ? "PASS"
      : `FAIL raw=${reconstruction.result.raw} reason=${reconstruction.reason}`,
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
        `  分類階段誤判格數: ${result.classifiedErrors}/54\n` +
        `  六面重建合法: ${result.reconstructionValid}  最終結果正確: ${result.finalMatches}\n` +
        (result.ok ? "" : `  ${result.detail}\n`)
    )
    .join("\n");

  (window as unknown as { __colorTestResults: ScenarioResult[] }).__colorTestResults = results;
}

main();
