import { allOrientations } from "./cube-geometry";
import { buildColorModel, STANDARD_FACE_COLOR, type ColorModel, type ColorName } from "./color-classifier";
import type { RgbColor } from "./color-sampling";
import { solveAssignment } from "./hungarian";
import { FACE_MOVES, type FaceMove } from "./moves";
import {
  CORNER_COLORS,
  CORNER_FACELETS,
  EDGE_COLORS,
  EDGE_FACELETS,
  validateThreeByThreeFacelets,
} from "./three-by-three-validation";

// 六張照片 → 合法 3x3 狀態。
// 舊做法：先決定每格顏色，再暴力試 720 種面順序 × 4096 種旋轉找「完全合法」的組合；
// 只要有一格判錯就永遠找不到，還會在主執行緒跑上百萬次驗證、整個畫面卡住。
// 新做法：
// 1. 依中心色名稱直接決定每張照片是哪一面（白上綠前的標準配色），配色不同時才退回 30 種配色排列。
// 2. 4096 種面旋轉只用查表數「顏色組合合理的角塊/邊塊」來排名，幾毫秒內完成。
// 3. 對最好的幾個候選做最大概似糾錯：用指派演算法把 8 角、12 邊分配到位置上，
//    再修正角塊方向、邊塊方向與排列 parity，得到「與照片顏色差距最小的合法魔方」。
//    單格紅橘、白黃判錯會被自動修正並標示出來。

export interface ScanPlacement {
  capture: number;
  rotation: number;
}

export type ScanQuality = "good" | "check" | "poor";

export interface ScanReconstruction {
  valid: boolean;
  raw: string;
  observed: string;
  corrected: number[];
  confidence: number[];
  placement: Record<FaceMove, ScanPlacement>;
  faceColors: Record<FaceMove, ColorName>;
  standardScheme: boolean;
  quality: ScanQuality;
  reason: string;
  model: ColorModel;
  cost: number;
}

interface Arrangement {
  slotOfFace: number[];
  standard: boolean;
}

interface RotationCandidate {
  rotations: number[];
  score: number;
}

interface DecodeResult {
  letters: number[];
  observed: number[];
  confidence: number[];
  cost: number;
}

const CLOCKWISE_SOURCE = [6, 3, 0, 7, 4, 1, 8, 5, 2];
// SOURCE[r][p]：照片順時針轉 r 次後，第 p 格原本是照片的第幾格。
const SOURCE: number[][] = [0, 1, 2, 3].map((turns) => {
  let source = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let count = 0; count < turns; count += 1) {
    source = CLOCKWISE_SOURCE.map((index) => source[index]);
  }
  return source;
});

const FACE_INDEX = FACE_MOVES.reduce(
  (result, face, index) => {
    result[face] = index;
    return result;
  },
  {} as Record<FaceMove, number>
);
const CORNER_PIECES = CORNER_COLORS.map((colors) => colors.map((face) => FACE_INDEX[face]));
const EDGE_PIECES = EDGE_COLORS.map((colors) => colors.map((face) => FACE_INDEX[face]));
const CORNER_OK = buildCornerTable();
const EDGE_OK = buildEdgeTable();
const LOCKED_PENALTY = 1e4;
const TOP_ROTATION_CANDIDATES = 6;
const GOOD_ENOUGH_CORRECTIONS = 4;

export function reconstructScan(captures: readonly (readonly RgbColor[])[]): ScanReconstruction {
  const model = buildColorModel(captures);
  const arrangements = arrangementCandidates(model.slotColors);
  let best: { arrangement: Arrangement; rotations: number[]; decoded: DecodeResult } | null = null;

  for (const arrangement of arrangements) {
    for (const candidate of rankRotations(model, arrangement.slotOfFace)) {
      const decoded = decode(model, arrangement.slotOfFace, candidate.rotations, new Map());
      if (!best || decoded.cost < best.decoded.cost) best = { arrangement, rotations: candidate.rotations, decoded };
    }
    // 標準配色就解得很乾淨時不用再試其他配色排列。
    if (best && arrangement.standard && countCorrections(best.decoded) <= GOOD_ENOUGH_CORRECTIONS) break;
  }

  if (!best) throw new Error("無法重建魔方狀態");
  return buildResult(model, best.arrangement.slotOfFace, best.rotations, best.decoded, new Map());
}

