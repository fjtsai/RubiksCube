import "./styles.css";
import { evaluateBeginnerCoachFromString, type BeginnerCoach } from "./domain/beginner-coach";
import { mapFaceletToCurrent, mapMoveToCurrent, uprightFacelets, type UprightResult } from "./domain/cube-geometry";
import {
  analyzeFiveByFiveCenters,
  analyzeFiveByFiveEdges,
  projectFiveByFiveToThreeByThree,
  validateProjectedThreeByThree,
} from "./domain/five-by-five-reduction";
import {
  describeMove,
  getMoveSuffix,
  invertAlgorithm,
  inverseMove,
  isInnerMove,
  isSliceMove,
  isWideMove,
  MOVE_SPECS,
  parseMove,
  randomFiveByFiveScramble,
  randomScramble,
  simplifyMoves,
  type FaceMove,
  type MoveToken,
} from "./domain/moves";
import { normalizeFaceletInput, SOLVED_THREE_BY_THREE_FACELETS, type ScanFace } from "./domain/scanner-state";
import { validateThreeByThreeFacelets } from "./domain/three-by-three-validation";
import { AudioEngine } from "./game/audio";
import { RubiksScene, type CubeSize } from "./game/rubiks-scene";
import { icon } from "./ui/icons";
import { ScannerUi } from "./ui/scanner-ui";

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

type Mode = "play" | "teach" | "solve";
type LayerDepth = "outer" | "inner" | "middle" | "wide";
type MoveSource = "user" | "assist" | "scramble";

// 目前跟著走的解法：玩家照著轉就往前推進，轉了別的步驟就作廢、需要時重算。
interface SolutionPlan {
  moves: MoveToken[];
  index: number;
  // 半圈步驟（例如 U2）可以分兩次四分之一圈完成，記住已經轉了的那一下。
  partial: MoveToken | null;
  source: "solver" | "coach";
}

interface PlaySession {
  active: boolean;
  moves: number;
  startedAt: number | null;
  finishedAt: number | null;
  assisted: boolean;
}

