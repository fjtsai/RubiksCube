import { FACE_MOVES, type FaceMove } from "./moves";

export type ScanFace = FaceMove;
export type ScanColor = FaceMove;

export interface ScannedFace {
  face: ScanFace;
  stickers: ScanColor[];
}

export interface ScanResult {
  raw: string;
  faces: Record<ScanFace, ScanColor[]>;
}

export const FACELET_FACE_ORDER = FACE_MOVES;
export const THREE_BY_THREE_FACELET_COUNT = 54;
export const THREE_BY_THREE_FACE_SIZE = 9;
export const SOLVED_THREE_BY_THREE_FACELETS = FACELET_FACE_ORDER.map((face) => face.repeat(THREE_BY_THREE_FACE_SIZE)).join("");

export function normalizeFaceletInput(input: string): string {
  return input.toUpperCase().replace(/[^URFDLB]/g, "");
}

export function buildScanResult(faces: Record<ScanFace, readonly ScanColor[]>): ScanResult {
  return {
    raw: FACELET_FACE_ORDER.flatMap((face) => [...faces[face]]).join(""),
    faces: FACELET_FACE_ORDER.reduce(
      (result, face) => {
        result[face] = [...faces[face]];
        return result;
      },
      {} as Record<ScanFace, ScanColor[]>
    ),
  };
}

export function splitFaceletString(raw: string): Record<ScanFace, ScanColor[]> {
  return FACELET_FACE_ORDER.reduce(
    (faces, face, index) => {
      const start = index * THREE_BY_THREE_FACE_SIZE;
      faces[face] = raw.slice(start, start + THREE_BY_THREE_FACE_SIZE).split("") as ScanColor[];
      return faces;
    },
    {} as Record<ScanFace, ScanColor[]>
  );
}
