# 臺灣轉公車 — CLAUDE.md（語意索引，用於 token 最小化）

## 快速定位原則
1. Grep 函式名稱 → 得到行號 → Read offset+limit 局部讀取
2. Edit（不用 Write）修改既有檔案
3. 本檔記「語意」，不記行號（行號隨編輯變動）

---

## 檔案責任對照

| 檔案 | 行數 | 責任 |
|---|---|---|
| `src/app/page.tsx` | ~170 | 全域狀態管理中心，組合三大組件 |
| `src/components/MapView.tsx` | ~547 | MapLibre 地圖、圖層、互動、Dijkstra Worker 觸發 |
| `src/components/ControlPanel.tsx` | ~217 | 左下面板：模式切換、時間滑桿、發車密度開關+圖例 |
| `src/components/InfoOverlay.tsx` | ~171 | 右上面板：路線列表 / 等時線結果統計 |
| `src/lib/dijkstra.ts` | ~146 | MinHeap + computeIsochrone()，Dijkstra 演算法本體 |
| `src/lib/graphLoader.ts` | ~79 | loadGraph(city)，fetch + 快取 taoyuan.json |
| `src/lib/stopRoutes.ts` | ~35 | getStopRoutes(graph, stopId)，含同位置站牌群合併 |
| `src/lib/isochrone.ts` | ~104 | buildIsochronePolygon()，Turf.js concave hull |
| `src/workers/isochroneWorker.ts` | ~57 | Web Worker 包裝，self.onmessage → computeIsochrone + buildIsochronePolygon |

---

## page.tsx — 關鍵 state 變數

```
graph          Graph | null          — 路網圖資（taoyuan.json）
mode           "routes"|"isochrone" — 當前模式
selectedStop   {uid,name} | null     — 點選的站牌
focusedRoute   string | null         — 點選的路線（routes 模式）
stopRoutes     string[]              — 選定站牌的可搭路線
isoResult      IsochroneResult|null  — 等時線計算結果
showFrequency  boolean               — 發車密度顯示開關
routeMeta      Record<routeName, {departure,destination,headsign,operator,headway_weekday,headway_weekend,is_circular}>
```

**關鍵 callback：** `handleStopSelect` / `handleClear` / `handleModeChange`

---

## MapView.tsx — 區塊索引（Grep 目標）

| Grep 這個字串 | 找到的區塊 |
|---|---|
| `const LAYERS` | Layer ID 常數定義 |
| `const SOURCES` | Source ID 常數定義 |
| `getFrequencyColor` | 班距→顏色函式 |
| `STOP_ACCESS_COLOR_EXPR` | 站牌易達性 MapLibre step expression |
| `computeAccessScore` | 站牌易達性分數計算 |
| `getRouteColor` | 路線識別色（ROUTE_PALETTE 循環） |
| `initWorker` | Worker 初始化 callback |
| `map.on("load"` | 地圖初始化 useEffect 起點 |
| `載入站牌圖層` | 所有 source + layer 的 addSource/addLayer 區塊 |
| `showPopup` | hover tooltip handler |
| `handleClick` | 站牌點擊 handler |
| `路線模式：顯示此站路線形狀` | routes mode useEffect（loadAndDisplay） |
| `等時線模式：Dijkstra` | isochrone mode useEffect（Worker postMessage） |
| `routeMeta 載入後更新` | accessScore 更新 useEffect |
| `有選站牌時淡化` | 站牌 opacity useEffect |
| `頻率模式：切換站牌顏色` | showFrequency toggle useEffect |
| `路線聚焦邏輯` | focusedRoute 線寬 useEffect |
| `清除狀態` | selectedStopId=null 時清空所有 source |

### Layer / Source ID 速查

```
LAYERS:
  all-stops          — 全部站牌黃點
  all-stops-hover    — （目前未用，預留）
  isochrone-fill     — 等時線填色
  isochrone-outline  — 等時線邊框
  reachable-stops    — 等時線可達站（綠點）
  start-stop         — 起點橘點
  start-pulse        — 起點脈衝背景圓
  route-shapes       — 路線線條（多條）
  route-highlight    — 路線高亮（單條，目前白色）

SOURCES:
  all-stops-src      → LAYERS.all-stops / all-stops-hover
  isochrone-src      → ISO_FILL / ISO_OUTLINE
  reachable-src      → REACHABLE_STOPS
  start-src          → START_STOP / START_PULSE
  route-shapes-src   → ROUTE_SHAPES
  route-highlight-src → ROUTE_HIGHLIGHT（硬碼字串，非 SOURCES 物件）
```

---

## InfoOverlay.tsx — 關鍵函式

```
headwayLabel(hw)  — 班距數字 → "N分" 字串
headwayColor(hw)  — 班距數字 → 顏色（與 getFrequencyColor 邏輯相同）
Stat(...)         — 等時線統計卡片子組件
```

---

## 資料流簡圖

```
taoyuan.json ──loadGraph()──→ graph (page state)
                                  ↓
                          getStopRoutes() → stopRoutes (page state)
                                  ↓
                      isochroneWorker ← computeIsochrone()
                                  ↓
                         buildIsochronePolygon() → MapView sources

taoyuan_shapes.json ──fetch──→ routeMeta (page state) + shapesDataRef (MapView)
```

---

## 多城市資料管線

```powershell
# 單一城市
python scripts/fetch_tdx.py --city Taipei
python scripts/build_graph.py --city Taipei
python scripts/generate_shapes.py --city Taipei

# 批次（PowerShell）
.\scripts\fetch_all_cities.ps1 Taipei Tainan
.\scripts\fetch_all_cities.ps1   # 全部 22 縣市
```

輸出：`public/data/{city_key}.json` + `{city_key}_shapes.json`
新城市加入後即可在 UI 選擇器中出現（設定已在 `graphLoader.ts` CITY_CONFIGS）

## 常見修改定位指南

| 想改什麼 | 去哪個檔案 | Grep 什麼 |
|---|---|---|
| 班距顏色分段 | MapView.tsx + InfoOverlay.tsx | `getFrequencyColor` / `headwayColor` |
| 站牌易達性色階 | MapView.tsx | `STOP_ACCESS_COLOR_EXPR` |
| 等時線多邊形參數（bufferKm, maxEdgeKm） | isochrone.ts | `buildIsochronePolygon` |
| 候車懲罰邏輯 | dijkstra.ts | `isAfterWalk` |
| 路線按鈕外觀 | InfoOverlay.tsx | `routes.map(route =>` |
| 控制面板圖例 | ControlPanel.tsx | `showFrequency && (` |
| 地圖底圖 URL | MapView.tsx | `MAP_STYLE` |
| 桃園中心座標/縮放 | MapView.tsx | `TAOYUAN_CENTER` |
| 新增城市支援 | graphLoader.ts | `CITY_DATA_FILES` |
