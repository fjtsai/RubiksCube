import Cube from "cubejs";
import {
  applyMovesToSnapshot,
  countMatching,
  countSolvedFacelets,
  getSticker,
  isFaceSolved,
  snapshotFromMoves,
  snapshotFromString,
  type CubeSnapshot,
} from "./cube-state";
import { getMoveFace, type FaceMove, type MoveToken } from "./moves";

export type BeginnerStageId =
  | "white-cross"
  | "first-layer"
  | "middle-layer"
  | "yellow-cross"
  | "yellow-face"
  | "last-layer"
  | "parity"
  | "solved";

export interface BeginnerCoach {
  stageId: BeginnerStageId;
  label: string;
  title: string;
  body: string;
  focusFaces: FaceMove[];
  highlightFacelets?: Array<{ face: FaceMove; index: number }>;
  progress: number;
  total: number;
  progressLabel: string;
  recommended: MoveToken[];
  recommendationLabel: string;
}

interface StageDefinition {
  id: BeginnerStageId;
  label: string;
  title: string;
  focusFaces: FaceMove[];
  total: number;
  complete: (snapshot: CubeSnapshot) => boolean;
  previousComplete: (snapshot: CubeSnapshot) => boolean;
  score: (snapshot: CubeSnapshot) => number;
  describe: (snapshot: CubeSnapshot) => string;
}

const D_EDGE_POSITIONS = [1, 3, 5, 7] as const;
const U_FACE_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
const D_FACE_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
const TOP_ROW = [0, 1, 2] as const;
const MIDDLE_ROW = [3, 4, 5] as const;
const BOTTOM_ROW = [6, 7, 8] as const;
const SIDE_FACES: FaceMove[] = ["F", "R", "B", "L"];

const WHITE_CROSS_EDGES: Array<{ whitePos: number; side: FaceMove; sidePos: number; name: string }> = [
  { whitePos: 7, side: "F", sidePos: 1, name: "前面的白邊" },
  { whitePos: 5, side: "R", sidePos: 1, name: "右邊的白邊" },
  { whitePos: 1, side: "B", sidePos: 1, name: "後面的白邊" },
  { whitePos: 3, side: "L", sidePos: 1, name: "左邊的白邊" },
];

const MOVE_ORDER: MoveToken[] = [
  "U",
  "U'",
  "U2",
  "R",
  "R'",
  "F",
  "F'",
  "L",
  "L'",
  "B",
  "B'",
  "D",
  "D'",
  "D2",
  "R2",
  "F2",
  "L2",
  "B2",
];

const STAGES: StageDefinition[] = [
  {
    id: "white-cross",
    label: "正在做白色十字",
    title: "白色十字",
    focusFaces: ["U", "F", "R", "L", "B"],
    total: 8,
    previousComplete: () => true,
    complete: isWhiteCrossSolved,
    score: whiteCrossScore,
    describe: describeWhiteCross,
  },
  {
    id: "first-layer",
    label: "正在做白色角塊",
    title: "第一層角塊",
    focusFaces: ["U", "F", "R", "L", "B"],
    total: 21,
    previousComplete: isWhiteCrossSolved,
    complete: isFirstLayerSolved,
    score: firstLayerScore,
    describe: describeFirstLayer,
  },
  {
    id: "middle-layer",
    label: "正在做第二層",
    title: "第二層邊塊",
    focusFaces: ["F", "R", "L", "B"],
    total: 12,
    previousComplete: isFirstLayerSolved,
    complete: isMiddleLayerSolved,
    score: middleLayerScore,
    describe: describeMiddleLayer,
  },
  {
    id: "yellow-cross",
    label: "正在做黃色十字",
    title: "黃色十字",
    focusFaces: ["D", "F", "R"],
    total: 4,
    previousComplete: isMiddleLayerSolved,
    complete: isYellowCrossSolved,
    score: yellowCrossScore,
    describe: describeYellowCross,
  },
  {
    id: "yellow-face",
    label: "正在做黃色整面",
    title: "黃色整面",
    focusFaces: ["D", "R"],
    total: 9,
    previousComplete: isYellowCrossSolved,
    complete: isYellowFaceSolved,
    score: yellowFaceScore,
    describe: describeYellowFace,
  },
  {
    id: "last-layer",
    label: "正在做最後一圈",
    title: "最後一圈換位置",
    focusFaces: ["D", "F", "R", "L", "B"],
    total: 54,
    previousComplete: isYellowFaceSolved,
    complete: isSolved,
    score: countSolvedFacelets,
    describe: describeLastLayer,
  },
];