// 使用者在確認畫面手動改色後，固定那些格子再重新糾錯一次。
export function redecodeScan(previous: ScanReconstruction, locked: ReadonlyMap<number, FaceMove>): ScanReconstruction {
  const slotOfFace = FACE_MOVES.map((face) => previous.placement[face].capture);
  const rotations = FACE_MOVES.map((face) => previous.placement[face].rotation);
  const decoded = decode(previous.model, slotOfFace, rotations, locked);
  return buildResult(previous.model, slotOfFace, rotations, decoded, locked);
}

// 使用者直接改色、不重新糾錯時，重新整理驗證結果。
export function withManualEdits(previous: ScanReconstruction, raw: string): ScanReconstruction {
  const validation = validateThreeByThreeFacelets(raw);
  return {
    ...previous,
    raw,
    valid: validation.valid,
    reason: validation.valid ? "已手動修正，狀態合法。" : `${validation.reason}。可以按「自動修正」讓系統找最接近的合法狀態。`,
    quality: validation.valid ? previous.quality : "poor",
  };
}

function buildResult(
  model: ColorModel,
  slotOfFace: number[],
  rotations: number[],
  decoded: DecodeResult,
  locked: ReadonlyMap<number, FaceMove>
): ScanReconstruction {
  const raw = decoded.letters.map((letter) => FACE_MOVES[letter]).join("");
  const observed = decoded.observed.map((letter) => FACE_MOVES[letter]).join("");
  const corrected = decoded.letters
    .map((letter, index) => (letter !== decoded.observed[index] && !locked.has(index) ? index : -1))
    .filter((index) => index >= 0);
  const validation = validateThreeByThreeFacelets(raw);
  const placement = {} as Record<FaceMove, ScanPlacement>;
  const faceColors = {} as Record<FaceMove, ColorName>;
  FACE_MOVES.forEach((face, index) => {
    placement[face] = { capture: slotOfFace[index], rotation: rotations[index] };
    faceColors[face] = model.slotColors[slotOfFace[index]];
  });
  const standardScheme = FACE_MOVES.every((face) => faceColors[face] === STANDARD_FACE_COLOR[face]);
  const quality: ScanQuality = !validation.valid ? "poor" : corrected.length === 0 ? "good" : corrected.length <= 4 ? "check" : "poor";

  const notes: string[] = [];
  if (model.centerConflict) notes.push(model.centerConflict);
  if (!validation.valid) notes.push(validation.reason);
  else if (corrected.length === 0) notes.push("辨識完成，每格顏色都和照片一致。");
  else if (corrected.length <= 4) notes.push(`自動修正了 ${corrected.length} 格顏色（虛線框），請對照實體魔方確認。`);
  else notes.push(`有 ${corrected.length} 格和照片顏色不一致，建議重拍標記最多的那一面。`);
  if (!standardScheme) notes.push("這顆魔方的配色和標準配色不同，3D 畫面顏色可能和實體不一樣。");

  return {
    valid: validation.valid,
    raw,
    observed,
    corrected,
    confidence: decoded.confidence,
    placement,
    faceColors,
    standardScheme,
    quality,
    reason: notes.join(" "),
    model,
    cost: decoded.cost,
  };
}

function countCorrections(decoded: DecodeResult): number {
  return decoded.letters.filter((letter, index) => letter !== decoded.observed[index]).length;
}

// 先放「中心色名稱 = 標準配色」的排列；接著是 30 種配色排列（固定第 0 張在上），
// 每種都轉成和中心色名稱最吻合的方向，讓 3D 畫面顏色盡量跟實體魔方一致。
function arrangementCandidates(slotColors: readonly ColorName[]): Arrangement[] {
  const standard = FACE_MOVES.map((face) => slotColors.indexOf(STANDARD_FACE_COLOR[face]));
  const result: Arrangement[] = [{ slotOfFace: standard, standard: true }];
  const seen = new Set([standard.join("")]);
  const orientations = allOrientations(3);

  for (let down = 1; down < 6; down += 1) {
    const rest = [1, 2, 3, 4, 5].filter((slot) => slot !== down);
    const front = rest[0];
    for (const [right, back, left] of permutations(rest.slice(1))) {
      const base: Record<FaceMove, number> = { U: 0, D: down, F: front, R: right, B: back, L: left };
      let bestOriented: number[] | null = null;
      let bestMatches = -1;
      for (const orientation of orientations) {
        const oriented = new Array<number>(6);
        for (const face of FACE_MOVES) {
          oriented[FACE_INDEX[orientation.faceMap[face]]] = base[face];
        }
        const matches = FACE_MOVES.filter((face, index) => slotColors[oriented[index]] === STANDARD_FACE_COLOR[face]).length;
        if (matches > bestMatches) {
          bestMatches = matches;
          bestOriented = oriented;
        }
      }
      if (!bestOriented) continue;
      const key = bestOriented.join("");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ slotOfFace: bestOriented, standard: false });
    }
  }
  return result;
}

