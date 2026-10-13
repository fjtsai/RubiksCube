import { FACELET_FACE_ORDER, buildScanResult, type ScanFace, type ScanResult } from "./scanner-state";
import type { RgbColor } from "./color-sampling";

export interface ClassifiedSticker {
  face: ScanFace;
  rgb: RgbColor;
  confidence: number;
}

export interface ClassifiedScanResult extends ScanResult {
  stickers: Record<ScanFace, ClassifiedSticker[]>;
}

export type CapturedFaceSamples = Record<ScanFace, readonly RgbColor[]>;

interface LabColor {
  l: number;
  a: number;
  b: number;
}

interface StickerAssignment {
  face: ScanFace;
  confidence: number;
}

interface PendingSticker {
  capturedFace: ScanFace;
  index: number;
  distances: Array<{ face: ScanFace; distance: number }>;
}

const PROTOTYPE_REFINEMENT_ROUNDS = 2;

export function classifyCapturedFaces(samples: CapturedFaceSamples): ClassifiedScanResult {
  const labs = FACELET_FACE_ORDER.reduce(
    (result, face) => {
      const faceSamples = samples[face];
      if (!faceSamples || faceSamples.length !== 9) {
        throw new Error(`缺少 ${face} 面的 9 格取樣`);
      }
      result[face] = faceSamples.map(rgbToLab);
      return result;
    },
    {} as Record<ScanFace, LabColor[]>
  );

  const prototypes = refinePrototypes(labs);
  const assignments = assignBalanced(labs, prototypes);

  const stickers = FACELET_FACE_ORDER.reduce(
    (result, face) => {
      result[face] = samples[face].map((rgb, index) => ({
        face: assignments[face][index].face,
        rgb,
        confidence: assignments[face][index].confidence,
      }));
      return result;
    },
    {} as Record<ScanFace, ClassifiedSticker[]>
  );

  const scanResult = buildScanResult(
    FACELET_FACE_ORDER.reduce(
      (result, face) => {
        result[face] = stickers[face].map((sticker) => sticker.face);
        return result;
      },
      {} as Record<ScanFace, ScanFace[]>
    )
  );

  return {
    ...scanResult,
    stickers,
  };
}

// 中心格是各顏色類別唯一可靠的錨點，但它常被品牌 logo 污染。
// 先以中心格起始，再反覆用「目前分到這一類的所有貼紙」的中位數修正基準色，
// 洗掉 logo 殘留的色偏。
function refinePrototypes(labs: Record<ScanFace, LabColor[]>): Record<ScanFace, LabColor> {
  let prototypes = FACELET_FACE_ORDER.reduce(
    (result, face) => {
      result[face] = labs[face][4];
      return result;
    },
    {} as Record<ScanFace, LabColor>
  );

  for (let round = 0; round < PROTOTYPE_REFINEMENT_ROUNDS; round += 1) {
    const groups = FACELET_FACE_ORDER.reduce(
      (result, face) => {
        result[face] = [labs[face][4]];
        return result;
      },
      {} as Record<ScanFace, LabColor[]>
    );

    for (const face of FACELET_FACE_ORDER) {
      labs[face].forEach((lab, index) => {
        if (index === 4) return;
        groups[nearestFace(lab, prototypes)].push(lab);
      });
    }

    prototypes = FACELET_FACE_ORDER.reduce(
      (result, face) => {
        result[face] = medianLab(groups[face]);
        return result;
      },
      {} as Record<ScanFace, LabColor>
    );
  }

  return prototypes;
}

// 合法的魔方每種顏色恰好 9 格。把握最高的貼紙先分配，
// 某色額滿後其餘貼紙退到次近的顏色，避免單格誤判擴散成整體數量不平衡。
function assignBalanced(
  labs: Record<ScanFace, LabColor[]>,
  prototypes: Record<ScanFace, LabColor>
): Record<ScanFace, StickerAssignment[]> {
  const results = FACELET_FACE_ORDER.reduce(
    (result, face) => {
      result[face] = new Array<StickerAssignment>(9);
      result[face][4] = { face, confidence: 1 };
      return result;
    },
    {} as Record<ScanFace, StickerAssignment[]>
  );
  const capacity = FACELET_FACE_ORDER.reduce(
    (result, face) => {
      result[face] = 8;
      return result;
    },
    {} as Record<ScanFace, number>
  );

  const pending: PendingSticker[] = [];
  for (const face of FACELET_FACE_ORDER) {
    labs[face].forEach((lab, index) => {
      if (index === 4) return;
      const distances = FACELET_FACE_ORDER.map((candidate) => ({
        face: candidate,
        distance: labDistance(lab, prototypes[candidate]),
      })).sort((a, b) => a.distance - b.distance);
      pending.push({ capturedFace: face, index, distances });
    });
  }

  pending.sort((a, b) => assignmentMargin(b) - assignmentMargin(a));

  for (const sticker of pending) {
    const chosen = sticker.distances.find((candidate) => capacity[candidate.face] > 0) ?? sticker.distances[0];
    capacity[chosen.face] -= 1;
    const bestOther = sticker.distances.find((candidate) => candidate.face !== chosen.face);
    const confidence = bestOther
      ? Math.max(0, Math.min(1, (bestOther.distance - chosen.distance) / Math.max(bestOther.distance, 1)))
      : 1;
    results[sticker.capturedFace][sticker.index] = { face: chosen.face, confidence };
  }

  return results;
}

function assignmentMargin(sticker: PendingSticker): number {
  return (sticker.distances[1]?.distance ?? 0) - sticker.distances[0].distance;
}

function nearestFace(lab: LabColor, prototypes: Record<ScanFace, LabColor>): ScanFace {
  let best: ScanFace = FACELET_FACE_ORDER[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const face of FACELET_FACE_ORDER) {
    const distance = labDistance(lab, prototypes[face]);
    if (distance < bestDistance) {
      best = face;
      bestDistance = distance;
    }
  }
  return best;
}

function medianLab(colors: readonly LabColor[]): LabColor {
  return {
    l: medianOf(colors.map((color) => color.l)),
    a: medianOf(colors.map((color) => color.a)),
    b: medianOf(colors.map((color) => color.b)),
  };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function rgbToLab(rgb: RgbColor): LabColor {
  const r = pivotRgb(rgb.r / 255);
  const g = pivotRgb(rgb.g / 255);
  const b = pivotRgb(rgb.b / 255);

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

function labDistance(a: LabColor, b: LabColor): number {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}
