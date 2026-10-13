import type { FaceMove, MoveToken } from "./moves";

export interface Lesson {
  id: string;
  title: string;
  label: string;
  body: string;
  focusFaces: FaceMove[];
  practice: MoveToken[];
}

export const LESSONS: Lesson[] = [
  {
    id: "white-cross",
    title: "白色十字",
    label: "先找白色邊塊",
    body: "把白色邊塊送到白色中心旁邊。一次只看一塊，慢慢轉到正確位置。",
    focusFaces: ["U", "F", "R"],
    practice: ["F", "R", "U", "R'", "U'"],
  },
  {
    id: "first-layer",
    title: "第一層角塊",
    label: "角塊回家",
    body: "找到有白色的角塊，把它放到目標角落下方，再用短短四步送上去。",
    focusFaces: ["U", "R", "F"],
    practice: ["R", "U", "R'", "U'"],
  },
  {
    id: "middle-layer",
    title: "第二層邊塊",
    label: "不要動到白色面",
    body: "找沒有黃色的邊塊，先對齊中心色，再送到左邊或右邊的空位。",
    focusFaces: ["F", "R", "L"],
    practice: ["U", "R", "U'", "R'", "U'", "F'", "U", "F"],
  },
  {
    id: "yellow-cross",
    title: "黃色十字",
    label: "看上面形狀",
    body: "上面可能是點、L、直線或十字。照著提示轉，讓黃色十字慢慢出現。",
    focusFaces: ["U", "F"],
    practice: ["F", "R", "U", "R'", "U'", "F'"],
  },
  {
    id: "yellow-face",
    title: "黃色整面",
    label: "讓黃色翻上來",
    body: "先不用管旁邊顏色，只要把每個黃色角塊轉到上面。",
    focusFaces: ["U", "R"],
    practice: ["R", "U", "R'", "U", "R", "U2", "R'"],
  },
  {
    id: "finish",
    title: "最後一圈",
    label: "換位置完成",
    body: "最後把角塊和邊塊換到正確位置。卡住時可以按提示，讓系統帶你下一步。",
    focusFaces: ["U", "R", "F"],
    practice: ["R", "U'", "R", "U", "R", "U", "R", "U'", "R'", "U'", "R2"],
  },
];
