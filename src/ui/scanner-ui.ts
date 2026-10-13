import {
  COLOR_LABELS,
  COLOR_SWATCHES,
  colorDistance,
  nameColor,
  rgbToLab,
  type ColorName,
} from "../domain/color-classifier";
import {
  sampleThreeByThreeFromImage,
  sampleThreeByThreeFromSource,
  videoRegionForElement,
  type RgbColor,
} from "../domain/color-sampling";
import { FACE_MOVES, type FaceMove } from "../domain/moves";
import { redecodeScan, reconstructScan, withManualEdits, type ScanReconstruction } from "../domain/scan-reconstruction";
import { icon } from "./icons";

interface Capture {
  samples: RgbColor[];
  thumbnail: string;
}

export interface ScannerUiOptions {
  root: HTMLElement;
  testPhotoPaths: Record<FaceMove, string>;
  onApply: (raw: string) => void | Promise<void>;
  onClose: () => void;
  playSoft: () => void;
  playError: () => void;
  playCapture: () => void;
}

// 建議的拍攝順序：白色朝上、綠色朝自己，先繞一圈拍四個側面，再拍頂面與底面。
// 方向拍歪也沒關係，重建時會自動試每一面的四種旋轉。
const CAPTURE_GUIDE: ReadonlyArray<{ color: ColorName; text: string }> = [
  { color: "green", text: "白色中心朝上，綠色面對準框線" },
  { color: "red", text: "整顆往左轉 90°，換紅色面對準框線" },
  { color: "blue", text: "再往左轉 90°，換藍色面" },
  { color: "orange", text: "再往左轉 90°，換橘色面" },
  { color: "white", text: "綠色面朝自己，把頂部往自己翻，拍白色面" },
  { color: "yellow", text: "綠色面朝自己，把底部往自己翻，拍黃色面" },
];

const NET_LAYOUT: ReadonlyArray<FaceMove | null> = [null, "U", null, null, "L", "F", "R", "B", null, "D", null, null];
const LIVE_INTERVAL_MS = 110;
const STABLE_FRAMES_FOR_AUTO = 6;
const SAME_FACE_DISTANCE = 14;
const AUTO_CAPTURE_STORAGE = "kids-rubiks.scanner.auto";

export class ScannerUi {
  private readonly options: ScannerUiOptions;
  private readonly root: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly frame: HTMLElement;
  private readonly frameCells: HTMLElement[];
  private readonly workCanvas = document.createElement("canvas");
  private readonly liveCanvas = document.createElement("canvas");
  private readonly elements: Record<string, HTMLElement>;

  private stream: MediaStream | null = null;
  private captures: Array<Capture | null> = [null, null, null, null, null, null];
  private retakeSlot: number | null = null;
  private liveTimer = 0;
  private liveNames: Array<ColorName | null> = [];
  private stableFrames = 0;
  private lastSignature = "";
  private autoCapture = false;
  private capturing = false;
  private torchOn = false;
  private result: ScanReconstruction | null = null;
  private edits = new Map<number, FaceMove>();
  private selectedCell: number | null = null;
  private usingTestPhotos = false;

  constructor(options: ScannerUiOptions) {
    this.options = options;
    this.root = options.root;
    this.root.innerHTML = this.template();
    this.video = this.query<HTMLVideoElement>(".scanner-video");
    this.frame = this.query(".scanner-frame");
    this.frameCells = [...this.frame.querySelectorAll<HTMLElement>("i")];
    this.elements = {
      step: this.query(".scanner-step"),
      title: this.query(".scanner-title"),
      chips: this.query(".scanner-chips"),
      instruction: this.query(".scanner-instruction"),
      live: this.query(".scanner-live"),
      shutter: this.query(".scanner-shutter"),
      back: this.query(".scanner-back"),
      auto: this.query(".scanner-auto"),
      torch: this.query(".scanner-torch"),
      review: this.query(".scanner-review"),
      reviewStatus: this.query(".review-status"),
      reviewThumbs: this.query(".review-thumbs"),
      reviewNet: this.query(".review-net"),
      reviewPalette: this.query(".review-palette"),
      reviewFix: this.query(".review-fix"),
      reviewApply: this.query(".review-apply"),
      reviewRestart: this.query(".review-restart"),
    };
    try {
      this.autoCapture = localStorage.getItem(AUTO_CAPTURE_STORAGE) === "1";
    } catch {
      this.autoCapture = false;
    }
    this.bind();
  }

  isOpen(): boolean {
    return !this.root.classList.contains("hidden");
  }

