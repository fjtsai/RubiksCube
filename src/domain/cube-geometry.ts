import {
  FACE_MOVES,
  getMoveFace,
  getMoveSuffix,
  isInnerMove,
  isSliceMove,
  isWideMove,
  sliceMoveFollowing,
  type FaceMove,
  type MoveToken,
} from "./moves";

// NxN 魔方的貼紙幾何：每格貼紙對應一個 cubelet 座標與面法線。
// 座標乘 2 存成整數（-(n-1)..n-1，間隔 2），偶數階也不會出現半格。
// 面內索引規則與 RubiksScene 的 indexForX 一致（Kociemba 展開順序）。

type Vec3 = [number, number, number];

const FACE_NORMALS: Record<FaceMove, Vec3> = {
  U: [0, 1, 0],
  R: [1, 0, 0],
  F: [0, 0, 1],
  D: [0, -1, 0],
  L: [-1, 0, 0],
  B: [0, 0, -1],
};

export type WholeCubeRotation = "x" | "y" | "z";

// x 跟 R 同方向、y 跟 U 同方向、z 跟 F 同方向（標準整顆轉動記號）。
const ROTATE: Record<WholeCubeRotation, (v: Vec3) => Vec3> = {
  x: ([x, y, z]) => [x, z, -y],
  y: ([x, y, z]) => [-z, y, x],
  z: ([x, y, z]) => [y, -x, z],
};

export interface CubeOrientation {
  // 套用這個整顆轉動時，原本第 i 格貼紙會移到第 perm[i] 格。
  perm: Int16Array;
  // 原本在 face 的貼紙轉到哪一面。
  faceMap: Record<FaceMove, FaceMove>;
}

export interface UprightResult {
  // 轉成「每個中心都在自己那一面」之後的 facelet string。
  raw: string;
  // 標準方向的某一面，目前實際在畫面上的哪一面。
  toCurrentFace: Record<FaceMove, FaceMove>;
  // 標準方向的第 i 格，目前在第 toCurrentIndex[i] 格。
  toCurrentIndex: Int16Array;
}

const orientationCache = new Map<number, CubeOrientation[]>();

export function faceletCoord(size: number, face: FaceMove, index: number): Vec3 {
  const max = size - 1;
  const r = 2 * Math.floor(index / size) - max;
  const c = 2 * (index % size) - max;
  switch (face) {
    case "U":
      return [c, max, r];
    case "D":
      return [c, -max, -r];
    case "F":
      return [c, -r, max];
    case "B":
      return [-c, -r, -max];
    case "R":
      return [max, -r, -c];
    case "L":
      return [-max, -r, c];
  }
}

export function faceletIndex(size: number, face: FaceMove, [x, y, z]: Vec3): number {
  const max = size - 1;
  let row: number;
  let col: number;
  switch (face) {
    case "U":
      row = (z + max) / 2;
      col = (x + max) / 2;
      break;
    case "D":
      row = (max - z) / 2;
      col = (x + max) / 2;
      break;
    case "F":
      row = (max - y) / 2;
      col = (x + max) / 2;
      break;
    case "B":
      row = (max - y) / 2;
      col = (max - x) / 2;
      break;
    case "R":
      row = (max - y) / 2;
      col = (max - z) / 2;
      break;
    case "L":
      row = (max - y) / 2;
      col = (z + max) / 2;
      break;
  }
  return row * size + col;
}

function faceFromNormal([x, y, z]: Vec3): FaceMove {
  const face = FACE_MOVES.find((candidate) => {
    const normal = FACE_NORMALS[candidate];
    return normal[0] === x && normal[1] === y && normal[2] === z;
  });
  if (!face) throw new Error("Invalid face normal");
  return face;
}

function rotationPermutation(size: number, rotate: (v: Vec3) => Vec3): CubeOrientation {
  const perFace = size * size;
  const perm = new Int16Array(perFace * 6);
  const faceMap = {} as Record<FaceMove, FaceMove>;
  FACE_MOVES.forEach((face, faceIndex) => {
    const targetFace = faceFromNormal(rotate(FACE_NORMALS[face]));
    faceMap[face] = targetFace;
    const targetOffset = FACE_MOVES.indexOf(targetFace) * perFace;
    for (let index = 0; index < perFace; index += 1) {
      perm[faceIndex * perFace + index] = targetOffset + faceletIndex(size, targetFace, rotate(faceletCoord(size, face, index)));
    }
  });
  return { perm, faceMap };
}