function rankRotations(model: ColorModel, slotOfFace: readonly number[]): RotationCandidate[] {
  const faceOfSlot = new Array<number>(6);
  slotOfFace.forEach((slot, face) => {
    faceOfSlot[slot] = face;
  });
  const labels = slotOfFace.map((slot) =>
    SOURCE.map((source) => source.map((index) => faceOfSlot[model.labels[slot][index]]))
  );
  const state = new Int8Array(54);
  const top: RotationCandidate[] = [];
  const rotations = [0, 0, 0, 0, 0, 0];

  for (let combo = 0; combo < 4096; combo += 1) {
    for (let face = 0; face < 6; face += 1) {
      rotations[face] = (combo >> (face * 2)) & 3;
      const faceLabels = labels[face][rotations[face]];
      for (let index = 0; index < 9; index += 1) state[face * 9 + index] = faceLabels[index];
    }
    let score = 0;
    for (const [a, b, c] of CORNER_FACELETS) score += CORNER_OK[state[a] * 36 + state[b] * 6 + state[c]];
    for (const [a, b] of EDGE_FACELETS) score += EDGE_OK[state[a] * 6 + state[b]];

    if (top.length < TOP_ROTATION_CANDIDATES || score > top[top.length - 1].score) {
      top.push({ rotations: [...rotations], score });
      top.sort((x, y) => y.score - x.score);
      if (top.length > TOP_ROTATION_CANDIDATES) top.pop();
    }
  }

  const bestScore = top[0]?.score ?? 0;
  return top.filter((candidate) => candidate.score >= bestScore - 2);
}

function decode(
  model: ColorModel,
  slotOfFace: readonly number[],
  rotations: readonly number[],
  locked: ReadonlyMap<number, FaceMove>
): DecodeResult {
  const cost: number[][] = [];
  const observed: number[] = [];
  for (let face = 0; face < 6; face += 1) {
    const capture = slotOfFace[face];
    for (let position = 0; position < 9; position += 1) {
      const index = face * 9 + position;
      const source = SOURCE[rotations[face]][position];
      const row = slotOfFace.map((slot) => model.costs[capture][source][slot]);
      const lockedFace = locked.get(index);
      cost.push(lockedFace ? row.map((_, letter) => (letter === FACE_INDEX[lockedFace] ? 0 : LOCKED_PENALTY)) : row);
      observed.push(position === 4 ? face : argMin(row));
    }
  }

  const corners = solveOrientedAssignment(
    CORNER_FACELETS.map((facelets) =>
      CORNER_PIECES.map((colors) =>
        [0, 1, 2].map((twist) => facelets.reduce<number>((sum, facelet, slot) => sum + cost[facelet][colors[(slot - twist + 3) % 3]], 0))
      )
    ),
    3
  );
  const edges = solveOrientedAssignment(
    EDGE_FACELETS.map((facelets) =>
      EDGE_PIECES.map((colors) =>
        [0, 1].map((flip) => facelets.reduce<number>((sum, facelet, slot) => sum + cost[facelet][colors[(slot + flip) % 2]], 0))
      )
    ),
    2
  );
  const { corner, edge } = fixPermutationParity(corners, edges);

  const letters = new Array<number>(54);
  for (let face = 0; face < 6; face += 1) letters[face * 9 + 4] = face;
  CORNER_FACELETS.forEach((facelets, position) => {
    const colors = CORNER_PIECES[corner.assign[position]];
    facelets.forEach((facelet, slot) => {
      letters[facelet] = colors[(slot - corner.orient[position] + 3) % 3];
    });
  });
  EDGE_FACELETS.forEach((facelets, position) => {
    const colors = EDGE_PIECES[edge.assign[position]];
    facelets.forEach((facelet, slot) => {
      letters[facelet] = colors[(slot + edge.orient[position]) % 2];
    });
  });

  const confidence = letters.map((letter, index) => {
    const chosen = cost[index][letter];
    let alternative = Number.POSITIVE_INFINITY;
    cost[index].forEach((value, candidate) => {
      if (candidate !== letter) alternative = Math.min(alternative, value);
    });
    if (index % 9 === 4) return 1;
    return Math.max(0, Math.min(1, (alternative - chosen) / Math.max(alternative, 1)));
  });

  return { letters, observed, confidence, cost: corner.cost + edge.cost };
}