export function evaluateBeginnerCoach(
  moves: readonly MoveToken[],
  options: { includeRecommendation?: boolean } = {}
): BeginnerCoach {
  const snapshot = snapshotFromMoves(moves);
  return evaluateBeginnerCoachSnapshot(snapshot, options);
}

export function evaluateBeginnerCoachFromString(
  raw: string,
  options: { includeRecommendation?: boolean } = {}
): BeginnerCoach {
  return evaluateBeginnerCoachSnapshot(snapshotFromString(raw), options);
}

export function evaluateBeginnerCoachSnapshot(
  snapshot: CubeSnapshot,
  options: { includeRecommendation?: boolean } = {}
): BeginnerCoach {
  if (isSolved(snapshot)) {
    return {
      stageId: "solved",
      label: "完成",
      title: "魔方完成了",
      body: "每一面都回到自己的顏色。可以再按打亂開始新的挑戰。",
      focusFaces: ["U", "R", "F", "D", "L", "B"],
      progress: 54,
      total: 54,
      progressLabel: "54/54",
      recommended: [],
      recommendationLabel: "已完成",
    };
  }

  const stage = STAGES.find((definition) => !definition.complete(snapshot)) ?? STAGES[STAGES.length - 1];
  const progress = stage.score(snapshot);
  const recommended = options.includeRecommendation ? findImprovingSequence(snapshot, stage) : [];

  return {
    stageId: stage.id,
    label: stage.label,
    title: stage.title,
    body: stage.describe(snapshot),
    focusFaces: stage.focusFaces,
    progress,
    total: stage.total,
    progressLabel: `${progress}/${stage.total}`,
    recommended,
    recommendationLabel: recommended.length > 0 ? `建議先練 ${recommended.join(" ")}` : "按提示可找精準下一步",
  };
}

function isWhiteCrossSolved(snapshot: CubeSnapshot): boolean {
  return WHITE_CROSS_EDGES.every(
    (edge) => getSticker(snapshot, "U", edge.whitePos) === "U" && getSticker(snapshot, edge.side, edge.sidePos) === edge.side
  );
}

function whiteCrossScore(snapshot: CubeSnapshot): number {
  return WHITE_CROSS_EDGES.reduce((score, edge) => {
    const whiteReady = getSticker(snapshot, "U", edge.whitePos) === "U";
    const sideReady = getSticker(snapshot, edge.side, edge.sidePos) === edge.side;
    return score + (whiteReady ? 1 : 0) + (whiteReady && sideReady ? 1 : 0);
  }, 0);
}

function isFirstLayerSolved(snapshot: CubeSnapshot): boolean {
  return isWhiteCrossSolved(snapshot) && firstLayerScore(snapshot) === 21;
}

function firstLayerScore(snapshot: CubeSnapshot): number {
  return countMatching(snapshot, "U", U_FACE_POSITIONS) + SIDE_FACES.reduce((sum, face) => sum + countMatching(snapshot, face, TOP_ROW), 0);
}

function isMiddleLayerSolved(snapshot: CubeSnapshot): boolean {
  return isFirstLayerSolved(snapshot) && middleLayerScore(snapshot) === 12;
}

function middleLayerScore(snapshot: CubeSnapshot): number {
  return SIDE_FACES.reduce((sum, face) => sum + countMatching(snapshot, face, MIDDLE_ROW), 0);
}

function isYellowCrossSolved(snapshot: CubeSnapshot): boolean {
  return isMiddleLayerSolved(snapshot) && yellowCrossScore(snapshot) === 4;
}

function yellowCrossScore(snapshot: CubeSnapshot): number {
  return countMatching(snapshot, "D", D_EDGE_POSITIONS);
}

function isYellowFaceSolved(snapshot: CubeSnapshot): boolean {
  return isYellowCrossSolved(snapshot) && yellowFaceScore(snapshot) === 9;
}

function yellowFaceScore(snapshot: CubeSnapshot): number {
  return countMatching(snapshot, "D", D_FACE_POSITIONS);
}

function isLastLayerPositioned(snapshot: CubeSnapshot): boolean {
  return SIDE_FACES.every((face) => BOTTOM_ROW.every((position) => getSticker(snapshot, face, position) === face));
}

function isSolved(snapshot: CubeSnapshot): boolean {
  return SIDE_FACES.every((face) => isFaceSolved(snapshot, face)) && isFaceSolved(snapshot, "U") && isFaceSolved(snapshot, "D");
}

