# TODO: 3D Solver App 相機掃描升級規劃

目標：在目前 Vite + TypeScript + Three.js + PWA 的魔方遊戲中，新增「用手機後鏡頭掃描實體 3x3 魔方，協助玩家求解」功能。

目前專案已具備 3D 方塊互動、`cubejs` solver、Web Worker、PWA 與教學模式。主要缺口是：掃描實體魔方後，如何把 6 面貼紙狀態轉成合法的 54 格 facelet string，並同步到 3D 場景與 solver。

## 原則

- 第一版以 3x3 為主。5x5 掃描先不納入 MVP。
- 可靠解法需要 6 面完整狀態；「只拍幾面」只能做輔助提示，不能穩定求完整解。
- 相機辨識必須搭配手動校正，避免光線、反光、紅橘混淆、白黃過曝導致錯誤。
- 先完成「手動匯入 facelet string」與 solver 串接，再做相機 UI，降低除錯成本。
- 保留 PWA 架構，不改成原生 App。

## 目前程式現況

- `src/main.ts`
  - UI、模式切換、PWA、localStorage、solver worker 串接。
  - 目前 solver 以 `history` 轉成 algorithm 求解。
- `src/solver.worker.ts`
  - 已接受 `{ type: "solve", algorithm }` 與 `{ type: "solveFacelets", facelets }`。
  - 已支援直接用 54 格 facelet string 求解。
- `src/game/rubiks-scene.ts`
  - 已有 `getFaceletString()` 匯出目前 3D 狀態。
  - 已有 `setFaceletString(raw)` 將外部狀態匯入 3D 場景。
- `src/domain/cube-state.ts`
  - 已有 `snapshotFromString()` 與 `Cube.fromString()` 相關基礎能力。
- `src/domain/five-by-five-reduction.ts`
  - 已有 3x3 投影合法性驗證邏輯可參考，但 3x3 掃描需要獨立驗證模組。

## 目標使用流程

1. 玩家按「掃描」。
2. App 開啟手機後鏡頭。
3. App 要求依序掃描六面：上、右、前、下、左、後。
4. 每面畫面顯示 3x3 對位框。
5. 玩家拍下該面，系統辨識 9 格顏色。
6. 玩家可手動修正判錯的格子。
7. 掃描完成後，系統驗證 54 格狀態是否合法。
8. 若合法，匯入 3D 魔方並計算解法。
9. 玩家可用「提示 / 一步 / 自動解」照現有流程解實體魔方。

## 階段 0：基礎驗證與資料契約

- [x] 定義 3x3 facelet string 格式文件
  - 順序固定為 `U R F D L B`。
  - 每面 9 格，總長 54。
  - 每格值只能是 `U R F D L B`。
- [x] 新增掃描資料型別
  - 建議檔案：`src/domain/scanner-state.ts`
  - 型別：
    - `ScanFace = "U" | "R" | "F" | "D" | "L" | "B"`
    - `ScanColor = ScanFace`
    - `ScannedFace = { face: ScanFace; stickers: ScanColor[] }`
    - `ScanResult = { raw: string; faces: Record<ScanFace, ScanColor[]> }`
- [x] 新增 3x3 狀態驗證模組
  - 建議檔案：`src/domain/three-by-three-validation.ts`
  - 驗證項目：
    - 長度是否 54。
    - 字元是否只含 `URFDLB`。
    - 每色是否剛好 9 格。
    - 中心格是否符合 `U/R/F/D/L/B`。
    - 角塊組合是否合法。
    - 邊塊組合是否合法。
    - 角塊方向、邊塊方向與 parity 是否合法。
  - 可參考 `src/domain/five-by-five-reduction.ts` 的 `validateProjectedThreeByThree()`。
- [ ] 加入單元測試或最小測試資料
  - solved cube 應合法。
  - 顏色數量錯誤應失敗。
  - 中心方向錯誤應失敗。
  - 重複角塊 / 邊塊應失敗。

## 階段 1：solver 支援直接解掃描狀態

- [x] 擴充 `src/solver.worker.ts` request 型別
  - 現有：`{ type: "solve"; algorithm: string }`
  - 新增：`{ type: "solveFacelets"; facelets: string }`
- [x] 在 worker 中使用 `Cube.fromString(facelets).solve()`
  - 實作前需用目前 `cubejs` 版本確認 API 行為。
  - 若 `Cube.fromString()` 對非法狀態丟錯，錯誤訊息要回傳 UI。
- [x] 擴充 `src/main.ts` 的 `SolverResponse`
  - 支援掃描狀態求解結果。
- [x] 新增 / 整合 facelet string 求解流程
  - 不依賴 `history`。
  - 先跑 validation，再送 worker。
- [x] 保留原本 `history` 求解流程
  - 避免影響既有自由玩、打亂、復原、教學功能。

## 階段 2：3D 場景匯入外部狀態

- [x] 設計 `RubiksScene.setFaceletString(raw: string)`
  - 目標：將掃描到的 54 格狀態顯示在 3D 魔方上。
  - 注意：目前 `RubiksScene` 的貼紙顏色是跟 cubelet 物件旋轉後的位置一起推導，沒有現成任意狀態匯入。