function compose(first: CubeOrientation, second: CubeOrientation): CubeOrientation {
  const perm = new Int16Array(first.perm.length);
  for (let index = 0; index < perm.length; index += 1) {
    perm[index] = second.perm[first.perm[index]];
  }
  const faceMap = {} as Record<FaceMove, FaceMove>;
  for (const face of FACE_MOVES) {
    faceMap[face] = second.faceMap[first.faceMap[face]];
  }
  return { perm, faceMap };
}

// 24 種整顆魔方方向（含不轉）。
export function allOrientations(size: number): CubeOrientation[] {
  const cached = orientationCache.get(size);
  if (cached) return cached;

  const generators = (["x", "y"] as const).map((rotation) => rotationPermutation(size, ROTATE[rotation]));
  const identity = rotationPermutation(size, (v) => v);
  const seen = new Map<string, CubeOrientation>([[orientationKey(identity), identity]]);
  const queue = [identity];
  while (queue.length > 0) {
    const current = queue.shift() as CubeOrientation;
    for (const generator of generators) {
      const next = compose(current, generator);
      const key = orientationKey(next);
      if (seen.has(key)) continue;
      seen.set(key, next);
      queue.push(next);
    }
  }

  const orientations = [...seen.values()];
  orientationCache.set(size, orientations);
  return orientations;
}

function orientationKey(orientation: CubeOrientation): string {
  return FACE_MOVES.map((face) => orientation.faceMap[face]).join("");
}

export function applyOrientation(raw: string, orientation: CubeOrientation): string {
  const result = new Array<string>(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    result[orientation.perm[index]] = raw[index];
  }
  return result.join("");
}

// 中間切片會帶著中心一起轉，畫面上的 U 位置不一定是白色中心。
// 找出把中心轉回 U/R/F/D/L/B 的整顆轉動，讓教學、驗證與求解都在標準方向上判斷，
// 再用 toCurrentFace / toCurrentIndex 把結果對應回目前畫面上的面。
export function uprightFacelets(raw: string, size: number): UprightResult {
  const perFace = size * size;
  const identity = allOrientations(size)[0];
  if (size % 2 === 0) {
    return { raw, toCurrentFace: identityFaceMap(), toCurrentIndex: invertPermutation(identity.perm) };
  }

  const center = (perFace - 1) / 2;
  const upOffset = 0;
  const frontOffset = FACE_MOVES.indexOf("F") * perFace;
  for (const orientation of allOrientations(size)) {
    const rotated = applyOrientation(raw, orientation);
    if (rotated[upOffset + center] !== "U" || rotated[frontOffset + center] !== "F") continue;
    const toCurrentFace = {} as Record<FaceMove, FaceMove>;
    for (const face of FACE_MOVES) {
      toCurrentFace[orientation.faceMap[face]] = face;
    }
    return { raw: rotated, toCurrentFace, toCurrentIndex: invertPermutation(orientation.perm) };
  }

  return { raw, toCurrentFace: identityFaceMap(), toCurrentIndex: invertPermutation(identity.perm) };
}

export function mapMoveToCurrent(move: MoveToken, toCurrentFace: Record<FaceMove, FaceMove>): MoveToken {
  const suffix = getMoveSuffix(move);
  const face = toCurrentFace[getMoveFace(move)];
  if (isSliceMove(move)) return sliceMoveFollowing(face, suffix);
  if (isInnerMove(move)) return `2${face}${suffix}` as MoveToken;
  if (isWideMove(move)) return `${face}w${suffix}` as MoveToken;
  return `${face}${suffix}` as MoveToken;
}

export function mapFaceletToCurrent(
  target: { face: FaceMove; index: number },
  upright: UprightResult,
  size: number
): { face: FaceMove; index: number } {
  const perFace = size * size;
  const current = upright.toCurrentIndex[FACE_MOVES.indexOf(target.face) * perFace + target.index];
  return { face: FACE_MOVES[Math.floor(current / perFace)], index: current % perFace };
}

// 不論整顆魔方朝哪個方向，只要每一面都是單一顏色就算完成。
export function isUniformlySolved(raw: string, size: number): boolean {
  const perFace = size * size;
  for (let face = 0; face < 6; face += 1) {
    const first = raw[face * perFace];
    for (let index = 1; index < perFace; index += 1) {
      if (raw[face * perFace + index] !== first) return false;
    }
  }
  return true;
}

function invertPermutation(perm: Int16Array): Int16Array {
  const inverse = new Int16Array(perm.length);
  for (let index = 0; index < perm.length; index += 1) {
    inverse[perm[index]] = index;
  }
  return inverse;
}

function identityFaceMap(): Record<FaceMove, FaceMove> {
  return FACE_MOVES.reduce(
    (result, face) => {
      result[face] = face;
      return result;
    },
    {} as Record<FaceMove, FaceMove>
  );
}