function describeWhiteCross(snapshot: CubeSnapshot): string {
  const missing = WHITE_CROSS_EDGES.filter(
    (edge) => getSticker(snapshot, "U", edge.whitePos) !== "U" || getSticker(snapshot, edge.side, edge.sidePos) !== edge.side
  );
  if (missing.length === 0) return "白色十字已經排好，下一步找四個白色角塊。";
  const first = missing[0];
  return `先處理${first.name}。白色要在白色中心旁邊，旁邊顏色也要對齊自己的中心。`;
}

function describeFirstLayer(snapshot: CubeSnapshot): string {
  const whiteCount = countMatching(snapshot, "U", U_FACE_POSITIONS);
  return `白色面目前有 ${whiteCount}/9 格。找有白色的角塊，用 R U R' U' 這種短手法把它送回角落。`;
}

function describeMiddleLayer(snapshot: CubeSnapshot): string {
  const solvedEdges = Math.floor(middleLayerScore(snapshot) / 3);
  return `第二層大約完成 ${solvedEdges}/4 條邊。找沒有黃色、白色的邊塊，先對中心色，再送到左邊或右邊。`;
}

function describeYellowCross(snapshot: CubeSnapshot): string {
  const count = yellowCrossScore(snapshot);
  const shape = describeYellowCrossShape(snapshot);
  return `黃色邊塊目前是「${shape}」，完成 ${count}/4。目標是先讓黃色十字出現。`;
}

function describeYellowFace(snapshot: CubeSnapshot): string {
  return `黃色面目前有 ${yellowFaceScore(snapshot)}/9 格。先不用管旁邊位置，只要讓黃色全部翻到同一面。`;
}

function describeLastLayer(snapshot: CubeSnapshot): string {
  if (isLastLayerPositioned(snapshot)) return "最後一圈已對齊，檢查每一面是否都完成。";
  return "黃色面已完成，現在只剩最後一圈的位置要互換。觀察哪一面已經有同色排成一排。";
}

function describeYellowCrossShape(snapshot: CubeSnapshot): string {
  const top = getSticker(snapshot, "D", 1) === "D";
  const left = getSticker(snapshot, "D", 3) === "D";
  const right = getSticker(snapshot, "D", 5) === "D";
  const bottom = getSticker(snapshot, "D", 7) === "D";
  const count = [top, left, right, bottom].filter(Boolean).length;
  if (count === 4) return "十字";
  if (count === 0) return "一個點";
  if ((top && bottom) || (left && right)) return "一直線";
  return "小 L";
}

function findImprovingSequence(snapshot: CubeSnapshot, stage: StageDefinition): MoveToken[] {
  const currentScore = stage.score(snapshot);
  const maxDepth = stage.id === "white-cross" ? 4 : stage.id === "last-layer" ? 3 : 4;
  const startCube = Cube.fromString(snapshot.raw);
  const seen = new Set<string>([snapshot.raw]);
  let frontier: Array<{ cube: Cube; moves: MoveToken[] }> = [{ cube: startCube, moves: [] }];

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const nextFrontier: Array<{ cube: Cube; moves: MoveToken[] }> = [];

    for (const node of frontier) {
      for (const move of MOVE_ORDER) {
        const last = node.moves[node.moves.length - 1];
        if (last && getMoveFace(last) === getMoveFace(move)) continue;

        const cube = node.cube.clone();
        cube.move(move);
        const nextSnapshot = snapshotFromString(cube.asString());
        if (seen.has(nextSnapshot.raw)) continue;
        seen.add(nextSnapshot.raw);

        if (!stage.previousComplete(nextSnapshot)) continue;

        const score = stage.score(nextSnapshot);
        const moves = [...node.moves, move];
        if (stage.complete(nextSnapshot) || score > currentScore) {
          return moves;
        }

        nextFrontier.push({ cube, moves });
      }
    }

    frontier = nextFrontier;
  }

  return fallbackSequence(snapshot, stage);
}

function fallbackSequence(snapshot: CubeSnapshot, stage: StageDefinition): MoveToken[] {
  const candidates: MoveToken[][] = [
    ["R", "U", "R'", "U'"],
    ["F", "R", "U", "R'", "U'", "F'"],
    ["U", "R", "U'", "R'", "U'", "F'", "U", "F"],
    ["R", "U", "R'", "U", "R", "U2", "R'"],
    ["R", "U'", "R", "U", "R", "U", "R", "U'", "R'", "U'", "R2"],
  ];

  for (const candidate of candidates) {
    const after = applyMovesToSnapshot(snapshot, candidate);
    if (stage.previousComplete(after) && stage.score(after) > stage.score(snapshot)) {
      return candidate;
    }
  }

  return [];
}
