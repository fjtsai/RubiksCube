import { FACELET_FACE_ORDER, buildScanResult, type ScanFace } from "./scanner-state";
import { countFacelets, validateThreeByThreeFacelets } from "./three-by-three-validation";
import type { ClassifiedScanResult, ClassifiedSticker } from "./color-classifier";

export interface ScanReconstructionResult {
  result: ClassifiedScanResult;
  valid: boolean;
  reason: string;
  attempts: number;
  rotations?: Record<ScanFace, number>;
  capturedFaceForCanonical?: Record<ScanFace, ScanFace>;
}

const ROTATIONS = [0, 1, 2, 3] as const;

export function inferScanFaceOrderAndRotations(classified: ClassifiedScanResult): ScanReconstructionResult {
  const counts = countFacelets(classified.raw);
  const badCount = FACELET_FACE_ORDER.find((face) => counts[face] !== 9);
  if (badCount) {
    return {
      result: classified,
      valid: false,
      reason: `顏色數量不平衡：${badCount}=${counts[badCount]}。請先點格子修正顏色。`,
      attempts: 0,
    };
  }

  const currentOrder = [...FACELET_FACE_ORDER];
  const currentOrderResult = findValidReconstruction(classified, [currentOrder], 0);
  if (currentOrderResult.valid) return currentOrderResult;

  const remainingOrders = permutations(FACELET_FACE_ORDER).filter((order) => !sameOrder(order, currentOrder));
  return findValidReconstruction(classified, remainingOrders, currentOrderResult.attempts);
}

function findValidReconstruction(
  classified: ClassifiedScanResult,
  capturedOrders: ScanFace[][],
  startingAttempts: number
): ScanReconstructionResult {
  const rotated = FACELET_FACE_ORDER.reduce(
    (result, face) => {
      result[face] = ROTATIONS.map((rotation) => rotateStickers(classified.stickers[face], rotation));
      return result;
    },
    {} as Record<ScanFace, ClassifiedSticker[][]>
  );
  let attempts = startingAttempts;
  let fallback: ClassifiedScanResult | null = null;
  let fallbackReason = "無法從六面照片推斷出合法魔方狀態，請檢查是否有面拍錯、漏拍或顏色誤判。";

  for (const capturedOrder of capturedOrders) {
    const colorAssignment = FACELET_FACE_ORDER.reduce(
      (assignment, canonicalFace, index) => {
        assignment[capturedOrder[index]] = canonicalFace;
        return assignment;
      },
      {} as Record<ScanFace, ScanFace>
    );

    for (const u of ROTATIONS) {
      for (const r of ROTATIONS) {
        for (const f of ROTATIONS) {
          for (const d of ROTATIONS) {
            for (const l of ROTATIONS) {
              for (const b of ROTATIONS) {
                attempts += 1;
                const rotations: Record<ScanFace, number> = { U: u, R: r, F: f, D: d, L: l, B: b };
                const candidate = buildCandidate(rotated, capturedOrder, colorAssignment, rotations);
                const validation = validateThreeByThreeFacelets(candidate.raw);

                if (validation.valid) {
                  return {
                    result: candidate,
                    valid: true,
                    reason: "OK",
                    attempts,
                    rotations,
                    capturedFaceForCanonical: FACELET_FACE_ORDER.reduce(
                      (result, canonicalFace, index) => {
                        result[canonicalFace] = capturedOrder[index];
                        return result;
                      },
                      {} as Record<ScanFace, ScanFace>
                    ),
                  };
                }

                if (!fallback) {
                  fallback = candidate;
                  fallbackReason = validation.reason;
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    result: fallback ?? classified,
    valid: false,
    reason: fallbackReason,
    attempts,
  };
}

function buildCandidate(
  rotated: Record<ScanFace, ClassifiedSticker[][]>,
  capturedOrder: ScanFace[],
  colorAssignment: Record<ScanFace, ScanFace>,
  rotations: Record<ScanFace, number>
): ClassifiedScanResult {
  const stickers = {} as Record<ScanFace, ClassifiedSticker[]>;

  for (const canonicalFace of FACELET_FACE_ORDER) {
    const capturedFace = capturedOrder[FACELET_FACE_ORDER.indexOf(canonicalFace)];
    stickers[canonicalFace] = rotated[capturedFace][rotations[canonicalFace]].map((sticker) => ({
      ...sticker,
      face: colorAssignment[sticker.face],
    }));
  }

  const scanResult = buildScanResult(
    FACELET_FACE_ORDER.reduce(
      (faces, face) => {
        faces[face] = stickers[face].map((sticker) => sticker.face);
        return faces;
      },
      {} as Record<ScanFace, ScanFace[]>
    )
  );

  return {
    ...scanResult,
    stickers,
  };
}

function rotateStickers(stickers: readonly ClassifiedSticker[], rotation: number): ClassifiedSticker[] {
  let result = [...stickers];
  for (let count = 0; count < rotation; count += 1) {
    result = [result[6], result[3], result[0], result[7], result[4], result[1], result[8], result[5], result[2]];
  }
  return result;
}

function permutations(items: readonly ScanFace[]): ScanFace[][] {
  if (items.length === 0) return [[]];

  return items.flatMap((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    return permutations(rest).map((next) => [item, ...next]);
  });
}

function sameOrder(a: readonly ScanFace[], b: readonly ScanFace[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
