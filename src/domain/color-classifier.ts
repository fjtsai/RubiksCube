import type { RgbColor } from "./color-sampling";
import type { FaceMove } from "./moves";

export type ColorName = "white" | "red" | "green" | "yellow" | "orange" | "blue";

export const COLOR_NAMES: readonly ColorName[] = ["white", "red", "green", "yellow", "orange", "blue"];

// 標準配色（白上、紅右、綠前、黃下、橘左、藍後），與 3D 場景的貼紙顏色一致。
export const STANDARD_FACE_COLOR: Record<FaceMove, ColorName> = {
  U: "white",
  R: "red",
  F: "green",
  D: "yellow",
  L: "orange",
  B: "blue",
};

export const COLOR_LABELS: Record<ColorName, string> = {
  white: "白色",
  red: "紅色",
  green: "綠色",
  yellow: "黃色",
  orange: "橘色",
  blue: "藍色",
};

export const COLOR_SWATCHES: Record<ColorName, string> = {
  white: "#ffffff",
  red: "#ff4f4f",
  green: "#36c56f",
  yellow: "#ffd84d",
  orange: "#ff9a3c",
  blue: "#4e8dff",
};

export interface LabColor {
  l: number;
  a: number;
  b: number;
}

type LinearRgb = [number, number, number];

// 一般日光／室內光下拍到的魔方貼紙大致色彩（CIE Lab）。只用來替六個中心「取名字」，
// 實際分類永遠以這次拍到的中心色為基準。
const REFERENCE_LAB: Record<ColorName, LabColor> = {
  white: { l: 92, a: 0, b: 3 },
  red: { l: 47, a: 62, b: 40 },
  green: { l: 62, a: -55, b: 33 },
  yellow: { l: 86, a: -4, b: 78 },
  orange: { l: 64, a: 43, b: 66 },
  blue: { l: 45, a: 10, b: -55 },
};

// 每張照片的自動曝光、白平衡都不同；亮度差異比色相差異不可靠，所以降低 L 的權重。
const LIGHTNESS_WEIGHT = 0.6;
const REFINEMENT_ROUNDS = 4;
const DUPLICATE_CENTER_DISTANCE = 13;

export interface ColorModel {
  // costs[capture][sticker][slot]：第 capture 張照片的第 sticker 格，與第 slot 張照片中心色（修正後）的距離。
  costs: number[][][];
  // 距離最近的 slot（最直接的辨識結果）。
  labels: number[][];
  // 每張照片中心的顏色名稱（六個名稱彼此不重複）。
  slotColors: ColorName[];
  // 每個 slot 修正後的代表色，給預覽與除錯用。
  prototypes: LabColor[];
  centerConflict: string | null;
}

// 把六張照片（任意順序、任意旋轉）的 54 格顏色分群。
// 1. 以每張照片的中心當起點，反覆用「分到同一群的所有貼紙」的中位數修正代表色，洗掉 logo 與反光。
// 2. 每張照片估一組 RGB 增益（線性空間），抵銷各自的曝光與白平衡差異。
// 3. 用最亮、最不飽和的一群當白色做整體白平衡，再把六群一對一命名成白紅綠黃橘藍。
export function buildColorModel(captures: readonly (readonly RgbColor[])[]): ColorModel {
  if (captures.length !== 6 || captures.some((capture) => capture.length !== 9)) {
    throw new Error("需要 6 面、每面 9 格的取樣");
  }

  const linear = captures.map((capture) => capture.map(rgbToLinear));
  const gains: LinearRgb[] = captures.map(() => [1, 1, 1]);
  let corrected = linear.map((capture, index) => capture.map((pixel) => applyGain(pixel, gains[index])));
  let prototypes: LinearRgb[] = corrected.map((capture) => capture[4]);
  let labels = assignNearest(corrected, prototypes);

  for (let round = 0; round < REFINEMENT_ROUNDS; round += 1) {
    prototypes = prototypes.map((_, slot) => medianLinear(collectAssigned(corrected, labels, slot)));
    for (let capture = 0; capture < captures.length; capture += 1) {
      gains[capture] = estimateGain(linear[capture], labels[capture], prototypes, gains[capture]);
    }
    normalizeGains(gains);
    corrected = linear.map((capture, index) => capture.map((pixel) => applyGain(pixel, gains[index])));
    labels = assignNearest(corrected, prototypes);
  }
  prototypes = prototypes.map((_, slot) => medianLinear(collectAssigned(corrected, labels, slot)));

  const balance = whiteBalanceFromPrototypes(prototypes);
  const prototypeLabs = prototypes.map((prototype) => linearToLab(applyGain(prototype, balance)));
  const stickerLabs = corrected.map((capture) => capture.map((pixel) => linearToLab(applyGain(pixel, balance))));
  const costs = stickerLabs.map((capture) =>
    capture.map((lab) => prototypeLabs.map((prototype) => colorDistance(lab, prototype)))
  );

  return {
    costs,
    labels: costs.map((capture, captureIndex) =>
      capture.map((distances, index) => (index === 4 ? captureIndex : argMin(distances)))
    ),
    slotColors: nameSlots(prototypeLabs),
    prototypes: prototypeLabs,
    centerConflict: findCenterConflict(prototypeLabs),
  };
}

