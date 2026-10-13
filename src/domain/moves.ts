export const FACE_MOVES = ["U", "R", "F", "D", "L", "B"] as const;

export type FaceMove = (typeof FACE_MOVES)[number];
export type MoveSuffix = "" | "'" | "2";
export const SLICE_MOVES = ["M", "E", "S"] as const;
export type SliceMove = (typeof SLICE_MOVES)[number];
export type MoveBase = FaceMove | `${FaceMove}w` | `2${FaceMove}` | SliceMove;
export type MoveToken = `${MoveBase}${MoveSuffix}`;
export type AxisName = "x" | "y" | "z";

export interface MoveSpec {
  face: FaceMove;
  axis: AxisName;
  layer: -1 | 1;
  angle: number;
  name: string;
  color: string;
}

export const MOVE_SPECS: Record<FaceMove, MoveSpec> = {
  U: { face: "U", axis: "y", layer: 1, angle: -Math.PI / 2, name: "上層", color: "#ffffff" },
  R: { face: "R", axis: "x", layer: 1, angle: -Math.PI / 2, name: "右層", color: "#ff4f4f" },
  F: { face: "F", axis: "z", layer: 1, angle: -Math.PI / 2, name: "前層", color: "#36c56f" },
  D: { face: "D", axis: "y", layer: -1, angle: Math.PI / 2, name: "下層", color: "#ffd84d" },
  L: { face: "L", axis: "x", layer: -1, angle: Math.PI / 2, name: "左層", color: "#ff9a3c" },
  B: { face: "B", axis: "z", layer: -1, angle: Math.PI / 2, name: "後層", color: "#4e8dff" },
};

export const OPPOSITE_FACE: Record<FaceMove, FaceMove> = { U: "D", D: "U", R: "L", L: "R", F: "B", B: "F" };

// 正中間的切片（奇數階才有）：M 跟 L 同方向、E 跟 D 同方向、S 跟 F 同方向。
const SLICE_FOLLOW_FACE: Record<SliceMove, FaceMove> = { M: "L", E: "D", S: "F" };

