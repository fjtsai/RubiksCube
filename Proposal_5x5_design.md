# 5x5 魔術方塊設計提案

日期：2026-05-10

## 目標

在目前的 Vite + TypeScript + Three.js PWA 專案上，擴充一個適合小朋友在手機瀏覽器遊玩的 5x5 魔術方塊模式。重點不是只把 3x3 放大，而是提供清楚、順手、可教學的 5x5 體驗：

- 手機觸控可以穩定轉動外層、內層與 wide moves。
- 3D 視覺要有接近真實魔術方塊的厚度、層次、轉動慣性與 snap 動畫。
- 教學要採用 5x5 常見 reduction beginner method，而不是沿用 3x3 beginner method。
- 自動解功能要分階段設計：先做到教學式 reduction 播放，再評估完整 5x5 solver。

## 網路研究結論

目前有現成的 GitHub 專案可以參考，但沒有一個能直接滿足「兒童向手機 PWA + 5x5 真實手感 + 教學判斷 + 自動解」的完整需求。建議採取「參考成熟專案能力，保留目前專案主架構」的策略。

| 專案 | 用途 | 優點 | 風險與限制 | 建議 |
| --- | --- | --- | --- | --- |
| [Sina247/Rubik-Cube-Solver](https://github.com/Sina247/Rubik-Cube-Solver) | 5x5 Three.js UI 參考 | README 明確支援 2x2、3x3、4x4、5x5；有 touch、responsive；MIT 授權 | 專案很新、commit 少、stars 少，成熟度未知 | 可 clone 審查 UI 與觸控邏輯，不建議直接作為主架構 |
| [cubing/cubing.js](https://github.com/cubing/cubing.js) | twisty puzzle 顯示、notation、演算法播放 | 官方 TwistyPlayer 支援 5x5x5；TypeScript/npm 友善；活躍且專業 | 深度客製手機手感與兒童 UI 仍要自己包裝；修改本體需注意授權 | 最值得整合或做技術參考 |
| [godlikemouse/jquery.cube.threejs.js](https://github.com/godlikemouse/jquery.cube.threejs.js) | NxN layer turn 觀念參考 | 支援 2x2 到約 9x9；有 move API | jQuery、舊 Three.js、GPL 授權，不適合直接整合 | 只作演算法與資料結構參考 |
| [dwalton76/rubiks-cube-NxNxN-solver](https://github.com/dwalton76/rubiks-cube-NxNxN-solver) | 5x5/NxN solver 研究 | 可解任意尺寸，README 說測到 17x17x17；MIT 授權 | Python、lookup tables、需 kociemba，較適合後端，不適合直接跑在手機 worker | 後續若要完整 5x5 自動解，可考慮做後端 solver service |
| [ldez/cubejs](https://github.com/ldez/cubejs) | 目前 3x3 solver | MIT、瀏覽器可用、Kociemba two-phase | 官方定位是 3x3x3，不能直接解 5x5 | 只保留給 3x3 模式 |

## 核心判斷

5x5 的技術問題與 3x3 不同。3x3 可以直接用 cubejs 從 54 facelets 求解；5x5 需要處理中心塊、邊塊配對、reduction、parity，最後才變成類 3x3 問題。

因此，5x5 模式不能只做：

- 把 3x3 cubelets 從 27 顆改成 125 顆。
- 沿用 cubejs solver。
- 沿用 3x3 beginner coach 判斷。

正確設計應拆成：

1. 5x5 3D 表現與 layer move engine。
2. 5x5 狀態模型與 notation。
3. 5x5 reduction beginner method 教學判斷。
4. 教學式逐步播放。
5. 完整自動解 solver，獨立評估是否放前端或後端。

## 建議架構

### 1. 視覺與互動層

保留目前 Three.js 場景架構，將 3x3 cube renderer 抽象成 NxN renderer。

5x5 可見 cubelets 數量：

```text
5^3 - 3^3 = 98
```

每個 cubelet 保存：

- grid position: `x, y, z`，範圍 `-2..2`
- visible stickers
- current transform
- cubie id
- facelet color mapping

轉動需支援：

- 外層：`U D L R F B`
- 內層 slice：例如第二層 inner moves
- wide moves：例如 `Rw`, `Uw`, `Fw`
- 180 度：`R2`, `Rw2`
- 反向：`R'`, `Rw'`

手機操作建議：

- 單指拖曳方塊表面：轉動命中的那一層。
- 單指從空白處拖曳：旋轉整顆方塊視角。
- 雙指：縮放或調整視角。
- 點選「外層 / 寬層 / 內層」模式，降低小朋友誤操作。
- 每次轉動都要 snap 到 90 度，動畫中鎖定新輸入或排隊。

### 2. 狀態模型

5x5 不應直接用 3D mesh 當唯一狀態來源。需要建立獨立 domain model：

```ts
type CubeSize = 3 | 4 | 5;

type Face = "U" | "R" | "F" | "D" | "L" | "B";

interface NxNCubeState {
  size: CubeSize;
  stickers: Record<Face, string[]>;
  history: string[];
}
```

3D 畫面只負責呈現與動畫，真正判斷教學進度、是否完成、是否可解，全部以 `NxNCubeState` 為準。

### 3. 5x5 beginner method 教學判斷

5x5 beginner reduction 教學建議階段：

1. 白色中心：完成 3x3 白中心。
2. 黃色中心：完成相對面的 3x3 黃中心。
3. 其餘四個中心：依配色順序完成紅、藍、橘、綠中心。
4. 邊塊配對：12 組邊，每組 3 個 edge wing 合成一條完整邊。
5. Reduction complete：中心完成且 12 條邊都配對。
6. 進入 3x3 模式：把每條 5x5 邊視為一條 3x3 邊。
7. 3x3 beginner method：白十字、白角、第二層、黃十字、OLL、PLL。
8. 5x5 parity 提示：若 reduction 後出現特殊狀態，進入 parity 教學。

教學判斷要做到「狀態感知」，不是只顯示固定文字：

- 能判斷目前哪個中心還沒完成。
- 能判斷某條邊是否已配對。
- 能指出下一個推薦目標，例如「先把白色中心補成 3x3」。
- 能用高亮 sticker 指引孩子看哪一塊。
- 能在錯誤操作後重新判斷，不依賴固定步驟序列。

### 4. 自動解策略

短期不建議承諾「任意 5x5 狀態一鍵最短自動解」。原因：

- 5x5 狀態空間大。
- reduction solver 需要大量規則與 lookup tables。
- 前端手機 worker 執行可能造成效能與電量問題。

建議分三階段：

#### 階段 A：教學式自動播放

系統提供預先設計好的範例 scramble，並播放 reduction beginner method 的示範步驟。這適合兒童學習，也最穩定。

#### 階段 B：半自動提示

根據目前狀態判斷下一個教學目標，給 1 到 3 個可執行 move suggestion。目標不是最佳解，而是讓孩子知道下一步該觀察哪裡。

#### 階段 C：完整 5x5 solver

若要完整自動解，可以評估兩條路：

- 後端 solver service：包裝 dwalton76 的 Python NxNxN solver。
- 前端 solver：自行實作 reduction search，但工程量高，不建議第一版做。

## 推薦實作路線

### Milestone 1：5x5 visual prototype

目標：畫出 5x5，支援基本外層轉動。

工作項目：

- 將 `RubiksScene` 改成可接受 `size=3 | 5`。
- 產生 98 顆 visible cubelets。
- 調整 camera framing，讓手機直向也能看清 5x5。
- 完成外層 `U D L R F B` 動畫與 snap。

驗收：

- 5x5 可以穩定顯示。
- 外層轉動後 facelet state 與 3D 畫面一致。
- 手機上 60fps 或接近 60fps，低階手機至少不明顯卡頓。

### Milestone 2：5x5 手機操作

目標：讓小朋友可以順手轉 5x5。

工作項目：

- 表面 raycast 命中 sticker/cubelet。
- 判斷拖曳方向與 layer index。
- 加入外層、寬層、內層切換。
- 加入 undo、redo、reset、scramble。

驗收：

- 單指可以穩定轉指定層。
- 誤觸率低。
- 動畫中輸入不會造成狀態錯亂。

### Milestone 3：5x5 狀態模型

目標：建立 5x5 可驗證狀態。

工作項目：

- 實作 `NxNCubeState`。
- 實作 5x5 move parser。
- 實作外層、內層、wide moves 對 stickers 的 permutation。
- 建立測試：move + inverse 必須回到原狀，四次同 move 必須回到原狀。

驗收：

- 所有基本 move 符合預期。
- 視覺狀態與 domain state 一致。
- 可輸出 5x5 facelet/state 字串供 solver 或教學使用。

### Milestone 4：5x5 beginner reduction 教學

目標：真正判斷 5x5 教學階段。

工作項目：

- 中心完成判斷。
- 邊塊配對判斷。
- reduction complete 判斷。
- 3x3 projection 判斷。
- UI 顯示下一個目標、高亮 sticker、逐步提示。

驗收：

- 任意操作後教學狀態能重新計算。
- 不依賴固定線性腳本。
- 孩子能看懂下一步該做哪個小目標。

### Milestone 5：5x5 自動解研究整合

目標：決定完整自動解的實作方式。

工作項目：

- 審查 dwalton76 solver 的輸入格式、輸出 move notation、lookup table 需求。
- 評估是否部署後端 solver service。
- 評估 Cloudflare tunnel / server side process 是否適合承載 solver。
- 若採後端，設計 `/api/solve/5x5`。

驗收：

- 能對指定 5x5 state 回傳可播放 move list。
- move list 可在前端 5x5 3D 畫面正確執行到 solved。
- 有 timeout 與錯誤提示。

## 風險

### 效能風險

5x5 需要 98 顆 cubelets、更多 sticker 材質與 raycast 判斷。若每個 sticker 都是獨立 mesh，手機可能吃力。建議：

- 優先 merge geometry 或限制 raycast 目標。
- 材質共用。
- 降低 shadow 成本。
- 動畫時只更新 rotating group。

### 操作風險

5x5 層數多，小朋友容易轉錯內層。建議：

- 預設只開外層與 wide moves。
- 內層模式需要明確切換。
- 被選中的 layer 要有亮框或 glow。
- 提供大按鈕 undo。

### Solver 風險

完整 5x5 solver 不應與第一版 5x5 UI 綁死。若先做 solver，容易拖慢整個功能交付。建議先完成可玩、可教、可驗證，再接完整 solver。

## 最終建議

5x5 第一版應走「可玩 + 可教」路線，不要一開始就追求任意狀態完整自動解。

我建議採用以下策略：

1. 保留目前 Vite + TypeScript + Three.js PWA。
2. 將現有 3x3 scene 抽象成 NxN scene。
3. 參考 `cubing.js` 的 notation、5x5 顯示能力與演算法播放設計。
4. 參考 `Sina247/Rubik-Cube-Solver` 的 5x5 UI 與 touch 設計，但不直接搬架構。
5. 先做 5x5 reduction beginner method 教學判斷。
6. 完整 5x5 自動解另外規劃為後端 solver service 或第二階段前端 solver。

下一步可執行項目：

1. 新增 `CubeSize` 與 NxN state model。
2. 將 3D cube generation 改成支援 `size=5`。
3. 新增 5x5 模式切換 UI。
4. 實作 5x5 外層轉動。
5. 實作 move/inverse 測試，確認 3D 與 state 不會再出現視覺和 solver 脫節。

## 目前實作進度

更新日期：2026-05-10

已完成：

- 遊戲預設進入 3x3。
- 底部選單新增「尺寸 3x3 / 5x5」切換。
- 支援 `?v=5x5`、`?cube=5x5`、`?size=5x5` 直接打開 5x5，方便測試與分享。
- 5x5 3D renderer 已能產生 98 顆可見 cubelets。
- 5x5 支援外層 move：`U D L R F B`。
- 5x5 支援 wide move：`Uw Rw Fw Dw Lw Bw`，含逆轉與半圈。
- 5x5 支援內層單層 move：`2U 2R 2F 2D 2L 2B`，含逆轉與半圈。
- 5x5 打亂會混用外層與 wide moves。
- 5x5 自動解目前是「反向播放歷史步驟」，可保證回到目前練習起點，但還不是任意狀態 reduction solver。
- 5x5 教學目前會真實判斷六個 3x3 中心區域完成度。
- 5x5 教學會判斷 12 條邊是否已配對。
- 5x5 教學會高亮下一個中心或下一條邊。
- 5x5 reduction complete 後會投影成 3x3 facelets，並接到既有 3x3 beginner method 教學流程。
- 新增 `projectFiveByFiveToThreeByThree()`。
- 新增 `validateProjectedThreeByThree()`，會檢查 3x3 投影的顏色數量、中心、角塊/邊塊唯一性、方向和與 corner/edge parity。
- 3x3 投影無效時會顯示 5x5 parity 教學狀態，不會把無效狀態送進 3x3 教學。
- parity 狀態會提供一組 5x5 parity 練習手法：`Rw2 F2 U2 2R2 U2 F2 Rw2`。
- 5x5 reduction complete 且 3x3 投影合法後，操作列會鎖定為外層 moves，隱藏 `Uw/Rw/2R` 這類會打散 reduction 的操作。
- PWA service worker 已更新到 `kids-rubiks-cube-v8`，公開站可載入新版。

已驗證：

- 一般進入 `https://cube.heliacore.com/` 預設為 3x3。
- `https://cube.heliacore.com/?v=5x5` 會直接顯示 5x5。
- 5x5 facelets 長度為 150。
- `Rw` 後會變亂，按自動解可回到 solved。
- 5x5 共 54 組外層、wide、內層 move + inverse 測試皆可回到 solved。
- 5x5 打亂後進入教學模式，會顯示中心進度與高亮目前目標。
- solved 5x5 進入教學模式時，會顯示 `5x5 轉 3x3 · 完成`。
- reduction complete 後外層 `R` 會進入既有 3x3 白色十字教學；提示可給出外層 `R'` 並回到 solved。
- reduction complete 後公開站操作列只顯示 `U U' R R' F F' D D' L L' B B'`，不再顯示 `Rw` 或 `2R`。

下一步：

- 評估完整 5x5 solver service。
- 補完整 parity 手法播放與兒童化步驟提示。