// 即時預覽用的單格顏色判斷（只看這一格，不需要其他面的資訊）。
export function nameColor(rgb: RgbColor): ColorName | null {
  const lab = rgbToLab(rgb);
  const chroma = Math.hypot(lab.a, lab.b);
  if (chroma < 22) return lab.l > 45 ? "white" : null;
  if (lab.l < 18) return null;
  const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  if (hue < 41 || hue >= 330) return "red";
  if (hue < 73) return "orange";
  if (hue < 120) return lab.l > 55 ? "yellow" : "green";
  if (hue < 215) return "green";
  return "blue";
}

export function rgbToLab(rgb: RgbColor): LabColor {
  return linearToLab(rgbToLinear(rgb));
}

export function colorDistance(a: LabColor, b: LabColor): number {
  return Math.hypot((a.l - b.l) * LIGHTNESS_WEIGHT, a.a - b.a, a.b - b.b);
}

function assignNearest(corrected: LinearRgb[][], prototypes: LinearRgb[]): number[][] {
  const prototypeLabs = prototypes.map(linearToLab);
  return corrected.map((capture, captureIndex) =>
    capture.map((pixel, index) => {
      if (index === 4) return captureIndex;
      const lab = linearToLab(pixel);
      return argMin(prototypeLabs.map((prototype) => colorDistance(lab, prototype)));
    })
  );
}

function collectAssigned(corrected: LinearRgb[][], labels: number[][], slot: number): LinearRgb[] {
  const result: LinearRgb[] = [];
  corrected.forEach((capture, captureIndex) =>
    capture.forEach((pixel, index) => {
      if (labels[captureIndex][index] === slot) result.push(pixel);
    })
  );
  return result.length > 0 ? result : [corrected[slot][4]];
}

// 同一張照片裡的 9 格若都偏暗、偏黃，代表是相機曝光／白平衡造成，
// 用「代表色 ÷ 這格的顏色」的中位數當這張照片的 RGB 增益。
function estimateGain(capture: LinearRgb[], labels: number[], prototypes: LinearRgb[], previous: LinearRgb): LinearRgb {
  const next: LinearRgb = [1, 1, 1];
  for (let channel = 0; channel < 3; channel += 1) {
    const ratios: number[] = [];
    capture.forEach((pixel, index) => {
      const target = prototypes[labels[index]][channel];
      if (pixel[channel] < 0.025 || target < 0.025) return;
      ratios.push(target / pixel[channel]);
    });
    const ratio = ratios.length >= 3 ? medianOf(ratios) : previous[channel];
    next[channel] = Math.min(2.5, Math.max(0.4, ratio));
  }
  return next;
}

function normalizeGains(gains: LinearRgb[]): void {
  for (let channel = 0; channel < 3; channel += 1) {
    const logMean = gains.reduce((sum, gain) => sum + Math.log(gain[channel]), 0) / gains.length;
    const scale = Math.exp(-logMean);
    gains.forEach((gain) => {
      gain[channel] *= scale;
    });
  }
}

// 取最亮、最不飽和的一群當白色，算出讓它變成中性灰的整體增益。
function whiteBalanceFromPrototypes(prototypes: LinearRgb[]): LinearRgb {
  const scored = prototypes.map((prototype) => {
    const lab = linearToLab(prototype);
    return { prototype, score: Math.hypot(lab.a, lab.b) - lab.l * 0.35 };
  });
  const white = scored.reduce((best, item) => (item.score < best.score ? item : best)).prototype;
  const mean = (white[0] + white[1] + white[2]) / 3;
  if (mean <= 0.02) return [1, 1, 1];
  return white.map((channel) => Math.min(1.6, Math.max(0.6, mean / Math.max(channel, 1e-3)))) as LinearRgb;
}

function nameSlots(prototypes: LabColor[]): ColorName[] {
  let best: { names: ColorName[]; cost: number } | null = null;
  for (const order of permutations(COLOR_NAMES)) {
    const cost = order.reduce((sum, name, slot) => sum + colorDistance(prototypes[slot], REFERENCE_LAB[name]), 0);
    if (!best || cost < best.cost) best = { names: order, cost };
  }
  return best?.names ?? [...COLOR_NAMES];
}

function findCenterConflict(prototypes: LabColor[]): string | null {
  for (let a = 0; a < prototypes.length; a += 1) {
    for (let b = a + 1; b < prototypes.length; b += 1) {
      if (colorDistance(prototypes[a], prototypes[b]) < DUPLICATE_CENTER_DISTANCE) {
        return `第 ${a + 1} 張與第 ${b + 1} 張照片的中心顏色幾乎一樣，可能同一面拍了兩次。`;
      }
    }
  }
  return null;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}

function argMin(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < values[best]) best = index;
  }
  return best;
}

function medianLinear(pixels: readonly LinearRgb[]): LinearRgb {
  return [0, 1, 2].map((channel) => medianOf(pixels.map((pixel) => pixel[channel]))) as LinearRgb;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function applyGain(pixel: LinearRgb, gain: LinearRgb): LinearRgb {
  return [pixel[0] * gain[0], pixel[1] * gain[1], pixel[2] * gain[2]];
}

function rgbToLinear(rgb: RgbColor): LinearRgb {
  return [pivotRgb(rgb.r / 255), pivotRgb(rgb.g / 255), pivotRgb(rgb.b / 255)];
}

function linearToLab([r, g, b]: LinearRgb): LabColor {
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const fx = pivotXyz(x);
  const fy = pivotXyz(y);
  const fz = pivotXyz(z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function pivotRgb(value: number): number {
  return value > 0.04045 ? Math.pow((value + 0.055) / 1.055, 2.4) : value / 12.92;
}

function pivotXyz(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}