const MOVE_PATTERN = /^(2[URFDLB]|[URFDLB]w?|[MES])([2']?)$/;

export function parseMove(raw: string): MoveToken | null {
  const token = raw.trim();
  if (!MOVE_PATTERN.test(token)) return null;
  return token as MoveToken;
}

export function parseAlgorithm(algorithm: string): MoveToken[] {
  return algorithm
    .trim()
    .split(/\s+/)
    .map(parseMove)
    .filter((move): move is MoveToken => move !== null);
}

export function movesToAlgorithm(moves: readonly MoveToken[]): string {
  return moves.join(" ");
}

// 回傳決定旋轉軸與方向的面；中間切片回傳它跟隨的面（M→L、E→D、S→F）。
export function getMoveFace(move: MoveToken): FaceMove {
  if (isSliceMove(move)) return SLICE_FOLLOW_FACE[move[0] as SliceMove];
  return (move.startsWith("2") ? move[1] : move[0]) as FaceMove;
}

export function isSliceMove(move: MoveToken): boolean {
  return move[0] === "M" || move[0] === "E" || move[0] === "S";
}

// 以「中間切片跟著哪一面的方向轉」組出 M/E/S 記號，follow 為反向面時自動加上 '。
export function sliceMoveFollowing(face: FaceMove, suffix: MoveSuffix): MoveToken {
  const entry = (Object.entries(SLICE_FOLLOW_FACE) as Array<[SliceMove, FaceMove]>).find(
    ([, follow]) => follow === face || OPPOSITE_FACE[follow] === face
  );
  if (!entry) throw new Error(`No slice follows ${face}`);
  const [slice, follow] = entry;
  if (follow === face || suffix === "2") return `${slice}${suffix}` as MoveToken;
  return `${slice}${suffix === "'" ? "" : "'"}` as MoveToken;
}

export function getMoveSuffix(move: MoveToken): MoveSuffix {
  if (move.endsWith("2")) return "2";
  if (move.endsWith("'")) return "'";
  return "";
}

export function isWideMove(move: MoveToken): boolean {
  return move.includes("w");
}

export function isInnerMove(move: MoveToken): boolean {
  return move.startsWith("2");
}

export function getMoveAngle(move: MoveToken): number {
  const spec = MOVE_SPECS[getMoveFace(move)];
  const suffix = getMoveSuffix(move);
  if (suffix === "2") return spec.angle * 2;
  if (suffix === "'") return -spec.angle;
  return spec.angle;
}

export function inverseMove(move: MoveToken): MoveToken {
  const suffix = getMoveSuffix(move);
  if (suffix === "2") return move;
  const base = move.replace(/[2']$/, "") as MoveBase;
  return `${base}${suffix === "'" ? "" : "'"}` as MoveToken;
}

export function invertAlgorithm(moves: readonly MoveToken[]): MoveToken[] {
  return [...moves].reverse().map(inverseMove);
}

export function randomScramble(length = 20): MoveToken[] {
  const result: MoveToken[] = [];
  let previousFace: FaceMove | null = null;
  let previousAxis: AxisName | null = null;
  const suffixes: MoveSuffix[] = ["", "'", "2"];

  while (result.length < length) {
    const face = FACE_MOVES[Math.floor(Math.random() * FACE_MOVES.length)];
    const axis = MOVE_SPECS[face].axis;
    if (face === previousFace || axis === previousAxis) continue;

    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    result.push(`${face}${suffix}` as MoveToken);
    previousFace = face;
    previousAxis = axis;
  }

  return result;
}

export function randomFiveByFiveScramble(length = 34): MoveToken[] {
  const result: MoveToken[] = [];
  let previousFace: FaceMove | null = null;
  let previousAxis: AxisName | null = null;
  const suffixes: MoveSuffix[] = ["", "'", "2"];

  while (result.length < length) {
    const face = FACE_MOVES[Math.floor(Math.random() * FACE_MOVES.length)];
    const axis = MOVE_SPECS[face].axis;
    if (face === previousFace || axis === previousAxis) continue;

    const roll = Math.random();
    const wide = roll >= 0.28 && roll < 0.66;
    const inner = roll < 0.28;
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    const base = inner ? `2${face}` : `${face}${wide ? "w" : ""}`;
    result.push(`${base}${suffix}` as MoveToken);
    previousFace = face;
    previousAxis = axis;
  }

  return result;
}

const SLICE_DESCRIPTIONS: Record<SliceMove, Record<MoveSuffix, string>> = {
  M: { "": "中間直排往下轉", "'": "中間直排往上轉", "2": "中間直排轉半圈" },
  E: { "": "中間橫排往右轉", "'": "中間橫排往左轉", "2": "中間橫排轉半圈" },
  S: { "": "中間夾層順時針", "'": "中間夾層逆時針", "2": "中間夾層轉半圈" },
};

export function describeMove(move: MoveToken): string {
  const suffix = getMoveSuffix(move);
  if (isSliceMove(move)) return SLICE_DESCRIPTIONS[move[0] as SliceMove][suffix];
  const spec = MOVE_SPECS[getMoveFace(move)];
  const name = isInnerMove(move) ? `內${spec.name}` : isWideMove(move) ? `${spec.name}兩層` : spec.name;
  if (suffix === "2") return `${name}轉半圈`;
  if (suffix === "'") return `${name}逆時針`;
  return `${name}順時針`;
}

// 合併相鄰的同一層轉動（R R → R2、R R' → 抵銷），讓 5x5 的移動紀錄不會無限變長。
export function simplifyMoves(moves: readonly MoveToken[]): MoveToken[] {
  const stack: Array<{ base: MoveBase; quarters: number }> = [];
  for (const move of moves) {
    const base = move.replace(/[2']$/, "") as MoveBase;
    const suffix = getMoveSuffix(move);
    const quarters = suffix === "2" ? 2 : suffix === "'" ? 3 : 1;
    const top = stack[stack.length - 1];
    if (top && top.base === base) {
      top.quarters = (top.quarters + quarters) % 4;
      if (top.quarters === 0) stack.pop();
    } else {
      stack.push({ base, quarters });
    }
  }
  return stack.map(({ base, quarters }) => `${base}${quarters === 2 ? "2" : quarters === 3 ? "'" : ""}` as MoveToken);
}
