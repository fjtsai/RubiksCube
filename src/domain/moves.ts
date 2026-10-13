export const FACE_MOVES = ["U", "R", "F", "D", "L", "B"] as const;

export type FaceMove = (typeof FACE_MOVES)[number];
export type MoveSuffix = "" | "'" | "2";
export type MoveBase = FaceMove | `${FaceMove}w` | `2${FaceMove}`;
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

const MOVE_PATTERN = /^(2[URFDLB]|[URFDLB]w?)([2']?)$/;

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

export function getMoveFace(move: MoveToken): FaceMove {
  return (move.startsWith("2") ? move[1] : move[0]) as FaceMove;
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

export function describeMove(move: MoveToken): string {
  const spec = MOVE_SPECS[getMoveFace(move)];
  const suffix = getMoveSuffix(move);
  const name = isInnerMove(move) ? `內${spec.name}` : isWideMove(move) ? `${spec.name}兩層` : spec.name;
  if (suffix === "2") return `${name}轉半圈`;
  if (suffix === "'") return `${name}逆時針`;
  return `${name}順時針`;
}
