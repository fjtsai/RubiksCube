import "./styles.css";
import { classifyCapturedFaces, type CapturedFaceSamples, type ClassifiedScanResult } from "./domain/color-classifier";
import { sampleThreeByThreeFromImage, sampleThreeByThreeFromVideo } from "./domain/color-sampling";
import { evaluateBeginnerCoach, evaluateBeginnerCoachFromString, type BeginnerCoach } from "./domain/beginner-coach";
import { inferScanFaceOrderAndRotations } from "./domain/scan-reconstruction";
import {
  analyzeFiveByFiveCenters,
  analyzeFiveByFiveEdges,
  projectFiveByFiveToThreeByThree,
  validateProjectedThreeByThree,
} from "./domain/five-by-five-reduction";
import {
  describeMove,
  invertAlgorithm,
  inverseMove,
  isInnerMove,
  isWideMove,
  movesToAlgorithm,
  parseMove,
  randomFiveByFiveScramble,
  randomScramble,
  type MoveToken,
  type FaceMove,
} from "./domain/moves";
import {
  FACELET_FACE_ORDER,
  normalizeFaceletInput,
  SOLVED_THREE_BY_THREE_FACELETS,
  type ScanColor,
  type ScanFace,
} from "./domain/scanner-state";
import { countFacelets, validateThreeByThreeFacelets } from "./domain/three-by-three-validation";
import { AudioEngine } from "./game/audio";
import { RubiksScene, type CubeSize } from "./game/rubiks-scene";