  async open(): Promise<void> {
    this.resetSession();
    this.usingTestPhotos = false;
    this.root.classList.remove("hidden");
    this.showCapture();
    this.render();
    try {
      await this.startCamera();
    } catch (error) {
      console.error(error);
      this.close();
      throw new Error(
        location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1"
          ? "無法開啟相機，請確認瀏覽器的相機權限。"
          : "相機需要 HTTPS 網址才能使用。"
      );
    }
  }

  async openWithTestPhotos(): Promise<void> {
    this.resetSession();
    this.usingTestPhotos = true;
    this.root.classList.remove("hidden");
    this.elements.reviewStatus.textContent = "正在載入示範照片…";
    this.showReview();
    // 示範照片故意打亂拍攝順序並旋轉，順便展示自動判斷面與方向。
    const order: FaceMove[] = ["F", "R", "B", "L", "U", "D"];
    const loaded = await Promise.all(order.map((face) => loadImage(this.options.testPhotoPaths[face])));
    this.captures = loaded.map((image) => ({
      samples: sampleThreeByThreeFromImage(image, this.workCanvas),
      thumbnail: image.src,
    }));
    this.reconstruct();
  }

  close(): void {
    this.stopCamera();
    this.root.classList.add("hidden");
    this.options.onClose();
  }

  private resetSession(): void {
    this.captures = [null, null, null, null, null, null];
    this.retakeSlot = null;
    this.result = null;
    this.edits.clear();
    this.selectedCell = null;
    this.stableFrames = 0;
    this.lastSignature = "";
  }

  private template(): string {
    return `
      <video class="scanner-video" autoplay playsinline muted></video>
      <div class="scanner-layout">
        <header class="scanner-top">
          <button class="scanner-icon scanner-close" type="button" aria-label="關閉掃描">${icon("close")}</button>
          <div class="scanner-heading">
            <span class="scanner-step">掃描 1/6</span>
            <h2 class="scanner-title">拍綠色面</h2>
          </div>
          <button class="scanner-icon scanner-torch hidden" type="button" aria-label="手電筒">${icon("flash")}</button>
        </header>
        <div class="scanner-chips" aria-label="已拍的面"></div>
        <div class="scanner-viewport">
          <div class="scanner-frame" aria-hidden="true">${"<i><b></b></i>".repeat(9)}</div>
          <p class="scanner-live" aria-live="polite">把魔方的一面對準框線</p>
        </div>
        <footer class="scanner-bottom">
          <p class="scanner-instruction"></p>
          <div class="scanner-controls">
            <button class="scanner-side scanner-back" type="button">上一面</button>
            <button class="scanner-shutter" type="button" aria-label="拍這一面"><span></span></button>
            <button class="scanner-side scanner-auto" type="button" aria-pressed="false">自動拍</button>
          </div>
        </footer>
      </div>
      <section class="scanner-review hidden" aria-label="確認掃描結果">
        <div class="review-sheet">
          <header class="review-head">
            <div>
              <span class="eyebrow">確認顏色</span>
              <h2>和手上的魔方一樣嗎？</h2>
            </div>
            <button class="scanner-icon review-close" type="button" aria-label="關閉">${icon("close")}</button>
          </header>
          <p class="review-status"></p>
          <div class="review-thumbs"></div>
          <div class="review-net"></div>
          <div class="review-palette" aria-label="改成這個顏色"></div>
          <p class="review-help">點格子再點下方顏色可以修改；點照片可以重拍那一面。</p>
          <div class="review-actions">
            <button class="ghost-button review-restart" type="button">${icon("retake")}<span>重新掃描</span></button>
            <button class="ghost-button review-fix hidden" type="button">${icon("check")}<span>自動修正</span></button>
            <button class="primary-button review-apply" type="button"><span>開始解題</span></button>
          </div>
        </div>
      </section>
    `;
  }

