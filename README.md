# 魔方小玩家

手機瀏覽器優先的 3D Rubik's Cube PWA，給小朋友用拖曳手感遊玩、看提示、逐步解、自動解，也能用相機掃描手上的實體魔方找解法。

## 功能

- Vite + TypeScript + Three.js 模組化架構，3x3 與 5x5
- **跟手轉層**：手指按住任一格往旁邊拖，那一排會即時跟著轉，放開時轉超過 1/3 格就完成、不夠就彈回；輕甩也能轉。外層、5x5 第二層、**正中間切片（M/E/S）** 都能拖
- 手勢把拖曳投影到被按住那一面的「面內方向」判斷軸向與角度，角落貼紙、斜角視角、從底部看都不會判錯
- 視角：拖曳空白處或**兩指滑動**旋轉（轉盤式，不會越轉越歪）、兩指捏合縮放、點兩下空白處回正
- 方塊自動置中、貼合 HUD 與控制區之間的可用空間；手機直立／橫放、平板、桌機各有版面
- **轉動按鈕面板**：外層 / 第二層 / 正中間 / 外兩層分頁，連點會排隊依序轉
- 提示會在方塊上畫出**轉動方向箭頭**；解題模式有步驟卡，照著轉會自動前進，轉錯會提示重新計算
- 完成時有慶祝畫面、步數與計時
- 中間層會帶著中心換位：教學、驗證、求解都先把整顆轉回「白上綠前」的標準方向再判斷，結果再換回目前畫面上的面
- `cubejs` solver 放在 Web Worker，避免阻塞 3D 互動
- Beginner method 教學判斷：白色十字、第一層、第二層、黃色十字、黃色整面、最後一圈；5x5 中心 → 邊塊 → parity → 當 3x3 解
- 只在有變化時重繪，閒置時不耗電
- PWA manifest、service worker、離線快取與安裝提示；localStorage 保留進度與設定

## 相機掃描實體魔方

1. 對位框跟取樣範圍完全一致：相機畫面用 `object-fit: cover` 鋪滿螢幕，取樣時把框線在螢幕上的位置換算回影片像素（以前直立手機拿到橫向串流時，取樣範圍會比框線大將近一倍）
2. 拍之前框內每一格即時顯示辨識到的顏色，可選「自動拍」（畫面穩定且是還沒拍過的面就自動拍下）
3. 六面可用任意順序、任意方向拍；依中心色決定是哪一面、自動試每面四種旋轉
4. 顏色分群會替每張照片估計 RGB 增益，抵銷各自的自動曝光與白平衡
5. **最大概似糾錯**：用指派演算法把 8 角 12 邊放到位置上，再修正角塊方向、邊塊方向與 parity，得到「與照片差距最小的合法魔方」。單格紅橘、白黃判錯會被自動修正並在確認畫面用虛線標出
6. 確認畫面可點格子改色、點照片重拍某一面，再一鍵開始解題

## 開發

```bash
npm install
npm run dev -- --port 5173
```

打開 `http://localhost:5173/`，5x5 用 `/?cube=5`。

## 驗證

- 型別檢查：`npx tsc`
- 顏色管線：開 dev server 後瀏覽 `/dev-tests/color-test.html`（合成含 logo、反光、曝光變化、任意順序/旋轉、框線偏移的照片，頁面顯示 ALL PASS）
- 端到端：`node dev-tests/e2e/run.mjs http://localhost:5173`（手勢含中間層、觸控雙指、主要流程、合成相機掃描、持久化、顏色頁、閒置重繪）。可只跑部分：`... gestures camera`
- DEV 模式的 `window.__rubiksDebug` 提供 `stickerScreenPoint`、`history`、`facelets`、`plan`、`isBusy`、`renderCount` 等掛鉤

## 建置

```bash
npm run build
npm run preview
```

`dist/` 是可部署的靜態站。注意：本機的 `rubiks-cube.service`（`serve_game.py`，port 9983）直接服務 `dist/`，`npm run build` 會立即更新線上版本。只想驗證建置時可用 `npx vite build --outDir <其他資料夾>`。service worker 只會在 production build 中註冊。

## 結構

- `src/game/rubiks-scene.ts`：Three.js 場景、跟手轉層、雙指視角、轉動佇列、方向箭頭、按需重繪
- `src/ui/scanner-ui.ts`：相機掃描介面（即時預覽、自動拍、確認與修正畫面）
- `src/ui/icons.ts`：內嵌 SVG 圖示
- `src/main.ts`：UI、模式、解題步驟、轉動按鈕面板、PWA、localStorage、solver 串接
- `src/domain/moves.ts`：move notation（含 M/E/S、5x5 的 2X / Xw）、打亂、反向與合併步驟
- `src/domain/cube-geometry.ts`：NxN 貼紙幾何、24 種整顆轉動、轉回標準方向與步驟對應
- `src/domain/color-sampling.ts`：取樣範圍換算、每格中心＋外圈 9 區塊中位數取色（排除 logo 與反光）
- `src/domain/color-classifier.ts`：顏色分群、每張照片的曝光校正、中心色命名、即時預覽用的單格判色
- `src/domain/scan-reconstruction.ts`：六面方向搜尋與最大概似糾錯
- `src/domain/hungarian.ts`：最小成本指派
- `src/domain/beginner-coach.ts`、`five-by-five-reduction.ts`：教學判斷
- `src/solver.worker.ts`：cubejs 初始化與解法計算
- `public/sw.js`：離線快取
- `dev-tests/`：顏色管線驗證頁與端到端測試
