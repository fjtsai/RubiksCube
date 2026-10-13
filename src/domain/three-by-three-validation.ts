import { FACE_MOVES, type FaceMove } from "./moves";
import { THREE_BY_THREE_FACELET_COUNT, THREE_BY_THREE_FACE_SIZE } from "./scanner-state";

export type ThreeByThreeValidation =
  | { valid: true; reason: "OK" }
  | { valid: false; reason: string; counts?: Partial<Record<FaceMove, number>> };

type InvalidValidation = { valid: false; reason: string; counts?: Partial<Record<FaceMove, number>> };

const CENTER_FACELETS = [4, 13, 22, 31, 40, 49] as const;
export const CORNER_FACELETS = [
  [8, 9, 20],
  [6, 18, 38],
  [0, 36, 47],
  [2, 45, 11],
  [29, 26, 15],
  [27, 44, 24],
  [33, 53, 42],
  [35, 17, 51],
] as const;
export const EDGE_FACELETS = [
  [5, 10],
  [7, 19],
  [3, 37],
  [1, 46],
  [32, 16],
  [28, 25],
  [30, 43],
  [34, 52],
  [23, 12],
  [21, 41],
  [50, 39],
  [48, 14],
] as const;

export const CORNER_COLORS = [
  ["U", "R", "F"],
  ["U", "F", "L"],
  ["U", "L", "B"],
  ["U", "B", "R"],
  ["D", "F", "R"],
  ["D", "L", "F"],
  ["D", "B", "L"],
  ["D", "R", "B"],
] as const;
export const EDGE_COLORS = [
  ["U", "R"],
  ["U", "F"],
  ["U", "L"],
  ["U", "B"],
  ["D", "R"],
  ["D", "F"],
  ["D", "L"],
  ["D", "B"],
  ["F", "R"],
  ["F", "L"],
  ["B", "L"],
  ["B", "R"],
] as const;

export function validateThreeByThreeFacelets(raw: string): ThreeByThreeValidation {
  if (raw.length !== THREE_BY_THREE_FACELET_COUNT) {
    return invalid(`3x3 狀態長度錯誤：${raw.length}/${THREE_BY_THREE_FACELET_COUNT}`);
  }

  const counts = countFacelets(raw);
  const unknown = [...raw].find((sticker) => !FACE_MOVES.includes(sticker as FaceMove));
  if (unknown) return invalid(`3x3 狀態包含未知顏色：${unknown}`, counts);

  for (const face of FACE_MOVES) {
    if (counts[face] !== THREE_BY_THREE_FACE_SIZE) {
      return invalid(`3x3 顏色數量不正確：${face}=${counts[face] ?? 0}，應為 9`, counts);
    }
  }

  for (let index = 0; index < FACE_MOVES.length; index += 1) {
    if (raw[CENTER_FACELETS[index]] !== FACE_MOVES[index]) {
      return invalid(`3x3 中心方向不正確：${FACE_MOVES[index]} 面中心不是 ${FACE_MOVES[index]}`, counts);
    }
  }

  const cornerResult = parseCorners(raw);
  if (!cornerResult.valid) return cornerResult;

  const edgeResult = parseEdges(raw);
  if (!edgeResult.valid) return edgeResult;

  if (cornerResult.orientationSum % 3 !== 0) return invalid("3x3 角塊方向不合法", counts);
  if (edgeResult.orientationSum % 2 !== 0) return invalid("3x3 邊塊方向不合法", counts);
  if (permutationParity(cornerResult.permutation) !== permutationParity(edgeResult.permutation)) {
    return invalid("3x3 角塊與邊塊 parity 不一致", counts);
  }

  return { valid: true, reason: "OK" };
}

export function countFacelets(raw: string): Record<FaceMove, number> {
  const counts = FACE_MOVES.reduce(
    (result, face) => {
      result[face] = 0;
      return result;
    },
    {} as Record<FaceMove, number>
  );

  for (const sticker of raw) {
    if (FACE_MOVES.includes(sticker as FaceMove)) {
      counts[sticker as FaceMove] += 1;
    }
  }

  return counts;
}

function parseCorners(raw: string): { valid: true; permutation: number[]; orientationSum: number } | InvalidValidation {
  const permutation: number[] = [];
  const seen = new Set<number>();
  let orientationSum = 0;

  for (const facelets of CORNER_FACELETS) {
    const stickers = facelets.map((index) => raw[index]);
    const orientation = stickers.findIndex((sticker) => sticker === "U" || sticker === "D");
    if (orientation < 0) return invalid("3x3 角塊缺少 U/D 顏色");

    const col1 = raw[facelets[(orientation + 1) % 3]];
    const col2 = raw[facelets[(orientation + 2) % 3]];
    const pieceIndex = CORNER_COLORS.findIndex((colors) => colors[1] === col1 && colors[2] === col2);
    if (pieceIndex < 0) return invalid("3x3 角塊組合不合法");
    if (seen.has(pieceIndex)) return invalid("3x3 角塊重複");

    seen.add(pieceIndex);
    permutation.push(pieceIndex);
    orientationSum += orientation % 3;
  }

  return { valid: true, permutation, orientationSum };
}

function parseEdges(raw: string): { valid: true; permutation: number[]; orientationSum: number } | InvalidValidation {
  const permutation: number[] = [];
  const seen = new Set<number>();
  let orientationSum = 0;

  for (const [aIndex, bIndex] of EDGE_FACELETS) {
    const a = raw[aIndex];
    const b = raw[bIndex];
    let pieceIndex = EDGE_COLORS.findIndex((colors) => colors[0] === a && colors[1] === b);
    let orientation = 0;

    if (pieceIndex < 0) {
      pieceIndex = EDGE_COLORS.findIndex((colors) => colors[0] === b && colors[1] === a);
      orientation = 1;
    }

    if (pieceIndex < 0) return invalid("3x3 邊塊組合不合法");
    if (seen.has(pieceIndex)) return invalid("3x3 邊塊重複");

    seen.add(pieceIndex);
    permutation.push(pieceIndex);
    orientationSum += orientation;
  }

  return { valid: true, permutation, orientationSum };
}

function permutationParity(permutation: readonly number[]): number {
  let inversions = 0;
  for (let i = 0; i < permutation.length; i += 1) {
    for (let j = i + 1; j < permutation.length; j += 1) {
      if (permutation[i] > permutation[j]) inversions += 1;
    }
  }
  return inversions % 2;
}

function invalid(reason: string, counts?: Partial<Record<FaceMove, number>>): InvalidValidation {
  return { valid: false, reason, counts };
}