const STORAGE_MOVES = "kids-rubiks.moves";
const STORAGE_SOUND = "kids-rubiks.sound";
const STORAGE_SCANNED_FACELETS = "kids-rubiks.facelets.scanned";
const STORAGE_SESSION = "kids-rubiks.session";
const STORAGE_GESTURE_COACH = "kids-rubiks.gesture-coach.seen";
const FIVE_BY_FIVE_PARITY_ALGORITHM: MoveToken[] = ["Rw2", "F2", "U2", "2R2", "U2", "F2", "Rw2"];
const PAD_FACES: FaceMove[] = ["U", "R", "F", "D", "L", "B"];
const LAYER_TABS: Record<CubeSize, Array<{ depth: LayerDepth; label: string }>> = {
  3: [
    { depth: "outer", label: "外層" },
    { depth: "middle", label: "中間層" },
  ],
  5: [
    { depth: "outer", label: "外層" },
    { depth: "inner", label: "第二層" },
    { depth: "middle", label: "正中間" },
    { depth: "wide", label: "外兩層" },
  ],
};
const SLICE_PAD: Array<{ move: MoveToken; label: string; face: FaceMove }> = [
  { move: "M", label: "直排 ↓", face: "L" },
  { move: "E", label: "橫排 →", face: "D" },
  { move: "S", label: "夾層 ↻", face: "F" },
  { move: "M'", label: "直排 ↑", face: "R" },
  { move: "E'", label: "橫排 ←", face: "U" },
  { move: "S'", label: "夾層 ↺", face: "B" },
];
const MODE_LABELS: Record<Mode, string> = { play: "自由玩", teach: "教我解", solve: "解題" };
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
  <main class="game-shell" id="game-shell">
    <div class="scene-mount" id="scene-mount"></div>

    <header class="top-hud" id="top-hud">
      <div class="hud-row">
        <div class="brand-lockup">
          <span class="brand-cube" aria-hidden="true"></span>
          <h1>魔方小玩家</h1>
        </div>
        <div class="size-switch" role="group" aria-label="方塊尺寸">
          <button class="size-option" type="button" data-size="3">3×3</button>
          <button class="size-option" type="button" data-size="5">5×5</button>
        </div>
        <div class="top-actions">
          <button class="icon-button" id="btn-import-facelets" type="button" aria-label="掃描實體魔方" title="掃描實體魔方">${icon("camera")}</button>
          <button class="icon-button" id="btn-sound" type="button" aria-label="音效開關" title="音效">${icon("soundOn")}</button>
          <button class="icon-button hidden" id="btn-install" type="button" aria-label="安裝到主畫面" title="安裝">${icon("download")}</button>
        </div>
      </div>
      <div class="status-card">
        <p id="status-text" aria-live="polite">拖曳任一排就能轉動，按打亂開始挑戰</p>
        <div class="session-stats hidden" id="session-stats" aria-label="這一局">
          <span id="stat-moves">0 步</span>
          <span id="stat-time">00:00</span>
        </div>
      </div>
      <nav class="mode-tabs" role="tablist" aria-label="模式">
        <button class="mode-tab" type="button" role="tab" data-mode="play">${MODE_LABELS.play}</button>
        <button class="mode-tab" type="button" role="tab" data-mode="teach">${MODE_LABELS.teach}</button>
        <button class="mode-tab" type="button" role="tab" data-mode="solve">${MODE_LABELS.solve}</button>
      </nav>
    </header>

    <section class="bottom-stack" id="bottom-stack">
      <section class="info-card lesson-card" id="lesson-card" aria-label="教學">
        <div class="lesson-text">
          <span class="eyebrow" id="lesson-label">教學</span>
          <h2 id="lesson-title">白色十字</h2>
          <p id="lesson-body"></p>
          <div class="lesson-progress" aria-label="教學進度">
            <span id="lesson-progress-text">0/0</span>
            <i><b id="lesson-progress-bar"></b></i>
          </div>
        </div>
        <button class="pill-button" id="btn-lesson-demo" type="button">示範</button>
      </section>

      <section class="info-card solution-card" id="solution-card" aria-label="解題步驟">
        <div class="solution-head">
          <span class="eyebrow" id="solution-progress">解題步驟</span>
          <button class="link-button" id="btn-solution-refresh" type="button">重新計算</button>
        </div>
        <div class="solution-current">
          <strong id="solution-move">-</strong>
          <span id="solution-description">按「提示」計算解法</span>
        </div>
        <div class="solution-chips" id="solution-chips"></div>
      </section>

      <section class="move-pad hidden" id="move-pad" aria-label="轉動按鈕">
        <div class="layer-tabs" id="layer-tabs" role="tablist" aria-label="要轉哪一層"></div>
        <div class="move-grid" id="move-grid"></div>
      </section>

      <div class="tool-row">
        <button class="tool-chip" id="btn-pad-toggle" type="button" aria-expanded="false">${icon("pad")}<span>轉動按鈕</span>${icon("chevronDown", "icon chevron")}</button>
        <button class="tool-chip next-chip hidden" id="next-chip" type="button" aria-label="下一步"></button>
        <button class="tool-chip icon-only" id="btn-view-reset" type="button" aria-label="視角回正" title="視角回正（也可以點兩下空白處）">${icon("view")}</button>
      </div>

      <footer class="control-dock">
        <button class="dock-button primary" id="btn-scramble" type="button">${icon("shuffle")}<span>打亂</span></button>
        <button class="dock-button" id="btn-undo" type="button">${icon("undo")}<span>上一步</span></button>
        <button class="dock-button" id="btn-hint" type="button">${icon("bulb")}<span>提示</span></button>
        <button class="dock-button" id="btn-step" type="button">${icon("step")}<span>一步</span></button>
        <button class="dock-button accent" id="btn-auto" type="button">${icon("play")}<span>自動解</span></button>
      </footer>
    </section>

    <div class="gesture-coach hidden" id="gesture-coach" role="dialog" aria-labelledby="gesture-coach-title">
      <div class="coach-card">
        <h2 id="gesture-coach-title">怎麼轉魔方？</h2>
        <ul>
          <li><b>轉一排</b>手指按住任一格往旁邊拖，那一排會跟著轉；放開後轉超過三分之一就完成。中間那排也可以轉。</li>
          <li><b>轉視角</b>拖曳空白處，或兩根手指一起滑動。</li>
          <li><b>放大縮小</b>兩指捏合；點兩下空白處回到原本角度。</li>
        </ul>
        <button class="primary-button" id="btn-gesture-coach-close" type="button">知道了</button>
      </div>
    </div>

    <div class="celebration hidden" id="celebration" role="dialog" aria-labelledby="celebration-title">
      <div class="confetti" id="confetti" aria-hidden="true"></div>
      <div class="celebration-card">
        <span class="eyebrow">完成</span>
        <h2 id="celebration-title">魔方回家了！</h2>
        <p id="celebration-stats"></p>
        <div class="celebration-actions">
          <button class="ghost-button" id="btn-celebration-close" type="button">看一下</button>
          <button class="primary-button" id="btn-celebration-again" type="button">再玩一次</button>
        </div>
      </div>
    </div>

    <div class="install-banner hidden" id="install-banner">
      <span>可以安裝到手機主畫面，離線也能玩。</span>
      <button id="btn-install-banner" type="button">安裝</button>
      <button id="btn-install-close" type="button" aria-label="關閉">${icon("close")}</button>
    </div>

    <div class="sheet-backdrop hidden" id="facelet-dialog" role="dialog" aria-modal="true" aria-labelledby="facelet-dialog-title">
      <div class="sheet">
        <div class="sheet-head">
          <div>
            <span class="eyebrow">實體魔方</span>
            <h2 id="facelet-dialog-title">幫手上的 3×3 找解法</h2>
          </div>
          <button class="icon-button subtle" id="btn-facelet-close" type="button" aria-label="關閉">${icon("close")}</button>
        </div>
        <button class="option-card primary" id="btn-facelet-scan" type="button">
          ${icon("camera", "icon option-icon")}
          <span><b>用相機掃描</b><small>依序拍 6 個面，自動辨識顏色和方向，再一步一步教你轉回來。</small></span>
        </button>
        <button class="option-card" id="btn-facelet-test" type="button">
          ${icon("image", "icon option-icon")}
          <span><b>用示範照片試試</b><small>不用實體魔方，看看掃描流程。</small></span>
        </button>
        <p class="sheet-error" id="facelet-error" role="alert"></p>
        <details class="advanced-input">
          <summary>${icon("keyboard")}<span>進階：輸入顏色代碼</span></summary>
          <p class="sheet-help">54 個字母，順序為 U R F D L B 各 9 格（U=白、R=紅、F=綠、D=黃、L=橘、B=藍）。</p>
          <textarea id="facelet-input" spellcheck="false" autocapitalize="characters" autocomplete="off" rows="3"></textarea>
          <div class="sheet-actions">
            <button class="ghost-button" id="btn-facelet-solved" type="button">填入完成狀態</button>
            <button class="primary-button" id="btn-facelet-apply" type="button">套用並求解</button>
          </div>
        </details>
      </div>
    </div>

    <div class="scanner-overlay hidden" id="scanner-overlay" role="dialog" aria-modal="true" aria-label="掃描實體魔方"></div>
  </main>
