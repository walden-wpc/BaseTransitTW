# 臺灣轉公車 🚌

> **全台 22 縣市公車路網視覺化** — 等時線計算、路線查詢、發車密度地圖  
> 純前端、零後端伺服器、完全免費部署

**[➜ 開啟地圖](https://walden-wpc.github.io/BaseTransitTW/)**

---

## 功能

| 功能 | 說明 |
|---|---|
| **等時線模式** | 點選任一站牌，計算在指定分鐘內（5–180 分鐘）可搭公車抵達的所有站牌範圍，並以多邊形視覺化 |
| **路線查詢模式** | 點選站牌，列出所有可搭乘路線，點擊路線可在地圖上顯示完整路線走向 |
| **發車密度地圖** | 以顏色顯示各路線班距（≤10分→綠 ～ 60分+→紅）及站牌服務易達性 |
| **多城市通勤圈** | 預設北北基桃、桃竹竹苗等跨縣市通勤圈組合，支援合併路網計算 |
| **站牌文字搜尋** | 在控制面板直接搜尋站名 |
| **轉乘次數限制** | 可調整最多允許幾次轉乘（預設 2 次），避免計算量爆炸 |

---

## 技術棧

```
前端     Next.js 15 (Static Export) + React 19 + TypeScript 5
地圖     MapLibre GL JS 5（WebGL GPU 渲染）
地理運算  Turf.js 7（凸包、緩衝區、面積）
演算法   Dijkstra + Binary Min-Heap + Web Worker（不阻塞 UI）
資料     TDX 交通部開放資料 API → 預處理靜態 JSON
部署     GitHub Pages + GitHub Actions CI/CD
```


## 專案結構

```
src/
├── app/
│   ├── page.tsx          全域狀態管理中心（入口點）
│   ├── layout.tsx        HTML head、字型設定
│   └── globals.css       深色主題 CSS 變數、共用元件樣式
├── components/
│   ├── MapView.tsx       地圖渲染 + Dijkstra Worker 觸發
│   ├── ControlPanel.tsx  左下控制面板
│   └── InfoOverlay.tsx   右上資訊面板
├── lib/
│   ├── dijkstra.ts       等時線演算法核心
│   ├── isochrone.ts      可達站點 → GeoJSON 多邊形
│   ├── graphLoader.ts    城市設定 + 圖資載入快取
│   └── stopRoutes.ts     站牌 → 可搭路線查詢
└── workers/
    └── isochroneWorker.ts  Web Worker 包裝

scripts/               Python 資料管線（離線工具）
public/data/           預處理好的靜態路網 JSON（22 縣市）
.github/workflows/     GitHub Actions 自動部署設定
```

---

## 資料來源

- 公車路網、班距、站牌資料：[TDX 運輸資料流通服務](https://tdx.transportdata.tw/)（交通部）
- 地圖底圖：[OpenFreeMap](https://openfreemap.org/)（Positron 樣式）

---

## 授權

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)

**版權聲明**：本專案採用 [CC BY-NC 4.0 授權條款](https://creativecommons.org/licenses/by-nc/4.0/)。
您可以自由使用、修改與分享本專案的原始碼，但**嚴禁將本專案用於任何商業營利用途**。引用或分享時請標示原作者。