  private bind(): void {
    this.query(".scanner-close").addEventListener("click", () => this.close());
    this.query(".review-close").addEventListener("click", () => this.close());
    this.elements.shutter.addEventListener("click", () => void this.captureCurrent());
    this.elements.back.addEventListener("click", () => this.removeLastCapture());
    this.elements.auto.addEventListener("click", () => {
      this.autoCapture = !this.autoCapture;
      try {
        localStorage.setItem(AUTO_CAPTURE_STORAGE, this.autoCapture ? "1" : "0");
      } catch {
        // 無法儲存設定時仍可使用
      }
      this.render();
    });
    this.elements.torch.addEventListener("click", () => void this.toggleTorch());
    this.elements.reviewRestart.addEventListener("click", () => {
      if (this.usingTestPhotos) {
        this.close();
        return;
      }
      this.resetSession();
      this.showCapture();
      this.render();
    });
    this.elements.reviewFix.addEventListener("click", () => this.autoFix());
    this.elements.reviewApply.addEventListener("click", () => void this.apply());
    this.elements.reviewNet.addEventListener("click", (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!cell) return;
      const index = Number(cell.dataset.index);
      if (index % 9 === 4) {
        this.elements.reviewStatus.textContent = "中心格決定這一面的顏色，若中心錯了請重拍那一面。";
        this.options.playError();
        return;
      }
      this.selectedCell = this.selectedCell === index ? null : index;
      this.renderReview();
    });
    this.elements.reviewPalette.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-letter]");
      if (!button || this.selectedCell === null || !this.result) return;
      this.paint(this.selectedCell, button.dataset.letter as FaceMove);
    });
    this.elements.reviewThumbs.addEventListener("click", (event) => {
      const thumb = (event.target as HTMLElement).closest<HTMLElement>("[data-capture]");
      if (!thumb || this.usingTestPhotos) return;
      this.retakeSlot = Number(thumb.dataset.capture);
      this.showCapture();
      this.render();
      void this.startCamera().catch(() => this.close());
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stopLiveLoop();
      else if (this.stream && this.isOpen()) this.startLiveLoop();
    });
  }

  private async startCamera(): Promise<void> {
    if (this.stream) {
      this.startLiveLoop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera api");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    const track = this.stream.getVideoTracks()[0];
    const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
    this.elements.torch.classList.toggle("hidden", !capabilities.torch);
    this.startLiveLoop();
  }

  private stopCamera(): void {
    this.stopLiveLoop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.torchOn = false;
    this.video.pause();
    this.video.srcObject = null;
  }

  private async toggleTorch(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    this.torchOn = !this.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: this.torchOn } as MediaTrackConstraintSet] });
    } catch {
      this.torchOn = false;
    }
    this.elements.torch.classList.toggle("active", this.torchOn);
  }

  private startLiveLoop(): void {
    this.stopLiveLoop();
    this.liveTimer = window.setInterval(() => this.updateLive(), LIVE_INTERVAL_MS);
  }

  private stopLiveLoop(): void {
    window.clearInterval(this.liveTimer);
    this.liveTimer = 0;
  }

  // 即時取樣框內 9 格，在框上畫出辨識到的顏色，讓使用者拍之前就知道對得準不準。
  private updateLive(): void {
    if (this.video.readyState < 2 || this.capturing) return;
    let samples: RgbColor[];
    try {
      const region = videoRegionForElement(this.video, this.frame);
      samples = sampleThreeByThreeFromSource(this.video, this.video.videoWidth, this.video.videoHeight, this.liveCanvas, region, 96);
    } catch {
      return;
    }

    this.liveNames = samples.map(nameColor);
    this.frameCells.forEach((cell, index) => {
      const name = this.liveNames[index];
      cell.style.setProperty("--dot", name ? COLOR_SWATCHES[name] : "transparent");
      cell.classList.toggle("seen", name !== null);
    });

    const center = this.liveNames[4];
    const duplicate = this.findSameFace(samples[4]);
    const recognized = this.liveNames.filter((name) => name !== null).length;
    let message: string;
    if (!center || recognized < 7) {
      message = "把魔方的一面對準框線，9 格都要在框裡";
    } else if (duplicate !== null && duplicate !== this.retakeSlot) {
      message = `${COLOR_LABELS[center]}面已經拍過了，換下一面`;
    } else {
      message = `看到${COLOR_LABELS[center]}面${this.autoCapture ? "，保持不動…" : "，可以拍了"}`;
    }
    this.elements.live.textContent = message;
    this.elements.live.classList.toggle("ready", Boolean(center) && recognized >= 7 && (duplicate === null || duplicate === this.retakeSlot));

    const signature = this.liveNames.map((name) => name ?? "-").join(",");
    this.stableFrames = signature === this.lastSignature ? this.stableFrames + 1 : 0;
    this.lastSignature = signature;
    const progress = Math.min(1, this.stableFrames / STABLE_FRAMES_FOR_AUTO);
    this.elements.shutter.style.setProperty("--progress", this.autoCapture && center && recognized >= 8 ? String(progress) : "0");
    if (
      this.autoCapture &&
      center &&
      recognized >= 8 &&
      (duplicate === null || duplicate === this.retakeSlot) &&
      this.stableFrames >= STABLE_FRAMES_FOR_AUTO
    ) {
      this.stableFrames = 0;
      void this.captureCurrent();
    }
  }

  private findSameFace(centerSample: RgbColor): number | null {
    const lab = rgbToLab(centerSample);
    let best: { slot: number; distance: number } | null = null;
    this.captures.forEach((capture, slot) => {
      if (!capture) return;
      const distance = colorDistance(lab, rgbToLab(capture.samples[4]));
      if (distance < SAME_FACE_DISTANCE && (!best || distance < best.distance)) best = { slot, distance };
    });
    return (best as { slot: number } | null)?.slot ?? null;
  }

  private async captureCurrent(): Promise<void> {
    if (this.capturing || this.video.readyState < 2) return;
    this.capturing = true;
    try {
      const region = videoRegionForElement(this.video, this.frame);
      const samples = sampleThreeByThreeFromSource(this.video, this.video.videoWidth, this.video.videoHeight, this.workCanvas, region);
      const thumbnail = this.makeThumbnail();
      const sameFace = this.findSameFace(samples[4]);
      let slot: number;
      if (this.retakeSlot !== null) {
        slot = this.retakeSlot;
        this.retakeSlot = null;
      } else if (sameFace !== null) {
        slot = sameFace;
        this.toast("這一面已經拍過，換成新照片");
      } else {
        slot = this.captures.findIndex((capture) => capture === null);
      }
      if (slot < 0) slot = this.captures.length - 1;
      this.captures[slot] = { samples, thumbnail };
      this.options.playCapture();
      this.flash();

      if (this.captures.every((capture) => capture !== null)) {
        this.stopLiveLoop();
        this.reconstruct();
      } else {
        this.render();
      }
    } catch (error) {
      console.error(error);
      this.elements.live.textContent = "取樣失敗，請再拍一次";
      this.options.playError();
    } finally {
      this.capturing = false;
    }
  }

  private makeThumbnail(): string {
    const source = this.workCanvas;
    const thumb = document.createElement("canvas");
    thumb.width = 120;
    thumb.height = 120;
    thumb.getContext("2d")?.drawImage(source, 0, 0, 120, 120);
    return thumb.toDataURL("image/jpeg", 0.72);
  }

  private removeLastCapture(): void {
    for (let slot = this.captures.length - 1; slot >= 0; slot -= 1) {
      if (this.captures[slot]) {
        this.captures[slot] = null;
        break;
      }
    }
    this.render();
  }

  private reconstruct(): void {
    const samples = this.captures.map((capture) => capture?.samples ?? []);
    try {
      this.result = reconstructScan(samples);
      this.edits.clear();
      this.selectedCell = null;
      this.showReview();
      this.renderReview();
      if (this.result.quality === "good") this.options.playSoft();
      else this.options.playError();
    } catch (error) {
      console.error(error);
      this.showReview();
      this.elements.reviewStatus.textContent = error instanceof Error ? error.message : "無法辨識，請重新掃描";
      this.options.playError();
    }
  }

  private paint(index: number, letter: FaceMove): void {
    if (!this.result) return;
    this.edits.set(index, letter);
    const raw = this.result.raw.slice(0, index) + letter + this.result.raw.slice(index + 1);
    this.result = withManualEdits(this.result, raw);
    this.selectedCell = null;
    this.renderReview();
  }

  private autoFix(): void {
    if (!this.result) return;
    this.result = redecodeScan(this.result, this.edits);
    this.renderReview();
    if (this.result.valid) this.options.playSoft();
  }

  private async apply(): Promise<void> {
    if (!this.result?.valid) {
      this.options.playError();
      return;
    }
    const raw = this.result.raw;
    this.stopCamera();
    this.root.classList.add("hidden");
    await this.options.onApply(raw);
  }

  private showCapture(): void {
    this.elements.review.classList.add("hidden");
    this.root.classList.remove("reviewing");
  }

  private showReview(): void {
    this.elements.review.classList.remove("hidden");
    this.root.classList.add("reviewing");
  }

  private render(): void {
    const capturedCount = this.captures.filter(Boolean).length;
    const guide = this.nextGuide();
    this.elements.step.textContent = this.retakeSlot !== null ? "重拍" : `掃描 ${Math.min(capturedCount + 1, 6)}/6`;
    this.elements.title.textContent =
      this.retakeSlot !== null ? "重拍這一面" : guide ? `拍${COLOR_LABELS[guide.color]}面` : "拍還沒拍的那一面";
    this.elements.instruction.textContent =
      this.retakeSlot !== null
        ? "把要重拍的那一面對準框線。"
        : `${guide?.text ?? "把還沒拍過的一面對準框線"}。方向拍歪也沒關係。`;
    this.elements.back.toggleAttribute("disabled", capturedCount === 0 || this.retakeSlot !== null);
    this.elements.auto.setAttribute("aria-pressed", String(this.autoCapture));
    this.elements.auto.classList.toggle("active", this.autoCapture);

    this.elements.chips.innerHTML = this.captures
      .map((capture, slot) => {
        if (!capture) return `<span class="scanner-chip" aria-label="尚未拍攝 ${slot + 1}"></span>`;
        const name = nameColor(capture.samples[4]);
        return `<span class="scanner-chip done" style="--chip:${name ? COLOR_SWATCHES[name] : "#ccc"}" aria-label="已拍${name ? COLOR_LABELS[name] : ""}面">${icon("check")}</span>`;
      })
      .join("");
  }

  // 依建議順序找第一個還沒拍到的顏色（用中心色名稱粗判，只用來給提示）。
  private nextGuide(): { color: ColorName; text: string } | null {
    const captured = new Set(
      this.captures.filter((capture): capture is Capture => capture !== null).map((capture) => nameColor(capture.samples[4]))
    );
    return CAPTURE_GUIDE.find((entry) => !captured.has(entry.color)) ?? null;
  }

  private renderReview(): void {
    const result = this.result;
    if (!result) return;
    const displayColor = (letter: FaceMove): string => COLOR_SWATCHES[result.faceColors[letter]];
    const corrected = new Set(result.corrected);
    const qualityLabel = !result.valid ? "需要修正" : result.quality === "good" ? "辨識成功" : "請確認";
    this.elements.reviewStatus.innerHTML = `<b class="quality-${result.valid ? result.quality : "poor"}">${qualityLabel}</b> ${escapeHtml(result.reason)}`;

    const faceOfCapture = new Map<number, FaceMove>();
    FACE_MOVES.forEach((face) => faceOfCapture.set(result.placement[face].capture, face));
    this.elements.reviewThumbs.innerHTML = this.captures
      .map((capture, slot) => {
        if (!capture) return "";
        const face = faceOfCapture.get(slot);
        const name = face ? COLOR_LABELS[result.faceColors[face]] : "";
        return `<button type="button" class="review-thumb" data-capture="${slot}" ${this.usingTestPhotos ? "disabled" : ""}>
          <img src="${capture.thumbnail}" alt="${name}面照片" />
          <span>${name}</span>
        </button>`;
      })
      .join("");

    this.elements.reviewNet.innerHTML = NET_LAYOUT.map((face) => {
      if (!face) return `<div class="net-gap"></div>`;
      const offset = FACE_MOVES.indexOf(face) * 9;
      const cells = Array.from({ length: 9 }, (_, position) => {
        const index = offset + position;
        const letter = result.raw[index] as FaceMove;
        const classes = [
          corrected.has(index) ? "corrected" : "",
          this.edits.has(index) ? "edited" : "",
          !corrected.has(index) && result.confidence[index] < 0.12 && position !== 4 ? "unsure" : "",
          this.selectedCell === index ? "selected" : "",
          position === 4 ? "center" : "",
        ].join(" ");
        return `<button type="button" class="net-cell ${classes}" data-index="${index}" style="background:${displayColor(letter)}" aria-label="${COLOR_LABELS[result.faceColors[letter]]}"></button>`;
      }).join("");
      return `<div class="net-face" data-face="${face}">${cells}</div>`;
    }).join("");

    this.elements.reviewPalette.innerHTML = FACE_MOVES.map(
      (letter) =>
        `<button type="button" data-letter="${letter}" style="background:${displayColor(letter)}" aria-label="${COLOR_LABELS[result.faceColors[letter]]}" ${this.selectedCell === null ? "disabled" : ""}></button>`
    ).join("");
    this.elements.reviewPalette.classList.toggle("active", this.selectedCell !== null);
    this.elements.reviewFix.classList.toggle("hidden", result.valid || this.edits.size === 0);
    this.elements.reviewApply.toggleAttribute("disabled", !result.valid);
    this.elements.reviewRestart.innerHTML = this.usingTestPhotos
      ? `${icon("close")}<span>關閉</span>`
      : `${icon("retake")}<span>重新掃描</span>`;
  }

  private flash(): void {
    this.root.classList.remove("flash");
    void this.root.offsetWidth;
    this.root.classList.add("flash");
  }

  private toast(message: string): void {
    this.elements.live.textContent = message;
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing scanner element: ${selector}`);
    return element;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`無法載入示範照片：${src}`));
    image.src = src;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