`;

const gameShell = requireElement<HTMLElement>("game-shell");
const sceneMount = requireElement<HTMLDivElement>("scene-mount");
const topHud = requireElement<HTMLElement>("top-hud");
const bottomStack = requireElement<HTMLElement>("bottom-stack");
const statusText = requireElement<HTMLParagraphElement>("status-text");
const sessionStats = requireElement<HTMLElement>("session-stats");
const statMoves = requireElement<HTMLElement>("stat-moves");
const statTime = requireElement<HTMLElement>("stat-time");
const lessonLabel = requireElement<HTMLElement>("lesson-label");
const lessonTitle = requireElement<HTMLElement>("lesson-title");
const lessonBody = requireElement<HTMLElement>("lesson-body");
const lessonProgressText = requireElement<HTMLElement>("lesson-progress-text");
const lessonProgressBar = requireElement<HTMLElement>("lesson-progress-bar");
const solutionProgress = requireElement<HTMLElement>("solution-progress");
const solutionMove = requireElement<HTMLElement>("solution-move");
const solutionDescription = requireElement<HTMLElement>("solution-description");
const solutionChips = requireElement<HTMLElement>("solution-chips");
const movePad = requireElement<HTMLElement>("move-pad");
const layerTabs = requireElement<HTMLElement>("layer-tabs");
const moveGrid = requireElement<HTMLElement>("move-grid");
const btnPadToggle = requireElement<HTMLButtonElement>("btn-pad-toggle");
const nextChip = requireElement<HTMLButtonElement>("next-chip");
const btnAuto = requireElement<HTMLButtonElement>("btn-auto");
const btnSound = requireElement<HTMLButtonElement>("btn-sound");
const btnInstall = requireElement<HTMLButtonElement>("btn-install");
const installBanner = requireElement<HTMLDivElement>("install-banner");
const faceletDialog = requireElement<HTMLDivElement>("facelet-dialog");
const faceletInput = requireElement<HTMLTextAreaElement>("facelet-input");
const faceletError = requireElement<HTMLParagraphElement>("facelet-error");
const gestureCoach = requireElement<HTMLElement>("gesture-coach");
const celebration = requireElement<HTMLElement>("celebration");
const celebrationTitle = requireElement<HTMLElement>("celebration-title");
const celebrationStats = requireElement<HTMLElement>("celebration-stats");
const confetti = requireElement<HTMLElement>("confetti");

const audio = new AudioEngine();
const solver = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
const pendingSolverRequests = new Map<number, { resolve: (response: SolverResponse) => void; reject: (error: Error) => void }>();
let solverRequestId = 0;
let cubeSize: CubeSize = getInitialCubeSize();
let history = loadHistory();
let externalFacelets = cubeSize === 3 ? loadExternalFacelets() : null;
if (externalFacelets) history = [];
let plan: SolutionPlan | null = null;
let currentCoach: BeginnerCoach | null = null;
let mode: Mode = "play";
let layerDepth: LayerDepth = "outer";
let playbackToken = 0;
let playing = false;
let busy = false;
let deferredInstall: BeforeInstallPromptEvent | null = null;
let session: PlaySession = loadSession();
let sessionTimer = 0;
// 動畫進行中連點轉動按鈕時交給場景排隊依序轉，最多先排 4 步，避免點擊被吃掉。
const MAX_QUEUED_PAD_MOVES = 4;
let pendingPadMoves = 0;
let padRenderKey = "";

const scene = new RubiksScene(sceneMount, {
  cubeSize,
  onUserMove: (move) => {
    audio.playTurn();
    vibrate();
    recordMove(move, "user");
    setStatus(mode === "teach" && currentCoach ? `${move}：${describeMove(move)}｜${currentCoach.label}` : `${move}：${describeMove(move)}`);
  },
  onMessage: setStatus,
  isMoveAllowed: (move) => isManualMoveAllowed(move),
  onTurnStart: () => void audio.unlock(),
});

const scanner = new ScannerUi({
  root: requireElement<HTMLElement>("scanner-overlay"),
  testPhotoPaths: TEST_SCAN_PHOTO_PATHS,
  onApply: (raw) => applyImportedFacelets(raw),
  onClose: () => undefined,
  playSoft: () => audio.playSoft(),
  playError: () => audio.playError(),
  playCapture: () => audio.playTurn(),
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
      plan: () => (plan ? { ...plan, moves: [...plan.moves] } : null),
      coach: () => (currentCoach ? { stageId: currentCoach.stageId, progress: currentCoach.progress } : null),
      stickerScreenPoint: (face: FaceMove, index: number) => scene.getFaceletScreenPoint(face, index),
      isBusy: () => scene.isBusy() || busy,
      renderCount: () => scene.getRenderCount(),
    },
  });
}

bindUi();
observeLayout();
renderSizeSwitch();
renderMovePad();
setMode("play");
restoreSavedCube();
renderSession();
void initSolver();
registerPwa();
maybeShowGestureCoach();

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function bindUi(): void {
  document.addEventListener("pointerdown", () => void audio.unlock(), { once: true });

  requireElement<HTMLButtonElement>("btn-scramble").addEventListener("click", () => void scrambleCube());
  requireElement<HTMLButtonElement>("btn-hint").addEventListener("click", () => void showHint());
  requireElement<HTMLButtonElement>("btn-step").addEventListener("click", () => void playOneStep());
  requireElement<HTMLButtonElement>("btn-undo").addEventListener("click", () => void undoMove());
  btnAuto.addEventListener("click", () => void toggleAutoSolve());
  requireElement<HTMLButtonElement>("btn-lesson-demo").addEventListener("click", () => void playCoachDemo());
  requireElement<HTMLButtonElement>("btn-solution-refresh").addEventListener("click", () => void refreshPlan(true));
  requireElement<HTMLButtonElement>("btn-view-reset").addEventListener("click", () => scene.resetView());
  nextChip.addEventListener("click", () => void showHint());
  btnPadToggle.addEventListener("click", () => {
    const open = movePad.classList.toggle("hidden") === false;
    btnPadToggle.setAttribute("aria-expanded", String(open));
    btnPadToggle.classList.toggle("active", open);
  });
  layerTabs.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-depth]");
    if (!tab || tab.disabled) return;
    layerDepth = tab.dataset.depth as LayerDepth;
    renderMovePad();
  });
  moveGrid.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-move]");
    const move = parseMove(button?.dataset.move ?? "");
    if (move) void queuePadMove(move);
  });

  requireElement<HTMLButtonElement>("btn-import-facelets").addEventListener("click", openFaceletDialog);
  requireElement<HTMLButtonElement>("btn-facelet-close").addEventListener("click", closeFaceletDialog);
  faceletDialog.addEventListener("click", (event) => {
    if (event.target === faceletDialog) closeFaceletDialog();
  });
  requireElement<HTMLButtonElement>("btn-facelet-solved").addEventListener("click", () => {
    faceletInput.value = SOLVED_THREE_BY_THREE_FACELETS;
    faceletError.textContent = "";
  });
  requireElement<HTMLButtonElement>("btn-facelet-scan").addEventListener("click", () => void startScanner());
  requireElement<HTMLButtonElement>("btn-facelet-test").addEventListener("click", () => void startTestScan());
  requireElement<HTMLButtonElement>("btn-facelet-apply").addEventListener("click", () => void applyFaceletInput());

  requireElement<HTMLButtonElement>("btn-gesture-coach-close").addEventListener("click", () => {
    gestureCoach.classList.add("hidden");
    storageSet(STORAGE_GESTURE_COACH, "1");
  });
  requireElement<HTMLButtonElement>("btn-celebration-close").addEventListener("click", hideCelebration);
  requireElement<HTMLButtonElement>("btn-celebration-again").addEventListener("click", () => {
    hideCelebration();
    void scrambleCube();
  });

  btnSound.addEventListener("click", () => {
    audio.setEnabled(!audio.isEnabled());
    storageSet(STORAGE_SOUND, audio.isEnabled() ? "1" : "0");
    renderSoundButton();
  });

  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((button) => {
    button.addEventListener("click", () => setMode((button.dataset.mode as Mode) ?? "play"));
  });

  document.querySelectorAll<HTMLButtonElement>(".size-option").forEach((button) => {
    button.addEventListener("click", () => {
      const nextSize = Number(button.dataset.size) === 5 ? 5 : 3;
      void switchCubeSize(nextSize);
    });
  });

  if (storageGet(STORAGE_SOUND) === "0") audio.setEnabled(false);
  renderSoundButton();
}

function renderSoundButton(): void {
  btnSound.innerHTML = icon(audio.isEnabled() ? "soundOn" : "soundOff");
  btnSound.classList.toggle("muted", !audio.isEnabled());
  btnSound.setAttribute("aria-pressed", String(audio.isEnabled()));
}

// 方塊要置中在上方 HUD 與下方控制區之間真正空出來的地方。
function observeLayout(): void {
  const update = (): void => {
    const shell = gameShell.getBoundingClientRect();
    const hud = topHud.getBoundingClientRect();
    const stack = bottomStack.getBoundingClientRect();
    const sideLayout = stack.width < shell.width * 0.62 && stack.left > shell.left + shell.width * 0.3;
    scene.setViewInsets(
      sideLayout
        ? { top: hud.bottom - shell.top + 4, bottom: 8, left: 0, right: shell.right - stack.left + 8 }
        : { top: hud.bottom - shell.top + 4, bottom: shell.bottom - stack.top + 4, left: 0, right: 0 }
    );
  };
  const observer = new ResizeObserver(update);
  observer.observe(topHud);
  observer.observe(bottomStack);
  observer.observe(gameShell);
  update();
}

function maybeShowGestureCoach(): void {
  if (storageGet(STORAGE_GESTURE_COACH) === "1") return;
  gestureCoach.classList.remove("hidden");
}

function openFaceletDialog(): void {
  if (busy) return;
  stopPlayback();
  faceletInput.value = cubeSize === 3 ? scene.getFaceletString() : "";
  faceletError.textContent = "";
  faceletDialog.classList.remove("hidden");
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
  closeFaceletDialog();
  try {
    await scanner.open();
  } catch (error) {
    openFaceletDialog();
    faceletError.textContent = error instanceof Error ? error.message : "無法開啟相機";
    audio.playError();
  }
}

async function startTestScan(): Promise<void> {
  if (busy) return;
  closeFaceletDialog();
  try {
    await scanner.openWithTestPhotos();
  } catch (error) {
    console.error(error);
    scanner.close();
    openFaceletDialog();
    faceletError.textContent = error instanceof Error ? error.message : "示範照片載入失敗";
    audio.playError();
  }
}

// ---------- 轉動按鈕面板 ----------

async function queuePadMove(move: MoveToken): Promise<void> {
  if (busy || pendingPadMoves >= MAX_QUEUED_PAD_MOVES) return;
  pendingPadMoves += 1;
  try {
    await applyManualMove(move, "user", true);
  } finally {
    pendingPadMoves -= 1;
  }
}

function renderMovePad(): void {
  const tabs = LAYER_TABS[cubeSize];
  const outerOnly = cubeSize === 5 && shouldLockFiveByFiveToOuterMoves();
  if (!tabs.some((tab) => tab.depth === layerDepth) || (outerOnly && layerDepth !== "outer")) layerDepth = "outer";
  const key = `${cubeSize}:${layerDepth}:${outerOnly}`;
  if (key === padRenderKey) return;
  padRenderKey = key;

  layerTabs.innerHTML = tabs
    .map(
      (tab) =>
        `<button class="layer-tab ${tab.depth === layerDepth ? "active" : ""}" type="button" role="tab" aria-selected="${tab.depth === layerDepth}" data-depth="${tab.depth}" ${outerOnly && tab.depth !== "outer" ? "disabled" : ""}>${tab.label}</button>`
    )
    .join("");

  if (layerDepth === "middle") {
    moveGrid.className = "move-grid slices";
    moveGrid.innerHTML = SLICE_PAD.map(
      (item) =>
        `<button class="move-button" type="button" data-move="${item.move}" style="--face:${padStripeColor(item.face)}" aria-label="${describeMove(item.move)}"><b>${item.move}</b><small>${item.label}</small></button>`
    ).join("");
    return;
  }

  moveGrid.className = "move-grid";
  const tokenFor = (face: FaceMove, prime: boolean): MoveToken => {
    const base = layerDepth === "inner" ? `2${face}` : layerDepth === "wide" ? `${face}w` : face;
    return `${base}${prime ? "'" : ""}` as MoveToken;
  };
  moveGrid.innerHTML = [false, true]
    .flatMap((prime) =>
      PAD_FACES.map((face) => {
        const move = tokenFor(face, prime);
        return `<button class="move-button" type="button" data-move="${move}" style="--face:${padStripeColor(face)}" aria-label="${describeMove(move)}"><b>${move}</b><small>${prime ? "↺" : "↻"}</small></button>`;
      })
    )
    .join("");
}

// 白色面的色條在白色按鈕上看不見，改用淺灰。
function padStripeColor(face: FaceMove): string {
  return face === "U" ? "#c3ccd6" : MOVE_SPECS[face].color;
}

// ---------- 解法與提示 ----------

async function initSolver(): Promise<void> {
  try {
    await solverRequest({ type: "init" });
    if (cubeSize === 5) {
      setStatus(history.length > 0 ? "已載入 5×5 進度" : "5×5 大魔方：外層、第二層、正中間都可以拖曳");
      return;
    }
    if (externalFacelets) {
      setStatus("已載入實體魔方狀態，按「一步」跟著轉");
      return;
    }
    setStatus(history.length > 0 ? "已載入上次進度" : "拖曳任一排就能轉動，按打亂開始挑戰");
  } catch (error) {
    setStatus("解法引擎暫時無法啟動");
    console.error(error);
  }
}

function restoreSavedCube(): void {
  if (cubeSize === 3 && externalFacelets) {
    scene.setFaceletString(externalFacelets);
  } else if (history.length > 0) {
    for (const move of history) void scene.applyMove(move, 0);
  }
  refreshCoach(false);
  renderMovePad();
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
  hideCelebration();
  if (cubeSize !== 3) {
    cubeSize = 3;
    scene.setCubeSize(cubeSize);
    renderSizeSwitch();
  }

  history = [];
  plan = null;
  externalFacelets = raw;
  scene.setFaceletString(raw);
  scene.resetView();
  persistExternalFacelets();
  storageRemove(movesStorageKey(3));
  startSession();
  renderMovePad();
  setMode("solve");
  await refreshPlan(false);
  const firstMove = (plan as SolutionPlan | null)?.moves[0];
  setStatus(firstMove ? `已匯入！手上的魔方白色朝上、綠色朝自己，先轉 ${firstMove}` : "已匯入，這顆魔方已經完成了");
  audio.playSoft();
}

async function scrambleCube(): Promise<void> {
  if (busy) return;
  stopPlayback();
  hideCelebration();
  clearExternalFacelets();
  scene.reset();
  history = [];
  plan = null;
  persistHistory();
  setStatus("正在打亂…");
  await playSequence(cubeSize === 5 ? randomFiveByFiveScramble(34) : randomScramble(20), {
    duration: cubeSize === 5 ? 110 : 140,
    source: "scramble",
  });
  startSession();
  refreshCoach(false);
  if (mode === "solve") await refreshPlan(false);
  setStatus("換你了！拖曳任一排開始轉");
}

async function applyManualMove(move: MoveToken, source: MoveSource = "user", allowQueue = false): Promise<void> {
  if (busy || (!allowQueue && scene.isBusy())) return;
  if (!isManualMoveAllowed(move)) {
    setStatus("中心和邊都拼好了，現在只轉外層，避免弄亂");
    audio.playError();
    return;
  }

  await audio.unlock();
  if (!(await scene.applyMove(move))) return;
  audio.playTurn();
  recordMove(move, source);
  setStatus(`${move}：${describeMove(move)}`);
}

async function undoMove(): Promise<void> {
  if (busy || scene.isBusy()) return;
  const last = history.pop();
  if (!last) {
    setStatus("沒有可以退回的步驟");
    audio.playError();
    return;
  }
  if (!(await scene.applyMove(inverseMove(last), 190))) {
    history.push(last);
    return;
  }
  audio.playSoft();
  rewindPlan(last);
  persistCurrentState();
  if (session.active && session.moves > 0) session.moves -= 1;
  persistSession();
  renderSession();
  refreshCoach(false);
  renderMovePad();
  renderPlan();
  setStatus(`退回一步（${inverseMove(last)}）`);
}

async function showHint(): Promise<void> {
  if (busy || scene.isBusy()) return;
  if (scene.isSolved()) {
    clearHints();
    setStatus("已經完成了！按打亂再玩一次");
    audio.playWin();
    return;
  }

  if (mode === "teach") {
    const coach = refreshCoach(true);
    if (coach.recommended.length > 0) {
      setPlan(coach.recommended, "coach");
      setStatus(`${coach.title}：先做 ${coach.recommended[0]}（${describeMove(coach.recommended[0])}）`);
      audio.playSoft();
      return;
    }
  }

  const next = await ensurePlan();
  if (!next) return;
  setStatus(`下一步 ${next}：${describeMove(next)}，照箭頭方向轉`);
  audio.playSoft();
}

async function playOneStep(): Promise<void> {
  if (busy || scene.isBusy()) return;
  if (scene.isSolved()) {
    setStatus("已經完成了！");
    audio.playWin();
    return;
  }
  if (mode === "teach" && (!plan || plan.source !== "coach")) {
    const coach = refreshCoach(true);
    if (coach.recommended.length > 0) setPlan(coach.recommended, "coach");
  }
  const next = plan?.moves[plan.index] ?? (await ensurePlan());
  if (!next) return;
  await applyManualMove(next, "assist");
}

async function toggleAutoSolve(): Promise<void> {
  if (playing) {
    stopPlayback();
    setStatus("已暫停，可以按「一步」繼續");
    return;
  }
  if (busy || scene.isBusy()) return;
  if (scene.isSolved()) {
    setStatus("已經完成了！");
    audio.playWin();
    return;
  }
  if (!plan || plan.source !== "solver") await refreshPlan(false);
  if (!plan) return;
  const remaining = plan.moves.slice(plan.index);
  setStatus(`自動解開始，還有 ${remaining.length} 步`);
  await playSequence(remaining, { duration: 300, source: "assist" });
}

async function playCoachDemo(): Promise<void> {
  if (busy || scene.isBusy()) return;
  const coach = refreshCoach(true);
  if (coach.recommended.length === 0) {
    setStatus(`${coach.title}：${coach.recommendationLabel}`);
    audio.playSoft();
    return;
  }
  setStatus(`${coach.title}：示範 ${coach.recommended.join(" ")}`);
  setPlan(coach.recommended, "coach");
  await playSequence(coach.recommended, { duration: 360, source: "assist" });
}

async function ensurePlan(): Promise<MoveToken | null> {
  if (!plan || plan.index >= plan.moves.length) await refreshPlan(false);
  const next = plan?.moves[plan.index] ?? null;
  if (next) scene.highlightMove(next, { arrow: true });
  return next;
}

async function refreshPlan(announce: boolean): Promise<void> {
  if (scene.isSolved()) {
    plan = null;
    renderPlan();
    return;
  }
  setStatus("正在計算解法…");
  const moves = await computeSolution();
  setPlan(moves, "solver");
  if (announce && moves[0]) setStatus(`重新算好了，共 ${moves.length} 步，先轉 ${moves[0]}`);
  else if (moves[0]) setStatus(`共 ${moves.length} 步，先轉 ${moves[0]}：${describeMove(moves[0])}`);
}

function setPlan(moves: MoveToken[], source: SolutionPlan["source"]): void {
  plan = moves.length > 0 ? { moves: [...moves], index: 0, partial: null, source } : null;
  renderPlan();
}

// 玩家照著解法轉就往前推進；轉了不一樣的步驟就讓解法作廢。
function advancePlan(move: MoveToken): void {
  if (!plan) return;
  const expected = plan.moves[plan.index];
  if (move === expected) {
    plan.index += 1;
    plan.partial = null;
  } else if (expected && getMoveSuffix(expected) === "2" && sameLayer(move, expected) && getMoveSuffix(move) !== "2") {
    if (plan.partial === null) {
      plan.partial = move;
    } else if (plan.partial === move) {
      plan.index += 1;
      plan.partial = null;
    } else {
      plan.partial = null;
    }
  } else {
    plan = null;
  }
  if (plan && plan.index >= plan.moves.length) plan = null;
}

function rewindPlan(undone: MoveToken): void {
  if (!plan) return;
  if (plan.partial) {
    plan.partial = plan.partial === undone ? null : plan.partial;
    return;
  }
  const previous = plan.moves[plan.index - 1];
  if (previous === undone) {
    plan.index -= 1;
  } else if (previous && getMoveSuffix(previous) === "2" && sameLayer(previous, undone)) {
    plan.index -= 1;
    plan.partial = undone;
  } else {
    plan = null;
  }
}

function sameLayer(a: MoveToken, b: MoveToken): boolean {
  return a.replace(/[2']$/, "") === b.replace(/[2']$/, "");
}

function clearHints(): void {
  scene.highlightMove(null);
  nextChip.classList.add("hidden");
}

async function playSequence(moves: readonly MoveToken[], options: { duration: number; source: MoveSource }): Promise<void> {
  const token = ++playbackToken;
  setBusy(true);
  playing = options.source !== "scramble";
  renderAutoButton();
  scene.setInputEnabled(false);

  try {
    for (const move of moves) {
      if (token !== playbackToken) break;
      scene.highlightMove(move);
      const applied = await scene.applyMove(move, options.duration);
      if (!applied || token !== playbackToken) break;
      audio.playTurn();
      recordMove(move, options.source);
      await wait(70);
    }
  } finally {
    if (token === playbackToken) {
      setBusy(false);
      playing = false;
      renderAutoButton();
      scene.setInputEnabled(true);
      renderPlan();
    }
  }
}

function stopPlayback(): void {
  playbackToken += 1;
  playing = false;
  renderAutoButton();
  setBusy(false);
  scene.setInputEnabled(true);
}

function renderAutoButton(): void {
  btnAuto.innerHTML = playing ? `${icon("pause")}<span>暫停</span>` : `${icon("play")}<span>自動解</span>`;
  btnAuto.classList.toggle("playing", playing);
}

async function computeSolution(): Promise<MoveToken[]> {
  if (cubeSize === 5) return invertAlgorithm(simplifyMoves(history));
  try {
    // 中間層會帶著中心一起轉：先把整顆轉回標準方向求解，再把每一步換回目前畫面上的面。
    const upright = uprightFacelets(scene.getFaceletString(), 3);
    const validation = validateThreeByThreeFacelets(upright.raw);
    if (!validation.valid) throw new Error(validation.reason);
    const response = await solverRequest({ type: "solveFacelets", facelets: upright.raw });
    if (response.type !== "solution") throw new Error(response.message ?? "Solver response failed");
    return (response.moves ?? []).map((move) => mapMoveToCurrent(move, upright.toCurrentFace));
  } catch (error) {
    console.error(error);
    setStatus("解法計算失敗，請先退回幾步或重新打亂");
    audio.playError();
    return [];
  }
}

function solverRequest(
  payload: { type: "init" } | { type: "solveFacelets"; facelets: string }
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

// ---------- 狀態記錄 ----------

function recordMove(move: MoveToken, source: MoveSource): void {
  history.push(move);
  if (source !== "scramble") {
    advancePlan(move);
    if (session.active && session.finishedAt === null) {
      if (session.startedAt === null) session.startedAt = Date.now();
      session.moves += 1;
      if (source === "assist") session.assisted = true;
      ensureSessionTimer();
    }
  }

  const solved = scene.isSolved();
  // 5x5 用移動紀錄求解；回到完成狀態時清空，紀錄才不會越來越長。
  if (solved && cubeSize === 5) history = [];
  persistCurrentState();
  persistSession();
  if (source === "scramble") return;

  refreshCoach(false);
  renderMovePad();
  renderPlan();
  renderSession();
  if (solved) onSolved();
}

function onSolved(): void {
  plan = null;
  renderPlan();
  clearHints();
  setStatus("完成了！每一面都回到同一個顏色");
  if (!session.active || session.finishedAt !== null) return;
  session.finishedAt = Date.now();
  persistSession();
  renderSession();
  showCelebration();
}

function persistCurrentState(): void {
  if (externalFacelets) {
    externalFacelets = scene.getFaceletString();
    persistExternalFacelets();
  } else {
    persistHistory();
  }
}

function startSession(): void {
  session = { active: true, moves: 0, startedAt: null, finishedAt: null, assisted: false };
  persistSession();
  renderSession();
}

function ensureSessionTimer(): void {
  if (sessionTimer) return;
  sessionTimer = window.setInterval(renderSession, 1000);
}

function renderSession(): void {
  const visible = session.active;
  sessionStats.classList.toggle("hidden", !visible);
  if (!visible) return;
  statMoves.textContent = `${session.moves} 步`;
  const end = session.finishedAt ?? Date.now();
  const elapsed = session.startedAt ? Math.max(0, end - session.startedAt) : 0;
  statTime.textContent = formatDuration(elapsed);
  if ((session.finishedAt !== null || session.startedAt === null) && sessionTimer) {
    window.clearInterval(sessionTimer);
    sessionTimer = 0;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function showCelebration(): void {
  const elapsed = session.startedAt && session.finishedAt ? session.finishedAt - session.startedAt : 0;
  celebrationTitle.textContent = session.assisted ? "完成了！" : "你自己完成了！";
  celebrationStats.textContent = `${session.moves} 步・${formatDuration(elapsed)}${session.assisted ? "（有用提示或自動解）" : ""}`;
  const colors = Object.values(MOVE_SPECS).map((spec) => spec.color);
  confetti.innerHTML = Array.from({ length: 42 }, (_, index) => {
    const left = Math.round(Math.random() * 100);
    const delay = (Math.random() * 0.5).toFixed(2);
    const duration = (1.6 + Math.random() * 1.2).toFixed(2);
    const rotate = Math.round(Math.random() * 360);
    return `<i style="left:${left}%;--delay:${delay}s;--duration:${duration}s;--rotate:${rotate}deg;background:${colors[index % colors.length]}"></i>`;
  }).join("");
  celebration.classList.remove("hidden");
  audio.playWin();
  vibrate([20, 40, 20]);
}

function hideCelebration(): void {
  celebration.classList.add("hidden");
  confetti.innerHTML = "";
}

function persistHistory(): void {
  storageSet(movesStorageKey(cubeSize), JSON.stringify(history));
}

function persistExternalFacelets(): void {
  if (!externalFacelets) return;
  storageSet(STORAGE_SCANNED_FACELETS, externalFacelets);
}

function persistSession(): void {
  storageSet(STORAGE_SESSION, JSON.stringify({ ...session, size: cubeSize }));
}

function clearExternalFacelets(): void {
  externalFacelets = null;
  storageRemove(STORAGE_SCANNED_FACELETS);
}

function loadExternalFacelets(): string | null {
  const raw = storageGet(STORAGE_SCANNED_FACELETS);
  if (!raw) return null;
  const normalized = normalizeFaceletInput(raw);
  // 匯入後若轉過中間層，中心會換位，所以要轉回標準方向再驗證。
  const validation = validateThreeByThreeFacelets(uprightFacelets(normalized, 3).raw);
  if (normalized.length !== 54 || !validation.valid) {
    storageRemove(STORAGE_SCANNED_FACELETS);
    return null;
  }
  return normalized;
}

function loadHistory(): MoveToken[] {
  const raw = storageGet(movesStorageKey(cubeSize));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => parseMove(String(value))).filter((move): move is MoveToken => move !== null);
  } catch {
    return [];
  }
}

function loadSession(): PlaySession {
  const empty: PlaySession = { active: false, moves: 0, startedAt: null, finishedAt: null, assisted: false };
  try {
    const parsed = JSON.parse(storageGet(STORAGE_SESSION) ?? "null");
    if (!parsed || parsed.size !== cubeSize) return empty;
    return { ...empty, ...parsed };
  } catch {
    return empty;
  }
}

// ---------- 教學 ----------

function refreshCoach(includeRecommendation: boolean): BeginnerCoach {
  currentCoach = cubeSize === 5 ? fiveByFiveCoach(includeRecommendation) : threeByThreeCoach(includeRecommendation);
  if (mode === "teach") renderCoach(currentCoach);
  return currentCoach;
}

function threeByThreeCoach(includeRecommendation: boolean): BeginnerCoach {
  const upright = uprightFacelets(scene.getFaceletString(), 3);
  return mapCoachToCurrent(evaluateBeginnerCoachFromString(upright.raw, { includeRecommendation }), upright, 3);
}

// 教學一律在「白色中心朝上」的標準方向判斷，再把建議步驟與高亮格子換回目前畫面上的位置。
function mapCoachToCurrent(coach: BeginnerCoach, upright: UprightResult, size: number): BeginnerCoach {
  const recommended = coach.recommended.map((move) => mapMoveToCurrent(move, upright.toCurrentFace));
  return {
    ...coach,
    recommended,
    highlightFacelets: coach.highlightFacelets?.map((target) => mapFaceletToCurrent(target, upright, size)),
    recommendationLabel: recommended.length > 0 ? `建議先練 ${recommended.join(" ")}` : coach.recommendationLabel,
  };
}

function renderCoach(coach: BeginnerCoach): void {
  lessonLabel.textContent = coach.label;
  lessonTitle.textContent = coach.title;
  lessonBody.textContent = coach.stageId === "solved" ? coach.body : `${coach.body} ${coach.recommendationLabel}。`;
  lessonProgressText.textContent = coach.progressLabel;
  const ratio = coach.total > 0 ? Math.min(1, coach.progress / coach.total) : 1;
  lessonProgressBar.style.width = `${Math.round(ratio * 100)}%`;

  if (coach.stageId === "solved") {
    scene.highlightMove(null);
  } else if (coach.recommended[0]) {
    scene.highlightMove(coach.recommended[0], { arrow: true });
  } else if (coach.highlightFacelets?.length) {
    scene.highlightFacelets(coach.highlightFacelets);
  } else {
    scene.highlightFaces(coach.focusFaces);
  }
}

function renderPlan(): void {
  const next = plan?.moves[plan.index] ?? null;
  const canShowChip = mode !== "solve" && next !== null;
  nextChip.classList.toggle("hidden", !canShowChip);
  if (canShowChip && next) nextChip.innerHTML = `<span>下一步</span><b>${next}</b>`;

  if (mode !== "solve") return;
  if (!plan) {
    const solved = scene.isSolved();
    solutionProgress.textContent = solved ? "已完成" : "解題步驟";
    solutionMove.textContent = solved ? "✓" : "?";
    solutionDescription.textContent = solved
      ? "每一面都回到同一個顏色了"
      : history.length > 0
        ? "你轉了別的步驟，按「提示」或「重新計算」重新找解法"
        : "按「提示」計算解法";
    solutionChips.innerHTML = "";
    return;
  }

  const current = plan.moves[plan.index];
  solutionProgress.textContent = `第 ${plan.index + 1} / ${plan.moves.length} 步`;
  solutionMove.textContent = current;
  solutionDescription.textContent = plan.partial ? `${describeMove(current)}（已轉一半，再轉一次 ${plan.partial}）` : describeMove(current);
  solutionChips.innerHTML = plan.moves
    .map((move, index) => `<span class="${index < plan!.index ? "done" : index === plan!.index ? "current" : ""}">${move}</span>`)
    .join("");
  // 只捲動步驟列本身；scrollIntoView 可能連帶捲動外層容器讓版面跑掉。
  const currentChip = solutionChips.querySelector<HTMLElement>(".current");
  if (currentChip) {
    const left = currentChip.offsetLeft - solutionChips.offsetLeft;
    solutionChips.scrollLeft = left - solutionChips.clientWidth / 2 + currentChip.offsetWidth / 2;
  }
  if (!busy) scene.highlightMove(current, { arrow: true });
}

// ---------- 模式 / 尺寸 ----------

function setMode(nextMode: Mode): void {
  mode = nextMode;
  document.body.dataset.mode = mode;
  document.querySelectorAll<HTMLButtonElement>(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  renderMovePad();

  if (mode === "teach") {
    plan = null;
    const coach = refreshCoach(false);
    setStatus(`${coach.label}：${coach.title}`);
  } else if (mode === "solve") {
    renderPlan();
    if (!plan && !scene.isSolved()) void refreshPlan(false);
    else setStatus(scene.isSolved() ? "已經完成了！按打亂或掃描實體魔方" : "照著箭頭轉，或按「一步」");
  } else {
    clearHints();
    setStatus("自由拖曳轉動，按「提示」看下一步");
  }
  renderPlan();
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

function vibrate(pattern: number | number[] = 8): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 不支援震動的裝置直接略過
  }
}

async function switchCubeSize(nextSize: CubeSize): Promise<void> {
  if (busy || scene.isBusy() || nextSize === cubeSize) return;
  stopPlayback();
  hideCelebration();
  cubeSize = nextSize;
  scene.setCubeSize(cubeSize);
  history = loadHistory();
  if (cubeSize === 3) externalFacelets = loadExternalFacelets();
  if (cubeSize === 3 && externalFacelets) history = [];
  plan = null;
  session = loadSession();
  renderSizeSwitch();
  restoreSavedCube();
  renderSession();
  setMode(mode);
  setStatus(cubeSize === 5 ? "5×5 大魔方：外層、第二層、正中間都可以拖曳" : "3×3 模式");
}

function renderSizeSwitch(): void {
  document.querySelectorAll<HTMLButtonElement>(".size-option").forEach((button) => {
    const active = Number(button.dataset.size) === cubeSize;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.body.dataset.size = String(cubeSize);
}

function getInitialCubeSize(): CubeSize {
  const params = new URLSearchParams(window.location.search);
  const requestedSize = (params.get("cube") ?? params.get("size") ?? params.get("v") ?? "").toLowerCase();
  return requestedSize === "5" || requestedSize === "5x5" || requestedSize === "5x5x5" ? 5 : 3;
}

function movesStorageKey(size: CubeSize): string {
  return size === 3 ? STORAGE_MOVES : `${STORAGE_MOVES}.5x5`;
}

function isManualMoveAllowed(move: MoveToken): boolean {
  if (cubeSize !== 5) return true;
  if (!shouldLockFiveByFiveToOuterMoves()) return true;
  return !isWideMove(move) && !isInnerMove(move) && !isSliceMove(move);
}

function shouldLockFiveByFiveToOuterMoves(): boolean {
  return mode !== "play" && isFiveByFiveProjectedThreeByThreePhase();
}

function isFiveByFiveProjectedThreeByThreePhase(): boolean {
  if (cubeSize !== 5 || scene.getCubeSize() !== 5) return false;
  const raw5 = uprightFacelets(scene.getFaceletString(), 5).raw;
  if (analyzeFiveByFiveCenters(raw5).completedCenters < 6) return false;
  if (analyzeFiveByFiveEdges(raw5).pairedEdges < 12) return false;
  return validateProjectedThreeByThree(projectFiveByFiveToThreeByThree(raw5)).valid;
}

function fiveByFiveCoach(includeRecommendation: boolean): BeginnerCoach {
  const upright = uprightFacelets(scene.getFaceletString(), 5);
  const raw5 = upright.raw;
  const centerState = analyzeFiveByFiveCenters(raw5);
  if (centerState.completedCenters < 6) {
    return mapCoachToCurrent(
      {
        stageId: "white-cross",
        label: "5×5 中心",
        title: `先做${centerState.nextFaceName}中心`,
        body: `5×5 要先把每一面中間的 3×3 拼成同色。目前完成 ${centerState.completedCenters}/6 面，中心格 ${centerState.centerMatches}/54。`,
        focusFaces: [centerState.nextFace],
        highlightFacelets: centerState.nextTargets,
        progress: centerState.centerMatches,
        total: 54,
        progressLabel: `${centerState.centerMatches}/54`,
        recommended: [],
        recommendationLabel: "用第二層和外層把同色中心聚在一起",
      },
      upright,
      5
    );
  }

  const edgeState = analyzeFiveByFiveEdges(raw5);
  if (edgeState.pairedEdges < 12) {
    return mapCoachToCurrent(
      {
        stageId: "middle-layer",
        label: "5×5 邊塊",
        title: `配對${edgeState.nextEdgeName}`,
        body: `中心完成了！現在把每條邊的 3 個邊塊配成同一組顏色，目前 ${edgeState.pairedEdges}/12 條。`,
        focusFaces: edgeState.nextFaces,
        highlightFacelets: edgeState.nextTargets,
        progress: edgeState.pairedEdges,
        total: 12,
        progressLabel: `${edgeState.pairedEdges}/12`,
        recommended: [],
        recommendationLabel: "觀察高亮的邊，讓同色的邊塊排在一起",
      },
      upright,
      5
    );
  }

  const projected = projectFiveByFiveToThreeByThree(raw5);
  const validation = validateProjectedThreeByThree(projected);
  if (!validation.valid) {
    return mapCoachToCurrent(
      {
        stageId: "parity",
        label: "5×5 Parity",
        title: "先修正 5×5 parity",
        body: `中心與 12 條邊都好了，但看成 3×3 時不合法：${validation.reason}。把壞掉的邊放在前上方再做公式。`,
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
        recommendationLabel: `把壞邊放在前上方，練習 ${FIVE_BY_FIVE_PARITY_ALGORITHM.join(" ")}`,
      },
      upright,
      5
    );
  }

  const projectedCoach = evaluateBeginnerCoachFromString(projected, { includeRecommendation });
  const mapped = mapCoachToCurrent(
    {
      ...projectedCoach,
      label: `5×5 當 3×3 解 · ${projectedCoach.label}`,
      body: `中心和邊都拼好了，現在只轉外層，照 3×3 步驟解。${projectedCoach.body}`,
      // 3x3 投影的高亮位置無法直接對應到 5x5 貼紙，改用整面高亮。
      highlightFacelets: undefined,
    },
    upright,
    5
  );
  return mapped;
}

// ---------- 小工具 ----------

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 私密瀏覽或儲存空間不足時仍可遊玩，只是不會記住進度
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
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
      setStatus("在 iPhone 上可用分享選單「加入主畫面」");
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
  requireElement<HTMLButtonElement>("btn-install-banner").addEventListener("click", () => void runInstall());
  requireElement<HTMLButtonElement>("btn-install-close").addEventListener("click", () => installBanner.classList.add("hidden"));

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
