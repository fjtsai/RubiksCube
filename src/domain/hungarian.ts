// 方陣最小成本指派（Kuhn-Munkres，O(n^3)）。回傳 assignment[row] = column。
// 掃描糾錯時用來把 8 個角塊 / 12 個邊塊分配到位置上，讓總顏色誤差最小。
export function solveAssignment(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const owner = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);

  for (let row = 1; row <= n; row += 1) {
    owner[0] = row;
    let column0 = 0;
    const minValue = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(n + 1);

    do {
      used[column0] = 1;
      const row0 = owner[column0];
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= n; column += 1) {
        if (used[column]) continue;
        const reduced = cost[row0 - 1][column - 1] - u[row0] - v[column];
        if (reduced < minValue[column]) {
          minValue[column] = reduced;
          way[column] = column0;
        }
        if (minValue[column] < delta) {
          delta = minValue[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= n; column += 1) {
        if (used[column]) {
          u[owner[column]] += delta;
          v[column] -= delta;
        } else {
          minValue[column] -= delta;
        }
      }
      column0 = column1;
    } while (owner[column0] !== 0);

    do {
      const column1 = way[column0];
      owner[column0] = owner[column1];
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let column = 1; column <= n; column += 1) {
    if (owner[column] > 0) assignment[owner[column] - 1] = column - 1;
  }
  return assignment;
}