interface OrientedAssignment {
  assign: number[];
  orient: number[];
  cost: number;
  table: number[][][];
  modulus: number;
}

// 每個位置挑一個塊（不重複）與方向，總成本最小，且方向總和符合魔方規則
// （角塊轉向和為 3 的倍數、邊塊翻轉和為偶數）。
function solveOrientedAssignment(table: number[][][], modulus: number): OrientedAssignment {
  const matrix = table.map((row) => row.map((options) => Math.min(...options)));
  const assign = solveAssignment(matrix);
  return fixOrientationSum(assign, table, modulus);
}

function fixOrientationSum(assign: number[], table: number[][][], modulus: number): OrientedAssignment {
  const orient = assign.map((piece, position) => argMin(table[position][piece]));
  const sum = orient.reduce((total, value) => total + value, 0) % modulus;
  const baseCost = assign.reduce((total, piece, position) => total + table[position][piece][orient[position]], 0);
  if (sum === 0) return { assign, orient, cost: baseCost, table, modulus };

  const need = (modulus - sum) % modulus;
  const changeCost = (position: number, delta: number): number => {
    const options = table[position][assign[position]];
    return options[(orient[position] + delta) % modulus] - options[orient[position]];
  };

  let best = { cost: Number.POSITIVE_INFINITY, changes: [] as Array<[number, number]> };
  for (let position = 0; position < assign.length; position += 1) {
    const delta = changeCost(position, need);
    if (delta < best.cost) best = { cost: delta, changes: [[position, need]] };
  }
  if (modulus === 3) {
    // 需要 +1 也可以用兩個 +2；需要 +2 也可以用兩個 +1。
    const pairDelta = need === 1 ? 2 : 1;
    for (let a = 0; a < assign.length; a += 1) {
      for (let b = a + 1; b < assign.length; b += 1) {
        const delta = changeCost(a, pairDelta) + changeCost(b, pairDelta);
        if (delta < best.cost) best = { cost: delta, changes: [[a, pairDelta], [b, pairDelta]] };
      }
    }
  }

  const fixed = [...orient];
  for (const [position, delta] of best.changes) fixed[position] = (fixed[position] + delta) % modulus;
  return { assign, orient: fixed, cost: baseCost + best.cost, table, modulus };
}

// 角塊與邊塊的排列奇偶必須一致；不一致時找代價最小的一次兩塊交換。
function fixPermutationParity(
  corners: OrientedAssignment,
  edges: OrientedAssignment
): { corner: OrientedAssignment; edge: OrientedAssignment } {
  if (permutationParity(corners.assign) === permutationParity(edges.assign)) return { corner: corners, edge: edges };

  let best: { corner: OrientedAssignment; edge: OrientedAssignment; cost: number } | null = null;
  const consider = (corner: OrientedAssignment, edge: OrientedAssignment): void => {
    const cost = corner.cost + edge.cost;
    if (!best || cost < best.cost) best = { corner, edge, cost };
  };

  for (const swapped of swapCandidates(corners)) consider(swapped, edges);
  for (const swapped of swapCandidates(edges)) consider(corners, swapped);
  if (!best) return { corner: corners, edge: edges };
  const chosen = best as { corner: OrientedAssignment; edge: OrientedAssignment };
  return { corner: chosen.corner, edge: chosen.edge };
}

function swapCandidates(assignment: OrientedAssignment): OrientedAssignment[] {
  const result: OrientedAssignment[] = [];
  for (let a = 0; a < assignment.assign.length; a += 1) {
    for (let b = a + 1; b < assignment.assign.length; b += 1) {
      const assign = [...assignment.assign];
      [assign[a], assign[b]] = [assign[b], assign[a]];
      result.push(fixOrientationSum(assign, assignment.table, assignment.modulus));
    }
  }
  return result;
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

function buildCornerTable(): Uint8Array {
  const table = new Uint8Array(216);
  for (const colors of CORNER_PIECES) {
    for (let twist = 0; twist < 3; twist += 1) {
      table[colors[twist] * 36 + colors[(twist + 1) % 3] * 6 + colors[(twist + 2) % 3]] = 1;
    }
  }
  return table;
}

function buildEdgeTable(): Uint8Array {
  const table = new Uint8Array(36);
  for (const [a, b] of EDGE_PIECES) {
    table[a * 6 + b] = 1;
    table[b * 6 + a] = 1;
  }
  return table;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}

function argMin(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < values[best]) best = index;
  }
  return best;
}
