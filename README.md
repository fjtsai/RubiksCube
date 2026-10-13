# 魔方小玩家

手機瀏覽器優先的 3D Rubik's Cube PWA 原型，給小朋友用拖曳手感遊玩、看提示、逐步解或自動解。

## 功能

- Vite + TypeScript + Three.js 模組化架構
- 3D 圓角 cubelet、貼紙材質、陰影與手機友善全螢幕場景
- 觸控/滑鼠拖曳轉層（3x3 外層與 5x5 內層切片 `2U`/`2R`/... 都可拖），空白處拖曳旋轉視角
- 手勢把拖曳向量反投影回被按住的面，在方塊座標系判斷行列與方向，不受視角影響；想轉某一面本身時，改拖相鄰面靠該面的那一排
- 快速轉面按鈕、打亂、復原、提示、一步、自動解
- `cubejs` solver 放在 Web Worker，避免阻塞 3D 互動
- Beginner method 教學判斷：讀取 54 格貼紙狀態，分辨白色十字、第一層、第二層、黃色十字、黃色整面與最後一圈
- 教學模式會顯示目前階段、完成度、焦點面，並搜尋不破壞前面成果的短練習序列
- PWA manifest、service worker、離線快取與安裝提示
- localStorage 保留上次方塊進度與音效設定

## 開發

```bash
npm install
npm run dev -- --port 5173
```

打開 `http://localhost:5173/`。

## 建置

```bash
npm run build
npm run preview
```

`dist/` 是可部署的靜態站。service worker 只會在 production build 中註冊，避免開發時被舊快取干擾。

## 結構

- `src/game/rubiks-scene.ts`：Three.js 場景、cubelet 建立、拖曳轉層、動畫 snap
- `src/solver.worker.ts`：cubejs 初始化與解法計算
- `src/domain/cube-state.ts`：從 move history 建立 54 格貼紙狀態
- `src/domain/beginner-coach.ts`：beginner method 階段判斷、進度評分、短序列建議
- `src/domain/moves.ts`：move notation、打亂、反向步驟
- `src/domain/lessons.ts`：兒童教學流程
- `src/domain/color-sampling.ts`：相機/照片取樣，每格取中心＋外圈 9 個區塊，用中位數＋內群平均排除貼紙上的品牌 logo 與反光
- `src/domain/color-classifier.ts`：以中心格起始的基準色迭代修正（洗掉 logo 色偏），再依「每色恰好 9 格」做平衡分配
- `src/main.ts`：UI、PWA 安裝、localStorage、solver 串接
- `public/sw.js`：離線快取
- `dev-tests/color-test.html`：顏色辨識管線驗證頁（合成含 logo/反光的照片跑完整流程），`npm run dev` 後開 `/dev-tests/color-test.html`
