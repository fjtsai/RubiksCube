import { FACE_MOVES, type FaceMove } from "./moves";

export interface FaceletTarget {
  face: FaceMove;
  index: number;
}

export interface FiveByFiveCenterAnalysis {
  centerMatches: number;
  completedCenters: number;
  nextFace: FaceMove;
  nextFaceName: string;
  nextTargets: FaceletTarget[];
}

export interface FiveByFiveEdgeAnalysis {
  pairedEdges: number;
  nextEdgeName: string;
  nextFaces: FaceMove[];
  nextTargets: FaceletTarget[];
}

export type ThreeByThreeValidation = { valid: true; reason: string } | { valid: false; reason: string };
type InvalidValidation = { valid: false; reason: string };

interface FiveByFiveEdgeDefinition {
  name: string;
  faces: [FaceMove, FaceMove];
  a: FaceletTarget[];
  b: FaceletTarget[];
}

const FACE_NAMES: Record<FaceMove, string> = {
  U: "白色",
  R: "紅色",
  F: "綠色",
  D: "黃色",
  L: "橘色",
  B: "藍色",
};

const FACE_OFFSET_5: Record<FaceMove, number> = {
  U: 0,
  R: 25,
  F: 50,
  D: 75,
  L: 100,
  B: 125,
};

const PROJECTED_5_TO_3_POSITIONS = [0, 2, 4, 10, 12, 14, 20, 22, 24] as const;
const CENTER_5_POSITIONS = [6, 7, 8, 11, 12, 13, 16, 17, 18] as const;