interface SolverResponse {
  id: number;
  type: "ready" | "solution" | "error";
  moves?: MoveToken[];
  raw?: string;
  message?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const STORAGE_MOVES = "kids-rubiks.moves";
const STORAGE_SOUND = "kids-rubiks.sound";
const STORAGE_SCANNED_FACELETS = "kids-rubiks.facelets.scanned";
const THREE_BY_THREE_RIBBON_MOVES: MoveToken[] = ["U", "U'", "R", "R'", "F", "F'", "D", "D'", "L", "L'", "B", "B'"];
const FIVE_BY_FIVE_FULL_RIBBON_MOVES: MoveToken[] = [
  "U",
  "U'",
  "Uw",
  "Uw'",
  "2U",
  "2U'",
  "R",
  "R'",
  "Rw",
  "Rw'",
  "2R",
  "2R'",
  "F",
  "F'",
  "Fw",
  "Fw'",
  "2F",
  "2F'",
  "D",
  "D'",
  "Dw",
  "Dw'",
  "2D",
  "2D'",
  "L",
  "L'",
  "Lw",
  "Lw'",
  "2L",
  "2L'",
  "B",
  "B'",
  "Bw",
  "Bw'",
  "2B",
  "2B'",
];
const FIVE_BY_FIVE_PARITY_ALGORITHM: MoveToken[] = ["Rw2", "F2", "U2", "2R2", "U2", "F2", "Rw2"];
const SCANNER_FACE_NAMES: Record<ScanFace, string> = {
  U: "白色上面",
  R: "紅色右面",
  F: "綠色前面",
  D: "黃色下面",
  L: "橘色左面",
  B: "藍色後面",
};
const FACE_SWATCH_COLORS: Record<FaceMove, string> = {
  U: "#ffffff",
  R: "#ff4f4f",
  F: "#36c56f",
  D: "#ffd84d",
  L: "#ff9a3c",
  B: "#4e8dff",
};
const TEST_SCAN_PHOTO_PATHS: Record<ScanFace, string> = {
  U: "/test-scans/scan-U.svg",
  R: "/test-scans/scan-R.svg",
  F: "/test-scans/scan-F.svg",
  D: "/test-scans/scan-D.svg",
  L: "/test-scans/scan-L.svg",
  B: "/test-scans/scan-B.svg",
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main class="game-shell">
    <div class="scene-mount" id="scene-mount"></div>

    <header class="top-hud">
      <div class="brand-lockup">
        <span class="brand-cube" aria-hidden="true"></span>
        <div>
          <h1>魔方小玩家</h1>
          <p id="status-text">轉動方塊，或按打亂開始挑戰</p>
        </div>
      </div>
      <div class="top-actions">
        <button class="icon-button" id="btn-import-facelets" type="button" aria-label="匯入實體魔方" title="匯入實體魔方">▦</button>
        <button class="icon-button" id="btn-sound" type="button" aria-label="音效" title="音效">♪</button>
        <button class="icon-button hidden" id="btn-install" type="button" aria-label="安裝" title="安裝">↓</button>
      </div>
    </header>

    <section class="lesson-strip" id="lesson-strip">
      <div>
        <span class="eyebrow" id="lesson-label">教學</span>
        <h2 id="lesson-title">白色十字</h2>
        <p id="lesson-body"></p>
        <div class="lesson-progress" aria-label="教學進度">
          <span id="lesson-progress-text">0/0</span>
          <i><b id="lesson-progress-bar"></b></i>
        </div>
      </div>
      <div class="lesson-actions">
        <button class="small-button" id="btn-lesson-demo" type="button">練一步</button>
        <button class="small-button" id="btn-lesson-next" type="button">判斷</button>
      </div>
    </section>

    <section class="solve-strip">
      <div class="next-move">
        <span>下一步</span>
        <strong id="next-move">-</strong>
      </div>
      <div class="cube-size-tabs" role="group" aria-label="方塊尺寸">
        <span class="size-label" aria-hidden="true">尺寸</span>
        <button class="cube-size-tab" type="button" data-size="3">3x3</button>
        <button class="cube-size-tab" type="button" data-size="5">5x5</button>
      </div>
      <div class="mode-tabs" role="tablist" aria-label="模式">
        <button class="mode-tab active" type="button" data-mode="play">自由玩</button>
        <button class="mode-tab" type="button" data-mode="teach">教我解</button>
        <button class="mode-tab" type="button" data-mode="solve">自動解</button>
      </div>
    </section>

    <section class="move-ribbon" id="move-ribbon" aria-label="快速轉面"></section>

    <footer class="control-dock">
      <button class="primary-action" id="btn-scramble" type="button"><span>打亂</span></button>
      <button class="dock-button" id="btn-hint" type="button"><span>提示</span></button>
      <button class="dock-button" id="btn-step" type="button"><span>一步</span></button>
      <button class="dock-button" id="btn-undo" type="button"><span>復原</span></button>
      <button class="solve-action" id="btn-auto" type="button"><span>自動解</span></button>
    </footer>

    <div class="install-banner hidden" id="install-banner">
      <span>可以安裝到手機主畫面，離線也能玩。</span>
      <button id="btn-install-banner" type="button">安裝</button>
      <button id="btn-install-close" type="button" aria-label="關閉">×</button>
    </div>

    <div class="facelet-dialog hidden" id="facelet-dialog" role="dialog" aria-modal="true" aria-labelledby="facelet-dialog-title">
      <div class="facelet-panel">
        <div class="facelet-panel-head">
          <div>
            <span class="eyebrow">實體魔方</span>
            <h2 id="facelet-dialog-title">匯入 3x3 狀態</h2>
          </div>
          <button class="icon-button subtle" id="btn-facelet-close" type="button" aria-label="關閉">×</button>
        </div>
        <p class="facelet-help">貼上 54 格 facelet string，順序固定為 U R F D L B，每面 9 格。相機掃描會接在同一條資料流程上。</p>
        <textarea id="facelet-input" spellcheck="false" autocapitalize="characters" autocomplete="off" inputmode="text"></textarea>
        <p class="facelet-error" id="facelet-error"></p>
        <div class="facelet-actions">
          <button class="primary-action" id="btn-facelet-scan" type="button">相機掃描</button>
          <button class="small-button" id="btn-facelet-test" type="button">測試照片</button>
          <button class="small-button" id="btn-facelet-solved" type="button">完成狀態</button>
          <button class="dock-button" id="btn-facelet-apply" type="button">套用並求解</button>
        </div>
      </div>
    </div>

    <div class="scanner-overlay hidden" id="scanner-overlay" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
      <video id="scanner-video" autoplay playsinline muted></video>
      <canvas class="hidden" id="scanner-canvas"></canvas>
      <div class="scanner-top">
        <div>
          <span class="eyebrow" id="scanner-step">掃描 1/6</span>
          <h2 id="scanner-title">白色上面</h2>
        </div>
        <button class="icon-button subtle scanner-close" id="btn-scanner-close" type="button" aria-label="關閉">×</button>
      </div>
      <div class="scanner-frame" aria-hidden="true">
        <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
      </div>
      <div class="scanner-bottom">
        <p id="scanner-status">把整面魔方對準框線，讓 9 格盡量填滿。</p>
        <div class="scanner-preview" id="scanner-preview"></div>
        <div class="scanner-editor" id="scanner-editor">
          <div class="scanner-palette" id="scanner-palette" aria-label="修正顏色"></div>
          <div class="scanner-edit-actions">
            <button class="small-button" id="btn-scanner-rotate-left" type="button">逆轉本面</button>
            <button class="small-button" id="btn-scanner-rotate-right" type="button">順轉本面</button>
          </div>
          <p class="scanner-diagnostics" id="scanner-diagnostics"></p>
        </div>
        <div class="scanner-actions">
          <button class="small-button" id="btn-scanner-back" type="button">上一面</button>
          <button class="primary-action" id="btn-scanner-capture" type="button">拍這面</button>
          <button class="solve-action" id="btn-scanner-apply" type="button" disabled>套用掃描</button>
        </div>
      </div>
    </div>
  </main>
`;

const sceneMount = requireElement<HTMLDivElement>("scene-mount");
const statusText = requireElement<HTMLParagraphElement>("status-text");
const nextMoveText = requireElement<HTMLElement>("next-move");
const moveRibbon = requireElement<HTMLElement>("move-ribbon");
const lessonLabel = requireElement<HTMLElement>("lesson-label");
const lessonTitle = requireElement<HTMLElement>("lesson-title");
const lessonBody = requireElement<HTMLElement>("lesson-body");
const lessonProgressText = requireElement<HTMLElement>("lesson-progress-text");
const lessonProgressBar = requireElement<HTMLElement>("lesson-progress-bar");
const btnImportFacelets = requireElement<HTMLButtonElement>("btn-import-facelets");
const btnSound = requireElement<HTMLButtonElement>("btn-sound");
const btnInstall = requireElement<HTMLButtonElement>("btn-install");
const installBanner = requireElement<HTMLDivElement>("install-banner");
const btnInstallBanner = requireElement<HTMLButtonElement>("btn-install-banner");
const btnInstallClose = requireElement<HTMLButtonElement>("btn-install-close");
const faceletDialog = requireElement<HTMLDivElement>("facelet-dialog");
const faceletInput = requireElement<HTMLTextAreaElement>("facelet-input");
const faceletError = requireElement<HTMLParagraphElement>("facelet-error");
const btnFaceletClose = requireElement<HTMLButtonElement>("btn-facelet-close");
const btnFaceletScan = requireElement<HTMLButtonElement>("btn-facelet-scan");
const btnFaceletTest = requireElement<HTMLButtonElement>("btn-facelet-test");
const btnFaceletSolved = requireElement<HTMLButtonElement>("btn-facelet-solved");
const btnFaceletApply = requireElement<HTMLButtonElement>("btn-facelet-apply");
const scannerOverlay = requireElement<HTMLDivElement>("scanner-overlay");
const scannerVideo = requireElement<HTMLVideoElement>("scanner-video");
const scannerCanvas = requireElement<HTMLCanvasElement>("scanner-canvas");
const scannerStep = requireElement<HTMLElement>("scanner-step");
const scannerTitle = requireElement<HTMLHeadingElement>("scanner-title");
const scannerStatus = requireElement<HTMLParagraphElement>("scanner-status");
const scannerPreview = requireElement<HTMLDivElement>("scanner-preview");
const scannerEditor = requireElement<HTMLDivElement>("scanner-editor");
const scannerPalette = requireElement<HTMLDivElement>("scanner-palette");
const scannerDiagnostics = requireElement<HTMLParagraphElement>("scanner-diagnostics");
const btnScannerClose = requireElement<HTMLButtonElement>("btn-scanner-close");
const btnScannerBack = requireElement<HTMLButtonElement>("btn-scanner-back");
const btnScannerCapture = requireElement<HTMLButtonElement>("btn-scanner-capture");
const btnScannerApply = requireElement<HTMLButtonElement>("btn-scanner-apply");
const btnScannerRotateLeft = requireElement<HTMLButtonElement>("btn-scanner-rotate-left");
const btnScannerRotateRight = requireElement<HTMLButtonElement>("btn-scanner-rotate-right");

const audio = new AudioEngine();
const solver = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
const pendingSolverRequests = new Map<number, { resolve: (response: SolverResponse) => void; reject: (error: Error) => void }>();
let solverRequestId = 0;
let cubeSize: CubeSize = getInitialCubeSize();
let history = loadHistory();
let solutionQueue: MoveToken[] = [];
let externalFacelets = cubeSize === 3 ? loadExternalFacelets() : null;
if (externalFacelets) history = [];
let currentCoach: BeginnerCoach = externalFacelets ? evaluateBeginnerCoachFromString(externalFacelets) : evaluateBeginnerCoach(history);
let playbackToken = 0;
let busy = false;
let deferredInstall: BeforeInstallPromptEvent | null = null;
let scannerStream: MediaStream | null = null;
let scannerFaceIndex = 0;
let scannerSamples: Partial<CapturedFaceSamples> = {};
let scannerResult: ClassifiedScanResult | null = null;
let scannerPaintColor: ScanColor = "U";
let scannerInferenceNote = "";

const scene = new RubiksScene(sceneMount, {
  cubeSize,
  onUserMove: (move) => {
    audio.playTurn();
    recordMove(move, true);
    if (getMode() === "teach") {
      setStatus(`${describeMove(move)}，${currentCoach.label}`);
    } else {
      setStatus(`${describeMove(move)}，很好`);
    }
  },
  onMessage: setStatus,
  isMoveAllowed: (move) => isManualMoveAllowed(move),
});

if (import.meta.env.DEV) {
  Object.assign(window, {
    __rubiksDebug: {
      applyMove: (move: MoveToken) => scene.applyMove(move, 0),
      importFacelets: (raw: string) => applyImportedFacelets(raw),
      reset: () => scene.reset(),
      facelets: () => scene.getFaceletString(),
      isSolved: () => scene.isSolved(),
      history: () => [...history],
      stickerScreenPoint: (face: FaceMove, index: number) => scene.getFaceletScreenPoint(face, index),
    },
  });
}

buildMoveRibbon();
bindUi();
currentCoach = refreshCoach(false);
renderCoach(currentCoach);
renderCubeSizeTabs();
setMode("play");
restoreSavedCube();
void initSolver();
registerPwa();

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function bindUi(): void {
  document.addEventListener("pointerdown", () => void audio.unlock(), { once: true });

  requireElement<HTMLButtonElement>("btn-scramble").addEventListener("click", () => void scrambleCube());
  requireElement<HTMLButtonElement>("btn-hint").addEventListener("click", () => void showHint());
  requireElement<HTMLButtonElement>("btn-step").addEventListener("click", () => void playOneSolutionStep());
  requireElement<HTMLButtonElement>("btn-undo").addEventListener("click", () => void undoMove());
  requireElement<HTMLButtonElement>("btn-auto").addEventListener("click", () => void autoSolve());
  requireElement<HTMLButtonElement>("btn-lesson-next").addEventListener("click", () => {
    const coach = refreshCoach(false);
    setStatus(`${coach.title}：${coach.progressLabel}`);
    audio.playSoft();
  });
  requireElement<HTMLButtonElement>("btn-lesson-demo").addEventListener("click", () => void playCoachStep());
  btnImportFacelets.addEventListener("click", openFaceletDialog);
  btnFaceletClose.addEventListener("click", closeFaceletDialog);
  faceletDialog.addEventListener("click", (event) => {
    if (event.target === faceletDialog) closeFaceletDialog();
  });
  btnFaceletSolved.addEventListener("click", () => {
    faceletInput.value = SOLVED_THREE_BY_THREE_FACELETS;
    faceletError.textContent = "";
  });
  btnFaceletScan.addEventListener("click", () => void startScanner());
  btnFaceletTest.addEventListener("click", () => void loadTestScanPhotos());
  btnFaceletApply.addEventListener("click", () => void applyFaceletInput());
  btnScannerClose.addEventListener("click", stopScanner);
  btnScannerBack.addEventListener("click", scannerPreviousFace);
  btnScannerCapture.addEventListener("click", () => void captureScannerFace());
  btnScannerApply.addEventListener("click", () => void applyScannerResult());
  btnScannerRotateLeft.addEventListener("click", () => rotateScannerFace(false));
  btnScannerRotateRight.addEventListener("click", () => rotateScannerFace(true));
  scannerPalette.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-paint-color]");
    if (!button) return;
    scannerPaintColor = button.dataset.paintColor as ScanColor;
    renderScanner();
  });
  scannerPreview.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-scan-face][data-scan-index]");
    if (!button) return;
    paintScannerCell(button.dataset.scanFace as ScanFace, Number(button.dataset.scanIndex));
  });

  btnSound.addEventListener("click", () => {
    audio.setEnabled(!audio.isEnabled());
    localStorage.setItem(STORAGE_SOUND, audio.isEnabled() ? "1" : "0");
    btnSound.classList.toggle("muted", !audio.isEnabled());
    btnSound.textContent = audio.isEnabled() ? "♪" : "×";
  });

  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveMode(button.dataset.mode ?? "play");
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".cube-size-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const nextSize = Number(button.dataset.size) === 5 ? 5 : 3;
      void switchCubeSize(nextSize);
    });
  });

  if (localStorage.getItem(STORAGE_SOUND) === "0") {
    audio.setEnabled(false);
    btnSound.classList.add("muted");
    btnSound.textContent = "×";
  }
}

function openFaceletDialog(): void {
  if (busy) return;
  faceletInput.value = externalFacelets ?? scene.getFaceletString();
  faceletError.textContent = "";
  faceletDialog.classList.remove("hidden");
  window.setTimeout(() => faceletInput.focus(), 0);
}

function closeFaceletDialog(): void {
  faceletDialog.classList.add("hidden");
}

async function applyFaceletInput(): Promise<void> {
  const raw = normalizeFaceletInput(faceletInput.value);
  faceletInput.value = raw;
  const validation = validateThreeByThreeFacelets(raw);
  if (!validation.valid) {
    faceletError.textContent = validation.reason;
    audio.playError();
    return;
  }

  faceletError.textContent = "";
  closeFaceletDialog();
  await applyImportedFacelets(raw);
}

async function startScanner(): Promise<void> {
  if (busy) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    faceletError.textContent = location.protocol === "https:" || location.hostname === "localhost"
      ? "這個瀏覽器不支援相機掃描，請改用手動匯入。"
      : "相機需要 HTTPS 或 localhost，請改用安全網址開啟。";
    audio.playError();
    return;
  }

  closeFaceletDialog();
  scannerFaceIndex = 0;
  scannerSamples = {};
  scannerResult = null;
  scannerInferenceNote = "";
  scannerOverlay.classList.remove("hidden");
  renderScanner();

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    scannerVideo.srcObject = scannerStream;
    await scannerVideo.play();
    scannerStatus.textContent = "把整面魔方對準框線，讓 9 格盡量填滿。";
  } catch (error) {
    console.error(error);
    stopScanner();
    openFaceletDialog();
    faceletError.textContent = "無法開啟相機，請確認瀏覽器相機權限。";
    audio.playError();
  }
}

function stopScanner(): void {
  releaseScannerStream();
  scannerOverlay.classList.add("hidden");
}

function releaseScannerStream(): void {
  scannerStream?.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  scannerVideo.pause();
  scannerVideo.srcObject = null;
}

async function loadTestScanPhotos(): Promise<void> {
  if (busy) return;
  closeFaceletDialog();
  releaseScannerStream();
  scannerFaceIndex = 0;
  scannerSamples = {};
  scannerResult = null;
  scannerInferenceNote = "";
  scannerOverlay.classList.remove("hidden");
  renderScanner();
  scannerStatus.textContent = "正在載入測試照片。";

  try {
    const loaded = await Promise.all(
      FACELET_FACE_ORDER.map(async (face) => ({
        face,
        samples: sampleThreeByThreeFromImage(await loadImage(TEST_SCAN_PHOTO_PATHS[face]), scannerCanvas),
      }))
    );

    scannerSamples = loaded.reduce(
      (result, item) => {
        result[item.face] = item.samples;
        return result;
      },
      {} as Partial<CapturedFaceSamples>
    );

    const completeSamples = getCompleteScannerSamples();
    if (!completeSamples) throw new Error("測試照片沒有完整載入");
    const inferred = rebuildScannerResultFromSamples();
    if (!inferred) throw new Error(scannerInferenceNote || "測試照片無法推斷合法狀態");
    renderScanner();
    scannerStatus.textContent = "已載入一組合法打亂的測試照片，正在自動匯入。";
    audio.playSoft();
    await applyScannerResult();
  } catch (error) {
    console.error(error);
    scannerStatus.textContent = error instanceof Error ? error.message : "測試照片載入失敗";
    audio.playError();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`無法載入測試照片：${src}`));
    image.src = src;
  });
}

function scannerPreviousFace(): void {
  scannerFaceIndex = Math.max(0, scannerFaceIndex - 1);
  renderScanner();
}

function rotateScannerFace(clockwise: boolean): void {
  if (!scannerResult) return;
  const face = FACELET_FACE_ORDER[scannerFaceIndex];
  const current = scannerResult.stickers[face];
  const order = clockwise ? [6, 3, 0, 7, 4, 1, 8, 5, 2] : [2, 5, 8, 1, 4, 7, 0, 3, 6];
  scannerResult.stickers[face] = order.map((index) => current[index]);
  syncScannerResult();
  renderScanner();
}

function paintScannerCell(face: ScanFace, index: number): void {
  if (!scannerResult) return;
  if (index === 4) {
    scannerStatus.textContent = "中心格用來校正這一面，請重拍該面而不是修改中心。";
    audio.playError();
    return;
  }

  const current = scannerResult.stickers[face][index];
  scannerResult.stickers[face][index] = {
    ...current,
    face: scannerPaintColor,
    confidence: 1,
  };
  syncScannerResult();
  renderScanner();
}

async function captureScannerFace(): Promise<void> {
  const face = FACELET_FACE_ORDER[scannerFaceIndex];
  try {
    scannerSamples[face] = sampleThreeByThreeFromVideo(scannerVideo, scannerCanvas);
    const completeSamples = getCompleteScannerSamples();
    const inferred = completeSamples ? rebuildScannerResultFromSamples() : false;
    if (scannerFaceIndex < FACELET_FACE_ORDER.length - 1) {
      scannerFaceIndex += 1;
    }
    renderScanner();
    audio.playSoft();
    if (inferred && scannerResult && validateThreeByThreeFacelets(scannerResult.raw).valid) {
      scannerStatus.textContent = "6 面辨識完成，正在自動匯入。";
      await applyScannerResult();
    }
  } catch (error) {
    console.error(error);
    scannerStatus.textContent = error instanceof Error ? error.message : "取樣失敗，請重拍這一面。";
    audio.playError();
  }
}

function rebuildScannerResultFromSamples(): boolean {
  const completeSamples = getCompleteScannerSamples();
  if (!completeSamples) {
    scannerResult = null;
    scannerInferenceNote = "";
    return false;
  }

  const classified = classifyCapturedFaces(completeSamples);
  const reconstruction = inferScanFaceOrderAndRotations(classified);
  scannerResult = reconstruction.result;
  scannerInferenceNote = reconstruction.valid
    ? `已自動推斷六面順序與方向，嘗試 ${reconstruction.attempts} 組。`
    : `${reconstruction.reason} 已嘗試 ${reconstruction.attempts} 組順序/方向。`;
  faceletInput.value = scannerResult.raw;
  return reconstruction.valid;
}

function syncScannerResult(): void {
  if (!scannerResult) return;
  for (const face of FACELET_FACE_ORDER) {
    scannerResult.faces[face] = scannerResult.stickers[face].map((sticker) => sticker.face);
  }
  scannerResult.raw = FACELET_FACE_ORDER.flatMap((face) => scannerResult?.faces[face] ?? []).join("");
  faceletInput.value = scannerResult.raw;
}

async function applyScannerResult(): Promise<void> {
  const completeSamples = getCompleteScannerSamples();
  if (!completeSamples) {
    scannerStatus.textContent = "還需要拍完 6 面。";
    audio.playError();
    return;
  }

  if (!scannerResult) {
    rebuildScannerResultFromSamples();
  }
  if (!scannerResult) return;
  syncScannerResult();
  const validation = validateThreeByThreeFacelets(scannerResult.raw);
  faceletInput.value = scannerResult.raw;
  if (!validation.valid) {
    scannerStatus.textContent = `${validation.reason}。請旋轉拍錯方向的面，或點格子修正顏色後再套用。`;
    audio.playError();
    renderScanner();
    return;
  }

  const raw = scannerResult.raw;
  stopScanner();
  await applyImportedFacelets(raw);
}

function getCompleteScannerSamples(): CapturedFaceSamples | null {
  const missingFace = FACELET_FACE_ORDER.find((face) => !scannerSamples[face]);
  if (missingFace) return null;
  return FACELET_FACE_ORDER.reduce(
    (result, face) => {
      result[face] = scannerSamples[face] ?? [];
      return result;
    },
    {} as CapturedFaceSamples
  );
}

function renderScanner(): void {
  const face = FACELET_FACE_ORDER[scannerFaceIndex];
  const completeSamples = getCompleteScannerSamples();
  if (completeSamples && !scannerResult) {
    rebuildScannerResultFromSamples();
  }

  scannerStep.textContent = `掃描 ${scannerFaceIndex + 1}/${FACELET_FACE_ORDER.length}`;
  scannerTitle.textContent = scannerResult ? SCANNER_FACE_NAMES[face] : "任意未拍過的一面";
  btnScannerBack.disabled = scannerFaceIndex === 0;
  btnScannerCapture.textContent = scannerSamples[face] ? "重拍這面" : "拍這面";
  btnScannerApply.disabled = !scannerResult;
  scannerEditor.classList.toggle("hidden", !scannerResult);
  renderScannerPalette();

  if (scannerResult) {
    const validation = validateThreeByThreeFacelets(scannerResult.raw);
    scannerStatus.textContent = validation.valid
      ? "掃描完成，狀態合法。可以套用求解，或檢查每面方向。"
      : `${validation.reason}。可旋轉本面、點格子修正，或重拍顏色不準的面。`;
    scannerDiagnostics.textContent = scannerDiagnosticsLabel(scannerResult.raw, validation.reason, scannerInferenceNote);
  } else {
    scannerStatus.textContent = scannerSamples[face]
      ? "這面已拍攝，可以重拍或繼續下一面。"
      : "把任意一面魔方對準框線，讓 9 格盡量填滿。六面拍完後會自動推斷順序與方向。";
    scannerDiagnostics.textContent = "";
  }

  scannerPreview.innerHTML = FACELET_FACE_ORDER.map((previewFace) => renderScannerPreviewFace(previewFace)).join("");
}

function renderScannerPalette(): void {
  scannerPalette.innerHTML = FACELET_FACE_ORDER.map(
    (face) =>
      `<button class="${scannerPaintColor === face ? "active" : ""}" type="button" data-paint-color="${face}" style="background:${FACE_SWATCH_COLORS[face]}">${face}</button>`
  ).join("");
}

function scannerDiagnosticsLabel(raw: string, reason: string, note: string): string {
  const counts = countFacelets(raw);
  const countLabel = FACELET_FACE_ORDER.map((face) => `${face}:${counts[face]}`).join(" ");
  const prefix = note ? `${note}｜` : "";
  return reason === "OK" ? `${prefix}顏色數量 ${countLabel}` : `${prefix}${reason}｜顏色數量 ${countLabel}`;
}

function renderScannerPreviewFace(face: ScanFace): string {
  const rawSamples = scannerSamples[face];
  const classified = scannerResult?.stickers[face];
  const cells =
    classified?.map(
      (sticker, index) =>
        `<button class="${sticker.confidence < 0.12 ? "low-confidence" : ""}" type="button" data-scan-face="${face}" data-scan-index="${index}" style="background:${FACE_SWATCH_COLORS[sticker.face]}">${sticker.face}</button>`
    ) ??
    rawSamples?.map(
      (rgb) => `<button type="button" disabled style="background:rgb(${rgb.r} ${rgb.g} ${rgb.b})"></button>`
    ) ??
    Array.from({ length: 9 }, () => "<button type=\"button\" disabled></button>");

  return `
    <div class="scanner-face-preview">
      <strong>${face}</strong>
      <div>${cells.join("")}</div>
    </div>
  `;
}

function buildMoveRibbon(): void {
  const moves = getRibbonMoves();
  moveRibbon.innerHTML = moves
    .map((move) => `<button class="move-button" type="button" data-move="${move}" title="${describeMove(move)}">${move}</button>`)
    .join("");

  moveRibbon.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((button) => {
    const move = parseMove(button.dataset.move ?? "");
    if (!move) return;
    button.addEventListener("click", () => void applyManualMove(move));
  });
}

async function initSolver(): Promise<void> {
  setStatus("解法引擎準備中");
  try {
    await solverRequest({ type: "init" });
    if (cubeSize === 5) {
      setStatus(history.length > 0 ? "已載入 5x5 外層練習進度" : "5x5 外層練習模式，先熟悉大魔方手感");
      return;
    }
    if (externalFacelets) {
      setStatus("已載入實體魔方狀態，可按提示或一步");
      return;
    }
    setStatus(history.length > 0 ? "已載入上次進度" : "打亂後可以按提示或自動解");
  } catch (error) {
    setStatus("解法引擎暫時無法啟動");
    console.error(error);
  }
}

async function restoreSavedCube(): Promise<void> {
  if (cubeSize === 3 && externalFacelets) {
    scene.setFaceletString(externalFacelets);
    updateCounters();
    refreshCoach(false);
    return;
  }
  if (history.length === 0) return;
  setBusy(true);
  scene.setInputEnabled(false);
  await scene.applyAlgorithm(history, 0);
  setBusy(false);
  scene.setInputEnabled(true);
  updateCounters();
  refreshCoach(false);
}

async function applyImportedFacelets(raw: string): Promise<void> {
  if (busy || scene.isBusy()) return;
  const validation = validateThreeByThreeFacelets(raw);
  if (!validation.valid) {
    setStatus(validation.reason);
    audio.playError();
    return;
  }

  stopPlayback();
  if (cubeSize !== 3) {
    cubeSize = 3;
    scene.setCubeSize(cubeSize);
    renderCubeSizeTabs();
  }

  history = [];
  solutionQueue = [];
  externalFacelets = raw;
  scene.setFaceletString(raw);
  persistExternalFacelets();
  localStorage.removeItem(movesStorageKey(3));
  updateCounters();
  currentCoach = evaluateBeginnerCoachFromString(raw);
  renderCoach(currentCoach);
  buildMoveRibbon();
  setActiveMode("solve");

  const solution = await computeSolution();
  solutionQueue = solution;
  nextMoveText.textContent = solution[0] ?? "-";
  scene.highlightMove(solution[0] ?? null);
  setStatus(solution[0] ? `已匯入實體魔方，先做 ${solution[0]}` : "已匯入，這顆魔方已完成");
  audio.playSoft();
}

async function scrambleCube(): Promise<void> {
  if (busy) return;
  stopPlayback();
  clearExternalFacelets();
  scene.reset();
  history = [];
  solutionQueue = [];
  persistHistory();
  refreshCoach(false);
  setStatus("正在打亂");
  await playSequence(cubeSize === 5 ? randomFiveByFiveScramble(34) : randomScramble(20), {
    duration: cubeSize === 5 ? 118 : 145,
    record: true,
    clearQueue: false,
  });
  setStatus("換你了，拖曳任一層開始玩");
}

async function applyManualMove(move: MoveToken): Promise<void> {
  if (busy || scene.isBusy()) return;
  if (!isManualMoveAllowed(move)) {
    setStatus("Reduction 已完成，現在只用外層轉法保護 5x5 邊與中心");
    audio.playError();
    return;
  }

  await audio.unlock();
  await scene.applyMove(move);
  audio.playTurn();
  recordMove(move, true);
  if (getMode() === "teach") {
    setStatus(`${describeMove(move)}，${currentCoach.title} ${currentCoach.progressLabel}`);
  } else {
    setStatus(describeMove(move));
  }
}

async function undoMove(): Promise<void> {
  if (busy || scene.isBusy() || history.length === 0) return;
  const last = history.pop();
  if (!last) return;
  solutionQueue = [];
  await scene.applyMove(inverseMove(last), 190);
  audio.playSoft();
  if (externalFacelets) {
    externalFacelets = scene.getFaceletString();
    persistExternalFacelets();
  } else {
    persistHistory();
  }
  updateCounters();
  refreshCoach(false);
  buildMoveRibbon();
  setStatus("已復原一步");
}

async function showHint(): Promise<void> {
  if (busy) return;
  if (cubeSize === 5) {
    if (getMode() === "teach") {
      const coach = refreshCoach(true);
      renderCoach(coach);
      solutionQueue = coach.recommended;
      setStatus(`${coach.title}：${coach.progressLabel}`);
      audio.playSoft();
      return;
    }

    const next = history.length > 0 ? inverseMove(history[history.length - 1]) : null;
    if (!next) {
      scene.highlightMove(null);
      nextMoveText.textContent = "-";
      setStatus("5x5 已經回到目前練習起點");
      audio.playWin();
      return;
    }
    scene.highlightMove(next);
    nextMoveText.textContent = next;
    setStatus(`5x5 先練外層手感，下一步可復原 ${next}`);
    audio.playSoft();
    return;
  }

  if (getMode() === "teach") {
    const coach = refreshCoach(true);
    if (coach.recommended.length > 0) {
      solutionQueue = coach.recommended;
      const nextCoachMove = coach.recommended[0];
      scene.highlightMove(nextCoachMove);
      nextMoveText.textContent = nextCoachMove;
      setStatus(`${coach.recommendationLabel}，先做 ${nextCoachMove}`);
      audio.playSoft();
      return;
    }
  }

  const solution = await computeSolution();
  const next = solution[0];
  if (!next) {
    scene.highlightMove(null);
    nextMoveText.textContent = "-";
    setStatus("已經完成了");
    audio.playWin();
    return;
  }

  solutionQueue = solution;
  scene.highlightMove(next);
  nextMoveText.textContent = next;
  setStatus(`先做 ${next}：${describeMove(next)}`);
  audio.playSoft();
}

async function playOneSolutionStep(): Promise<void> {
  if (busy || scene.isBusy()) return;
  if (cubeSize === 5) {
    if (getMode() === "teach") {
      if (solutionQueue.length === 0) {
        solutionQueue = refreshCoach(true).recommended;
      }
      const move = solutionQueue.shift();
      if (move) {
        scene.highlightMove(move);
        await applyManualMove(move);
        nextMoveText.textContent = solutionQueue[0] ?? "-";
        return;
      }
    }

    await playOneFiveByFiveUndoStep();
    return;
  }

  if (solutionQueue.length === 0) {
    solutionQueue = getMode() === "teach" ? refreshCoach(true).recommended : [];
    if (solutionQueue.length === 0) {
      solutionQueue = await computeSolution();
    }
  }
  const move = solutionQueue.shift();
  if (!move) {
    setStatus("已經完成了");
    audio.playWin();
    return;
  }
  scene.highlightMove(move);
  await applyManualMove(move);
  nextMoveText.textContent = solutionQueue[0] ?? "-";
}

async function autoSolve(): Promise<void> {
  if (busy) return;
  if (cubeSize === 5) {
    const solution = invertAlgorithm(history);
    if (solution.length === 0) {
      setStatus("5x5 已經完成目前練習");
      audio.playWin();
      return;
    }
    nextMoveText.textContent = solution[0] ?? "-";
    setStatus(`5x5 復原播放開始，共 ${solution.length} 步`);
    await playSequence(solution, { duration: 230, record: false, clearQueue: false });
    history = [];
    solutionQueue = [];
    persistHistory();
    updateCounters();
    refreshCoach(false);
    buildMoveRibbon();
    nextMoveText.textContent = "-";
    setStatus("5x5 已回到練習起點");
    audio.playWin();
    return;
  }

  const solution = await computeSolution();
  if (solution.length === 0) {
    setStatus("已經完成了");
    audio.playWin();
    return;
  }
  nextMoveText.textContent = solution[0] ?? "-";
  setStatus(`自動解開始，共 ${solution.length} 步`);
  await playSequence(solution, { duration: 310, record: true, clearQueue: false });
  solutionQueue = [];
  nextMoveText.textContent = "-";
  refreshCoach(false);
  setStatus("完成，魔方回家了");
  audio.playWin();
}

async function playCoachStep(): Promise<void> {
  if (busy) return;
  if (cubeSize === 5) {
    const coach = refreshCoach(true);
    if (coach.recommended.length > 0) {
      setStatus(`${coach.title}：${coach.recommendationLabel}`);
      await playSequence(coach.recommended, { duration: 360, record: true, clearQueue: true });
      return;
    }

    setStatus(`${coach.title}：${coach.recommendationLabel}`);
    audio.playSoft();
    return;
  }

  const coach = refreshCoach(true);
  if (coach.recommended.length > 0) {
    setStatus(`${coach.title}：${coach.recommendationLabel}`);
    await playSequence(coach.recommended, { duration: 360, record: true, clearQueue: true });
    return;
  }

  solutionQueue = await computeSolution();
  await playOneSolutionStep();
}

async function playSequence(
  moves: readonly MoveToken[],
  options: { duration: number; record: boolean; clearQueue: boolean }
): Promise<void> {
  const token = ++playbackToken;
  setBusy(true);
  scene.setInputEnabled(false);

  try {
    for (const move of moves) {
      if (token !== playbackToken) break;
      nextMoveText.textContent = move;
      scene.highlightMove(move);
      await scene.applyMove(move, options.duration);
      if (token !== playbackToken) break;
      audio.playTurn();
      if (options.record) recordMove(move, options.clearQueue);
      await wait(80);
    }
  } finally {
    if (token === playbackToken) {
      setBusy(false);
      scene.setInputEnabled(true);
      scene.highlightMove(null);
      nextMoveText.textContent = solutionQueue[0] ?? "-";
    }
  }
}

function stopPlayback(): void {
  playbackToken += 1;
  setBusy(false);
  scene.setInputEnabled(true);
}

async function computeSolution(): Promise<MoveToken[]> {
  if (cubeSize === 5) return invertAlgorithm(history);
  setStatus("正在計算下一步");
  try {
    if (externalFacelets) {
      const raw = scene.getFaceletString();
      const validation = validateThreeByThreeFacelets(raw);
      if (!validation.valid) {
        throw new Error(validation.reason);
      }
      externalFacelets = raw;
      persistExternalFacelets();
      const response = await solverRequest({ type: "solveFacelets", facelets: raw });
      if (response.type === "solution") {
        return response.moves ?? [];
      }
      throw new Error(response.message ?? "Solver response failed");
    }

    const response = await solverRequest({ type: "solve", algorithm: movesToAlgorithm(history) });
    if (response.type === "solution") {
      return response.moves ?? [];
    }
    throw new Error(response.message ?? "Solver response failed");
  } catch (error) {
    console.error(error);
    setStatus("解法計算失敗，請先復原或重新打亂");
    audio.playError();
    return [];
  }
}

function solverRequest(
  payload: { type: "init" } | { type: "solve"; algorithm: string } | { type: "solveFacelets"; facelets: string }
): Promise<SolverResponse> {
  const id = ++solverRequestId;
  const message = { id, ...payload };

  return new Promise((resolve, reject) => {
    pendingSolverRequests.set(id, { resolve, reject });
    solver.postMessage(message);
  });
}

solver.onmessage = (event: MessageEvent<SolverResponse>) => {
  const pending = pendingSolverRequests.get(event.data.id);
  if (!pending) return;
  pendingSolverRequests.delete(event.data.id);
  if (event.data.type === "error") {
    pending.reject(new Error(event.data.message ?? "Solver failed"));
    return;
  }
  pending.resolve(event.data);
};

solver.onerror = (event) => {
  for (const pending of pendingSolverRequests.values()) {
    pending.reject(new Error(event.message));
  }
  pendingSolverRequests.clear();
};

function recordMove(move: MoveToken, clearQueue: boolean): void {
  history.push(move);
  if (clearQueue) {
    solutionQueue = [];
    nextMoveText.textContent = "-";
  }
  if (externalFacelets) {
    externalFacelets = scene.getFaceletString();
    persistExternalFacelets();
  } else {
    persistHistory();
  }
  updateCounters();
  refreshCoach(false);
  buildMoveRibbon();
}

function updateCounters(): void {
  document.documentElement.style.setProperty("--move-count", `"${history.length}"`);
}

function persistHistory(): void {
  localStorage.setItem(movesStorageKey(cubeSize), JSON.stringify(history));
}

function persistExternalFacelets(): void {
  if (!externalFacelets) return;
  localStorage.setItem(STORAGE_SCANNED_FACELETS, externalFacelets);
}

function clearExternalFacelets(): void {
  externalFacelets = null;
  localStorage.removeItem(STORAGE_SCANNED_FACELETS);
}

function loadExternalFacelets(): string | null {
  const raw = localStorage.getItem(STORAGE_SCANNED_FACELETS);
  if (!raw) return null;
  const normalized = normalizeFaceletInput(raw);
  const validation = validateThreeByThreeFacelets(normalized);
  if (!validation.valid) {
    localStorage.removeItem(STORAGE_SCANNED_FACELETS);
    return null;
  }
  return normalized;
}

function loadHistory(): MoveToken[] {
  const raw = localStorage.getItem(movesStorageKey(cubeSize));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => parseMove(String(value))).filter((move): move is MoveToken => move !== null);
  } catch {
    return [];
  }
}

function refreshCoach(includeRecommendation: boolean): BeginnerCoach {
  if (cubeSize === 5) {
    currentCoach = fiveByFiveCoach(includeRecommendation);
    if (getMode() === "teach") {
      renderCoach(currentCoach);
    }
    return currentCoach;
  }

  currentCoach = externalFacelets
    ? evaluateBeginnerCoachFromString(scene.getFaceletString(), { includeRecommendation })
    : evaluateBeginnerCoach(history, { includeRecommendation });
  if (getMode() === "teach") {
    renderCoach(currentCoach);
  }
  return currentCoach;
}

function renderCoach(coach: BeginnerCoach): void {
  lessonLabel.textContent = `${coach.label} · ${coach.progressLabel}`;
  lessonTitle.textContent = coach.title;
  lessonBody.textContent =
    coach.stageId === "solved" ? coach.body : `${coach.body} ${coach.recommendationLabel}。`;
  lessonProgressText.textContent = coach.progressLabel;
  const ratio = coach.total > 0 ? Math.min(1, coach.progress / coach.total) : 1;
  lessonProgressBar.style.width = `${Math.round(ratio * 100)}%`;

  if (coach.recommended[0]) {
    scene.highlightMove(coach.recommended[0]);
    nextMoveText.textContent = coach.recommended[0];
  } else if (coach.highlightFacelets?.length) {
    scene.highlightFacelets(coach.highlightFacelets);
    nextMoveText.textContent = "-";
  } else {
    scene.highlightFaces(coach.focusFaces);
    nextMoveText.textContent = "-";
  }
}

function setMode(mode: string): void {
  document.body.dataset.mode = mode;
  buildMoveRibbon();
  if (mode === "teach") {
    const coach = refreshCoach(false);
    setStatus(`${coach.label}，先看目前目標`);
  } else if (mode === "solve") {
    setStatus("按提示、一步或自動解");
  } else {
    scene.highlightMove(null);
    setStatus("自由拖曳轉層");
  }
}

function setActiveMode(mode: string): void {
  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
  setMode(mode);
}

function getMode(): string {
  return document.body.dataset.mode ?? "play";
}

function setBusy(nextBusy: boolean): void {
  busy = nextBusy;
  document.body.classList.toggle("is-busy", busy);
}

function setStatus(message: string): void {
  statusText.textContent = message;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function switchCubeSize(nextSize: CubeSize): Promise<void> {
  if (busy || scene.isBusy() || nextSize === cubeSize) return;
  stopPlayback();
  cubeSize = nextSize;
  scene.setCubeSize(cubeSize);
  history = loadHistory();
  if (cubeSize === 3 && externalFacelets) history = [];
  solutionQueue = [];
  currentCoach =
    cubeSize === 5
      ? fiveByFiveCoach(false)
      : externalFacelets
        ? evaluateBeginnerCoachFromString(externalFacelets)
        : evaluateBeginnerCoach(history);
  buildMoveRibbon();
  renderCubeSizeTabs();
  renderCoach(currentCoach);
  updateCounters();
  nextMoveText.textContent = "-";
  await restoreSavedCube();
  setStatus(cubeSize === 5 ? "5x5 外層練習模式，先熟悉大魔方手感" : "3x3 模式，可使用提示與自動解");
}

function renderCubeSizeTabs(): void {
  document.querySelectorAll<HTMLButtonElement>(".cube-size-tab").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.size) === cubeSize);
  });
}

async function playOneFiveByFiveUndoStep(): Promise<void> {
  const last = history.pop();
  if (!last) {
    setStatus("5x5 已經完成目前練習");
    audio.playWin();
    return;
  }

  const move = inverseMove(last);
  setBusy(true);
  scene.setInputEnabled(false);
  try {
    scene.highlightMove(move);
    nextMoveText.textContent = move;
    await scene.applyMove(move, 230);
    audio.playTurn();
    persistHistory();
    updateCounters();
    refreshCoach(false);
    buildMoveRibbon();
    setStatus(`5x5 已復原 ${move}`);
  } finally {
    setBusy(false);
    scene.setInputEnabled(true);
    scene.highlightMove(null);
    nextMoveText.textContent = history.length > 0 ? inverseMove(history[history.length - 1]) : "-";
  }
}

function getInitialCubeSize(): CubeSize {
  const params = new URLSearchParams(window.location.search);
  const requestedSize = (params.get("cube") ?? params.get("size") ?? params.get("v") ?? "").toLowerCase();
  return requestedSize === "5" || requestedSize === "5x5" || requestedSize === "5x5x5" ? 5 : 3;
}

function movesStorageKey(size: CubeSize): string {
  return size === 3 ? STORAGE_MOVES : `${STORAGE_MOVES}.5x5`;
}

function getRibbonMoves(): MoveToken[] {
  if (cubeSize !== 5) return THREE_BY_THREE_RIBBON_MOVES;
  return shouldLockFiveByFiveToOuterMoves() ? THREE_BY_THREE_RIBBON_MOVES : FIVE_BY_FIVE_FULL_RIBBON_MOVES;
}

function isManualMoveAllowed(move: MoveToken): boolean {
  if (cubeSize !== 5) return true;
  if (!shouldLockFiveByFiveToOuterMoves()) return true;
  return !isWideMove(move) && !isInnerMove(move);
}

function shouldLockFiveByFiveToOuterMoves(): boolean {
  return getMode() !== "play" && isFiveByFiveProjectedThreeByThreePhase();
}

function isFiveByFiveProjectedThreeByThreePhase(): boolean {
  if (cubeSize !== 5 || scene.getCubeSize() !== 5) return false;
  const raw5 = scene.getFaceletString();
  if (analyzeFiveByFiveCenters(raw5).completedCenters < 6) return false;
  if (analyzeFiveByFiveEdges(raw5).pairedEdges < 12) return false;
  return validateProjectedThreeByThree(projectFiveByFiveToThreeByThree(raw5)).valid;
}

function fiveByFiveCoach(includeRecommendation: boolean): BeginnerCoach {
  const raw5 = scene.getFaceletString();
  const centerState = analyzeFiveByFiveCenters(raw5);
  if (centerState.completedCenters < 6) {
    return {
      stageId: "white-cross",
      label: "5x5 中心",
      title: `先做${centerState.nextFaceName}中心`,
      body: `5x5 要先把每一面的中間 3x3 中心拼好。目前中心完成 ${centerState.completedCenters}/6，中心貼紙完成 ${centerState.centerMatches}/54。`,
      focusFaces: [centerState.nextFace],
      highlightFacelets: centerState.nextTargets,
      progress: centerState.centerMatches,
      total: 54,
      progressLabel: `${centerState.centerMatches}/54`,
      recommended: [],
      recommendationLabel: "先用外層與兩層轉動把同色中心聚在一起",
    };
  }

  const edgeState = analyzeFiveByFiveEdges(raw5);
  if (edgeState.pairedEdges < 12) {
    return {
      stageId: "middle-layer",
      label: "5x5 邊塊",
      title: `配對${edgeState.nextEdgeName}`,
      body: `中心已完成。現在把每條邊的 3 個邊塊配成同一組顏色，目前完成 ${edgeState.pairedEdges}/12 條邊。`,
      focusFaces: edgeState.nextFaces,
      highlightFacelets: edgeState.nextTargets,
      progress: edgeState.pairedEdges,
      total: 12,
      progressLabel: `${edgeState.pairedEdges}/12`,
      recommended: [],
      recommendationLabel: "先觀察高亮的邊，讓同一組兩色邊塊排在一起",
    };
  }

  const projected = projectFiveByFiveToThreeByThree(raw5);
  const validation = validateProjectedThreeByThree(projected);
  if (!validation.valid) {
    return {
      stageId: "parity",
      label: "5x5 Parity",
      title: "先修正 5x5 parity",
      body: `中心與 12 條邊看起來已完成，但投影到 3x3 時不合法：${validation.reason}。先回到邊塊配對階段，修正最後一組邊或 parity。`,
      focusFaces: ["U", "F", "R"],
      highlightFacelets: [
        { face: "U", index: 21 },
        { face: "U", index: 22 },
        { face: "U", index: 23 },
        { face: "F", index: 1 },
        { face: "F", index: 2 },
        { face: "F", index: 3 },
      ],
      progress: 0,
      total: 1,
      progressLabel: "parity",
      recommended: includeRecommendation ? FIVE_BY_FIVE_PARITY_ALGORITHM : [],
      recommendationLabel: `把壞邊放在前上方，練習 ${FIVE_BY_FIVE_PARITY_ALGORITHM.join(" ")} 修正 parity`,
    };
  }

  const projectedCoach = evaluateBeginnerCoachFromString(projected, { includeRecommendation });
  return {
    ...projectedCoach,
    label: `5x5 轉 3x3 · ${projectedCoach.label}`,
    body: `Reduction 已完成，現在只轉外層，照 3x3 步驟解。${projectedCoach.body}`,
    recommendationLabel:
      projectedCoach.recommended.length > 0
        ? `現在用外層做 ${projectedCoach.recommended.join(" ")}`
        : projectedCoach.recommendationLabel,
  };
}

function registerPwa(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event as BeforeInstallPromptEvent;
    btnInstall.classList.remove("hidden");
    installBanner.classList.remove("hidden");
  });

  const runInstall = async (): Promise<void> => {
    if (!deferredInstall) {
      setStatus("在 iPhone 上可用分享選單加入主畫面");
      installBanner.classList.remove("hidden");
      return;
    }
    await deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    btnInstall.classList.add("hidden");
    installBanner.classList.add("hidden");
  };

  btnInstall.addEventListener("click", () => void runInstall());
  btnInstallBanner.addEventListener("click", () => void runInstall());
  btnInstallClose.addEventListener("click", () => installBanner.classList.add("hidden"));

  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js").then((registration) => {
        void registration.update();
      });
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }
}