- [x] 評估兩種做法
  - 做法 A：建立 solved cube 後，用 cubie permutation/orientation 重建 cubelets。
  - 做法 B：保留幾何位置，只更新每個外露 sticker 的 `userData.face` 與材質顏色。
- [x] MVP 建議先採做法 B
  - 足以視覺化掃描狀態。
  - 不必在第一版支援掃描狀態後繼續任意拖曳轉層的完整 cubie 正確性。
  - 若匯入後要繼續互動轉動，需確認 `applyMove()` 後 `getFaceletString()` 仍然正確。
- [x] 匯入掃描狀態後清空 `history`
  - 掃描狀態不是由遊戲內 move history 產生。
  - 新增一個 `externalFacelets` 或 `sourceState` 變數，讓 solver 知道目前不是 history 模式。
- [x] 更新 localStorage 策略
  - 可新增 `kids-rubiks.facelets.scanned`。
  - 若存在 scanned facelets，還原時應走 `setFaceletString()`，不是 `applyAlgorithm(history)`。

## 階段 3：先做手動匯入 UI

目的：在相機辨識前，先完成「外部狀態 -> 驗證 -> solver -> UI」的主鏈路。

- [x] 新增「匯入」或「掃描」入口按鈕
  - 手機上可放在 top actions 或 control dock 延伸面板。
- [x] 新增 facelet string 輸入 modal
  - 可貼上 54 字元。
  - 顯示格式提示：`UUUUUUUUURRRRRRRRR...`
- [x] 驗證輸入
  - 成功：匯入 3D 場景，切換到求解模式，顯示下一步。
  - 失敗：顯示明確錯誤，例如「R 顏色只有 8 格，應為 9 格」。
- [x] 加入「套用 solved cube」測試按鈕
  - 方便開發時確認流程。
- [ ] 手動測試
  - solved cube 匯入後應顯示已完成。
  - 合法 scramble facelets 匯入後可算出解法。
  - 非法 facelets 不應送 solver。

## 階段 4：相機掃描 UI

- [x] 新增 deterministic 測試照片
  - `public/test-scans/scan-U.svg` 到 `scan-B.svg`。
  - 使用一組合法 scramble，方便不用實體魔方也能測掃描主流程。
- [x] 新增 scanner overlay
  - `video` 顯示相機畫面。
  - `canvas` 或 CSS overlay 顯示 3x3 對位框。
  - 顯示目前要掃的面：`U/R/F/D/L/B` 與中文說明。
- [x] 使用手機後鏡頭
  - `navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } })`
  - 需要 HTTPS 或 localhost。
- [x] 支援瀏覽器權限錯誤
  - 沒權限：提示玩家開啟相機權限。
  - 無相機：退回手動匯入。
  - 非安全來源：提示需 HTTPS 或 localhost。
- [x] 每面拍攝流程
  - 對齊 3x3 框。
  - 按「拍這面」。
  - 從 video frame 擷取 canvas。
  - 取 9 個 sampling point。
  - 顯示辨識結果供確認。
  - 拍完第 6 面且狀態合法時，自動匯入 3D 圖案並求解。
- [x] 六面自動順序與方向推斷
  - 使用中心色作為六個顏色基準。
  - 先嘗試目前拍攝順序的 4 種面旋轉。
  - 再嘗試六張照片的所有面順序與旋轉組合，找出合法 3x3 狀態。
  - 找到合法狀態後自動重建成 `U R F D L B` facelet string。
- [x] 掃描控制
  - 上一步。
  - 重拍本面。
  - 取消掃描。
  - 完成後進入校正畫面。
  - 已完成：上一步、重拍、取消、掃描分類預覽、手動套用、合法時自動匯入。

## 階段 5：顏色辨識

- [x] 新增顏色擷取模組
  - 建議檔案：`src/domain/color-sampling.ts`
  - 從 canvas 的 9 個區塊取平均色或中位數色。
  - 避開格線邊緣，取每格中央小範圍。
- [x] 新增色彩正規化
  - RGB -> HSV 或 Lab。
  - 初版已採 Lab 距離分類。
  - 白色以高亮低飽和判斷。
  - 黃色以 hue 與 brightness 判斷。
- [x] 用中心格建立校正表
  - 每面中心色代表該面的目標色。
  - 掃完 6 面後，以 6 個中心樣本作最近色匹配。
- [x] 新增信心分數
  - 顏色距離太近時標示為低信心。
  - 低信心格在校正 UI 中高亮。
- [ ] 常見混淆處理
  - 紅 / 橘。
  - 白 / 黃。
  - 綠 / 藍在暗光下偏移。

## 階段 6：手動校正 UI

- [x] 新增 6 面展開圖
  - 顯示 U/R/F/D/L/B 六個 3x3 grid。
  - 每格可點選修改顏色。
- [x] 新增顏色選擇器
  - 6 個色票：白、紅、綠、黃、橘、藍。
  - 色票對應 `U/R/F/D/L/B`，不是直接儲存 hex。