const CENTER_3_FACELETS = [4, 13, 22, 31, 40, 49] as const;
const CORNER_FACELETS = [
  [8, 9, 20],
  [6, 18, 38],
  [0, 36, 47],
  [2, 45, 11],
  [29, 26, 15],
  [27, 44, 24],
  [33, 53, 42],
  [35, 17, 51],
] as const;
const EDGE_FACELETS = [
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

const CORNER_COLORS = [
  ["U", "R", "F"],
  ["U", "F", "L"],
  ["U", "L", "B"],
  ["U", "B", "R"],
  ["D", "F", "R"],
  ["D", "L", "F"],
  ["D", "B", "L"],
  ["D", "R", "B"],
] as const;
const EDGE_COLORS = [
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

export function projectFiveByFiveToThreeByThree(raw5: string): string {
  if (raw5.length !== 150) {
    throw new Error(`Expected 150 facelets for 5x5 projection, got ${raw5.length}`);
  }

  return FACE_MOVES.flatMap((face) => {
    const offset = FACE_OFFSET_5[face];
    return PROJECTED_5_TO_3_POSITIONS.map((position) => raw5[offset + position]);
  }).join("");
}

export function validateProjectedThreeByThree(raw3: string): ThreeByThreeValidation {
  if (raw3.length !== 54) {
    return invalid(`3x3 投影長度錯誤：${raw3.length}/54`);
  }

  const counts = new Map<FaceMove, number>(FACE_MOVES.map((face) => [face, 0]));
  for (const sticker of raw3) {
    if (!FACE_MOVES.includes(sticker as FaceMove)) return invalid("3x3 投影包含未知顏色");
    counts.set(sticker as FaceMove, (counts.get(sticker as FaceMove) ?? 0) + 1);
  }

  for (const face of FACE_MOVES) {
    if (counts.get(face) !== 9) return invalid(`3x3 投影顏色數量不正確：${face}=${counts.get(face) ?? 0}`);
  }

  for (let index = 0; index < FACE_MOVES.length; index += 1) {
    if (raw3[CENTER_3_FACELETS[index]] !== FACE_MOVES[index]) {
      return invalid("3x3 投影中心方向不正確");
    }
  }

  const cornerResult = parseCorners(raw3);
  if (!cornerResult.valid) return cornerResult;

  const edgeResult = parseEdges(raw3);
  if (!edgeResult.valid) return edgeResult;

  if (cornerResult.orientationSum % 3 !== 0) return invalid("3x3 投影角塊方向不合法");
  if (edgeResult.orientationSum % 2 !== 0) return invalid("3x3 投影邊塊方向不合法，可能是 5x5 edge parity");
  if (permutationParity(cornerResult.permutation) !== permutationParity(edgeResult.permutation)) {
    return invalid("3x3 投影角塊與邊塊 parity 不一致");
  }

  return { valid: true, reason: "OK" };
}

export function analyzeFiveByFiveCenters(raw5: string): FiveByFiveCenterAnalysis {
  let centerMatches = 0;
  let completedCenters = 0;
  let nextFace: FaceMove = "U";

  for (const face of FACE_MOVES) {
    const offset = FACE_OFFSET_5[face];
    const matches = CENTER_5_POSITIONS.filter((position) => raw5[offset + position] === face).length;
    centerMatches += matches;
    if (matches === CENTER_5_POSITIONS.length) {
      completedCenters += 1;
    } else if (nextFace === "U" && face !== "U") {
      nextFace = face;
    }
  }

  if (CENTER_5_POSITIONS.some((position) => raw5[position] !== "U")) {
    nextFace = "U";
  }

  return {
    centerMatches,
    completedCenters,
    nextFace,
    nextFaceName: FACE_NAMES[nextFace],
    nextTargets: CENTER_5_POSITIONS.map((index) => ({ face: nextFace, index })),
  };
}

export function analyzeFiveByFiveEdges(raw5: string): FiveByFiveEdgeAnalysis {
  const edges = fiveByFiveEdges();
  let pairedEdges = 0;
  let next: FiveByFiveEdgeDefinition | null = null;

  for (const edge of edges) {
    const pairs = edge.a.map((target, index) =>
      normalizedStickerPair(getFiveFacelet(raw5, target), getFiveFacelet(raw5, edge.b[index]))
    );
    const paired = pairs.every((pair) => pair === pairs[0]);
    if (paired) {
      pairedEdges += 1;
    } else if (!next) {
      next = edge;
    }
  }

  const target = next ?? edges[0];
  return {
    pairedEdges,
    nextEdgeName: target.name,
    nextFaces: [...target.faces],
    nextTargets: [...target.a, ...target.b],
  };
}

function parseCorners(raw3: string): { valid: true; permutation: number[]; orientationSum: number } | InvalidValidation {
  const permutation: number[] = [];
  const seen = new Set<number>();
  let orientationSum = 0;

  for (const facelets of CORNER_FACELETS) {
    const stickers = facelets.map((index) => raw3[index]);
    const orientation = stickers.findIndex((sticker) => sticker === "U" || sticker === "D");
    if (orientation < 0) return invalid("3x3 投影角塊缺少 U/D 顏色");

    const col1 = raw3[facelets[(orientation + 1) % 3]];
    const col2 = raw3[facelets[(orientation + 2) % 3]];
    const pieceIndex = CORNER_COLORS.findIndex((colors) => colors[1] === col1 && colors[2] === col2);
    if (pieceIndex < 0) return invalid("3x3 投影角塊組合不合法");
    if (seen.has(pieceIndex)) return invalid("3x3 投影角塊重複");

    seen.add(pieceIndex);
    permutation.push(pieceIndex);
    orientationSum += orientation % 3;
  }

  return { valid: true, permutation, orientationSum };
}

function parseEdges(raw3: string): { valid: true; permutation: number[]; orientationSum: number } | InvalidValidation {
  const permutation: number[] = [];
  const seen = new Set<number>();
  let orientationSum = 0;

  for (const [aIndex, bIndex] of EDGE_FACELETS) {
    const a = raw3[aIndex];
    const b = raw3[bIndex];
    let pieceIndex = EDGE_COLORS.findIndex((colors) => colors[0] === a && colors[1] === b);
    let orientation = 0;

    if (pieceIndex < 0) {
      pieceIndex = EDGE_COLORS.findIndex((colors) => colors[0] === b && colors[1] === a);
      orientation = 1;
    }

    if (pieceIndex < 0) return invalid("3x3 投影邊塊組合不合法");
    if (seen.has(pieceIndex)) return invalid("3x3 投影邊塊重複");

    seen.add(pieceIndex);
    permutation.push(pieceIndex);
    orientationSum += orientation;
  }

  return { valid: true, permutation, orientationSum };
}

function fiveByFiveEdges(): FiveByFiveEdgeDefinition[] {
  return [
    edge("白綠邊", ["U", "F"], [21, 22, 23], [1, 2, 3]),
    edge("白紅邊", ["U", "R"], [9, 14, 19], [1, 2, 3]),
    edge("白藍邊", ["U", "B"], [1, 2, 3], [1, 2, 3]),
    edge("白橘邊", ["U", "L"], [5, 10, 15], [1, 2, 3]),
    edge("黃綠邊", ["D", "F"], [1, 2, 3], [21, 22, 23]),
    edge("黃紅邊", ["D", "R"], [9, 14, 19], [21, 22, 23]),
    edge("黃藍邊", ["D", "B"], [21, 22, 23], [21, 22, 23]),
    edge("黃橘邊", ["D", "L"], [5, 10, 15], [21, 22, 23]),
    edge("綠紅邊", ["F", "R"], [9, 14, 19], [5, 10, 15]),
    edge("綠橘邊", ["F", "L"], [5, 10, 15], [9, 14, 19]),
    edge("藍紅邊", ["B", "R"], [5, 10, 15], [9, 14, 19]),
    edge("藍橘邊", ["B", "L"], [9, 14, 19], [5, 10, 15]),
  ];
}

function edge(
  name: string,
  faces: [FaceMove, FaceMove],
  aIndexes: number[],
  bIndexes: number[]
): FiveByFiveEdgeDefinition {
  return {
    name,
    faces,
    a: aIndexes.map((index) => ({ face: faces[0], index })),
    b: bIndexes.map((index) => ({ face: faces[1], index })),
  };
}

function getFiveFacelet(raw5: string, target: FaceletTarget): string {
  return raw5[FACE_OFFSET_5[target.face] + target.index] ?? "";
}

function normalizedStickerPair(a: string, b: string): string {
  return [a, b].sort().join("");
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

function invalid(reason: string): InvalidValidation {
  return { valid: false, reason };
}
