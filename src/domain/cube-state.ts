import Cube from "cubejs";
import { FACE_MOVES, movesToAlgorithm, type FaceMove, type MoveToken } from "./moves";

export type Sticker = FaceMove;

export interface CubeSnapshot {
  raw: string;
  faces: Record<FaceMove, Sticker[]>;
}

const FACE_OFFSET: Record<FaceMove, number> = {
  U: 0,
  R: 9,
  F: 18,
  D: 27,
  L: 36,
  B: 45,
};

export function snapshotFromMoves(moves: readonly MoveToken[]): CubeSnapshot {
  const cube = new Cube();
  const algorithm = movesToAlgorithm(moves);
  if (algorithm) cube.move(algorithm);
  return snapshotFromString(cube.asString());
}

export function snapshotFromString(raw: string): CubeSnapshot {
  const faces = {} as Record<FaceMove, Sticker[]>;

  for (const face of FACE_MOVES) {
    const offset = FACE_OFFSET[face];
    faces[face] = raw.slice(offset, offset + 9).split("") as Sticker[];
  }

  return { raw, faces };
}

export function applyMovesToSnapshot(snapshot: CubeSnapshot, moves: readonly MoveToken[]): CubeSnapshot {
  const cube = Cube.fromString(snapshot.raw);
  const algorithm = movesToAlgorithm(moves);
  if (algorithm) cube.move(algorithm);
  return snapshotFromString(cube.asString());
}

export function getSticker(snapshot: CubeSnapshot, face: FaceMove, position: number): Sticker {
  return snapshot.faces[face][position];
}

export function isFaceSolved(snapshot: CubeSnapshot, face: FaceMove): boolean {
  return snapshot.faces[face].every((sticker) => sticker === face);
}

export function countMatching(snapshot: CubeSnapshot, face: FaceMove, positions: readonly number[]): number {
  return positions.filter((position) => getSticker(snapshot, face, position) === face).length;
}

export function countSolvedFacelets(snapshot: CubeSnapshot): number {
  return FACE_MOVES.reduce(
    (total, face) => total + snapshot.faces[face].filter((sticker) => sticker === face).length,
    0
  );
}