- [x] 鎖定中心格
  - 中心格不應被任意改成其他面，除非進入進階校正。
- [x] 顯示即時驗證結果
  - 顏色數量。
  - 中心方向。
  - 合法性。
- [x] 提供修正提示
  - 例如「橘色有 10 格，紅色有 8 格，可能有一格紅橘判錯」。
- [x] 完成後才允許「套用並求解」。

## 階段 7：求解與教學整合

- [x] 匯入掃描狀態後切換為 solve mode
  - `nextMoveText` 顯示第一步。
  - `solutionQueue` 使用掃描狀態求出的解法。
- [x] 「提示」按鈕
  - 若目前是 external facelets 模式，提示應用掃描狀態 solver。
  - 若玩家在 3D 內執行一步後，要更新 external facelets 或轉回 history-like state。
- [x] 「一步」按鈕
  - 播放一步 3D 動畫。
  - 更新目前 facelet state。
  - 從 solutionQueue 移除該步。
- [ ] 「自動解」按鈕
  - 播放掃描狀態解法。
  - 完成後清除 external facelets。
- [ ] 教學模式
  - 第一版可先不讓掃描狀態直接進入 beginner coach。
  - 後續可用 `evaluateBeginnerCoachFromString(raw)` 支援。

## 階段 8：PWA 與手機體驗

- [ ] 確認相機在已安裝 PWA 中可用
  - Android Chrome。
  - iOS Safari / iOS installed web app。
- [x] 加入安全來源提醒
  - production 必須 HTTPS。
  - dev 可用 localhost。
- [x] 掃描 overlay 需處理 safe area
  - iPhone 瀏海。
  - 底部 home indicator。
- [ ] 橫向與直向測試
  - 建議第一版鎖定直向 UX。
- [x] 相機資源釋放
  - 關閉 scanner 時停止所有 media tracks。
  - 切換頁面或取消時也要釋放。

## 階段 9：測試計畫

- [x] TypeScript build
  - `npm run build`
- [ ] Solver worker 測試
  - solved facelets。
  - 已知 scramble facelets。
  - 非法 facelets。
- [ ] UI 手動測試
  - 3x3 原本拖曳、打亂、提示、一步、自動解仍可用。
  - 5x5 原本模式不受影響。
  - 掃描流程取消後不影響原本遊戲。
- [ ] 手機實機測試
  - Android Chrome 後鏡頭。
  - iOS Safari 後鏡頭。
  - 低光源。
  - 白桌面、彩色背景、反光貼紙。
- [ ] 回歸測試
  - localStorage 舊資料能正常載入。
  - service worker 不快取壞掉的舊 scanner bundle。

## 建議檔案拆分

- `src/domain/three-by-three-validation.ts`
  - 3x3 facelet legality validation。
- `src/domain/scanner-state.ts`
  - scanner 型別、face 順序、facelet string 組裝。
- `src/domain/color-sampling.ts`
  - canvas sampling 與顏色正規化。
- `src/domain/color-classifier.ts`
  - 顏色分類、中心色校正、信心分數。
- `src/ui/scanner-overlay.ts`
  - 相機 overlay、拍攝流程。
- `src/ui/facelet-editor.ts`
  - 6 面手動校正 UI。
- `src/solver.worker.ts`
  - 新增 `solveFacelets`。
- `src/game/rubiks-scene.ts`
  - 新增 `setFaceletString()` 或等價匯入 API。
- `src/main.ts`
  - 串接入口、模式狀態、localStorage、solver queue。

## MVP 完成定義

- [ ] 手機瀏覽器可以開後鏡頭。
- [ ] 玩家能依序拍 6 面 3x3 魔方。
- [ ] 系統能產生 54 格 facelet string。
- [ ] 玩家能修正辨識錯誤。
- [ ] 合法狀態可以送 solver，並得到下一步。
- [ ] 3D 畫面能顯示掃描狀態或至少能播放解法步驟。
- [ ] 原本遊戲功能不退化。
- [ ] `npm run build` 通過。

## 暫不處理

- [ ] 只拍 2 到 3 面就完整求解。
- [ ] 5x5 實體掃描。
- [ ] 全自動即時追蹤魔方旋轉。
- [ ] 用 AI 模型辨識每格，不做手動校正。
- [ ] 原生 App 封裝。

## 主要風險

- 顏色辨識準確度不足。
- 玩家掃描面順序錯誤。
- 實體魔方配色與專案內 `U/R/F/D/L/B` 預設方向不同。
- 掃描狀態匯入 3D 後，若仍允許互動轉層，內部 cubie orientation 可能與視覺貼紙不一致。
- iOS Safari 對 PWA 相機權限與生命周期處理較嚴格。

## 建議實作順序

1. `three-by-three-validation.ts`
2. `solver.worker.ts` 加 `solveFacelets`
3. 手動 facelet string 匯入 UI
4. `RubiksScene.setFaceletString()`
5. scanner overlay + getUserMedia
6. canvas color sampling
7. 手動校正 UI
8. 手機實機測試與 UX 修正
