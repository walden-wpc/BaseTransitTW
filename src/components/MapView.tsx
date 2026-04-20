"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import maplibregl, { Map as MapLibreMap, Popup, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CITY_CONFIG_MAP, COMMUTE_ZONES } from "@/lib/graphLoader";
import type { Graph } from "@/lib/graphLoader";
import type { WorkerResponse } from "@/workers/isochroneWorker";
import { buildPolygonFromCosts } from "@/lib/isochrone";
import type { FeatureCollection, Point, Polygon, MultiPolygon } from "geojson";

// OpenFreeMap 暮色底圖（暗色，與我們的設計主题一致）
const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

// ── 路線識別色（查詢模式用）──────────────────────────────────────────────────
const ROUTE_PALETTE = [
  "#f97316", "#6366f1", "#10b981", "#ef4444", "#3b82f6",
  "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
  "#14b8a6", "#f43f5e", "#a855f7", "#0ea5e9", "#22c55e",
];

const routeColorCache = new Map<string, string>();
let routeColorIdx = 0;

function getRouteColor(routeName: string): string {
  if (!routeColorCache.has(routeName)) {
    routeColorCache.set(routeName, ROUTE_PALETTE[routeColorIdx % ROUTE_PALETTE.length]);
    routeColorIdx++;
  }
  return routeColorCache.get(routeName)!;
}

// ── 班距顏色（頻率模式用）────────────────────────────────────────────────────
// 班距（分鐘）→ 顏色  /  -1 = 無資料
function getFrequencyColor(headwayMin: number): string {
  if (headwayMin < 0)  return "#9ca3af"; // 無資料：灰
  if (headwayMin <= 10) return "#22c55e"; // ≤10 分：綠
  if (headwayMin <= 20) return "#84cc16"; // 11–20：黃綠
  if (headwayMin <= 40) return "#f59e0b"; // 21–40：琥珀
  if (headwayMin <= 60) return "#f97316"; // 41–60：橘
  return "#ef4444";                        // 61+：紅
}

// 站牌易達性分數（班/時）→ MapLibre step expression
// 採冷色（藍→靛→紫）避免與路線班距暖色（綠→橙→紅）衝突
// score = Σ(60 / headway_i)，無資料路線以 360 分班距計（0.17 班/時，幾乎無貢獻）
const STOP_ACCESS_COLOR_EXPR = [
  "step", ["get", "accessScore"],
  "#e0f2fe",       //  < 0.5  極低（幾乎無班次）
  0.5, "#7dd3fc",  //  0.5–2  低服務
  2,   "#38bdf8",  //  2–6    中等
  6,   "#0284c7",  //  6–14   良好
  14,  "#4338ca",  //  14–25  密集
  25,  "#7c3aed",  //  25+    樞紐
] as unknown as maplibregl.ExpressionSpecification;

// 計算站牌易達性分數（班/時）
function computeAccessScore(
  routes: string[],
  routeMeta: Record<string, { headway_weekday?: number }>,
): number {
  if (!routes || routes.length === 0) return 0;
  return routes.reduce((sum, r) => {
    const hw = routeMeta[r]?.headway_weekday ?? -1;
    const effectiveHw = hw > 0 ? hw : 360; // 無資料 → 6 小時班距
    return sum + 60 / effectiveHw;
  }, 0);
}

// 可達站點依 cost 上色
const REACHABLE_STOP_COLOR_EXPR = [
  "interpolate", ["linear"], ["get", "cost"],
  0,   "#22c55e",
  15,  "#84cc16",
  30,  "#eab308",
  60,  "#f59e0b",
  90, "#ef4444",
  135, "#ec4899",
  180, "#a855f7",
] as unknown as maplibregl.ExpressionSpecification;

interface IsoCacheEntry {
  computedMaxTime: number;
  reachablePoints: FeatureCollection<Point>;
  reachableNodeCosts: Record<string, number>;
  finalNodeCount: number;
  usedRoutes: string[];
}
const ISO_CACHE_MAX = 10;

// 從可達節點（過濾至 upToTime）推導路線名稱列表
function getRoutesFromNodes(
  nodeCosts: Record<string, number>,
  upToTime: number,
  graph: Graph,
): string[] {
  const routeSet = new Set<string>();
  for (const [uid, cost] of Object.entries(nodeCosts)) {
    if (cost <= upToTime) {
      const node = graph.nodes[uid];
      node?.routes?.forEach(r => routeSet.add(r));
    }
  }
  return Array.from(routeSet);
}

// Taoyuan 中心座標
const TAOYUAN_CENTER: [number, number] = [121.22, 24.97];
const TAOYUAN_ZOOM = 11;

// ── Layer IDs ─────────────────────────────────────────────────────────────────
const LAYERS = {
  ALL_STOPS:        "all-stops",
  ALL_STOPS_HOVER:  "all-stops-hover",
  REACHABLE_STOPS:  "reachable-stops",
  START_STOP:       "start-stop",
  START_PULSE:      "start-pulse",
  ROUTE_SHAPES:     "route-shapes",
  ROUTE_HIGHLIGHT:  "route-highlight",
  ISO_FILL:         "isochrone-fill",
  ISO_OUTLINE:      "isochrone-outline",
} as const;

const SOURCES = {
  ALL_STOPS:        "all-stops-src",
  REACHABLE:        "reachable-src",
  START:            "start-src",
  ROUTES:           "route-shapes-src",
  ISOCHRONE:        "isochrone-src",
} as const;

interface MapViewProps {
  graph: Graph | null;
  computeGraph: Graph | null;
  mode: "isochrone" | "routes";
  maxTimeMin: number;
  maxTransfers: number;
  onStopSelect: (uid: string, name: string) => void;
  onCalculating: (v: boolean) => void;
  onIsoResult: (r: { nodeCount: number; areaKm2: number; durationMs: number; usedRoutes: string[] } | null) => void;
  selectedStopId: string | null;
  onClear: () => void;
  focusedRoute: string | null;
  stopRoutes: string[];
  showFrequency: boolean;
  showPolygon: boolean;
  routeMeta: Record<string, { headway_weekday: number; headway_weekend: number; is_circular: boolean }>;
  activeCity: string;          // 目前互動城市（shapes 來源）
  selectedCities: string[];    // 全部選取城市（用於 flyTo 偵測新增）
}

export default function MapView({
  graph,
  computeGraph,
  mode,
  maxTimeMin,
  maxTransfers,
  onStopSelect,
  onCalculating,
  onIsoResult,
  selectedStopId,
  onClear,
  focusedRoute,
  stopRoutes,
  showFrequency,
  showPolygon,
  routeMeta,
  activeCity,
  selectedCities,
}: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const shapesPerCityRef = useRef<Record<string, Record<string, any>>>({});
  const showFrequencyRef = useRef(showFrequency);
  useEffect(() => { showFrequencyRef.current = showFrequency; }, [showFrequency]);
  const selectedStopIdRef = useRef(selectedStopId);
  useEffect(() => { selectedStopIdRef.current = selectedStopId; }, [selectedStopId]);
  const onClearRef = useRef(onClear);
  useEffect(() => { onClearRef.current = onClear; }, [onClear]);
  const showPolygonRef = useRef(showPolygon);
  useEffect(() => { showPolygonRef.current = showPolygon; }, [showPolygon]);

  // Per-city shapes cache helper — merges all selected cities' shape GeoJSONs
  const getShapes = useCallback((cities: string[]): Promise<Record<string, any>> => {
    const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const needFetch = cities.filter(c => !shapesPerCityRef.current[c]);
    const merge = () => Object.assign({}, ...cities.map(c => shapesPerCityRef.current[c] ?? {}));
    if (needFetch.length === 0) return Promise.resolve(merge());
    return Promise.all(
      needFetch.map(c =>
        fetch(`${BASE}/data/${c}_shapes.json`).then(r => r.json()).catch(() => ({}))
      )
    ).then(results => {
      needFetch.forEach((c, i) => { shapesPerCityRef.current[c] = results[i]; });
      return merge();
    });
  }, []);

  // 等時線漸進式 / 快取相關 refs
  const isoCacheRef = useRef<Map<string, IsoCacheEntry>>(new Map());
  // 等時線模式下「最後一次計算結果」供 focusedRoute / showFrequency / maxTimeMin 切換時重畫用
  const isoRoutesStateRef = useRef<{
    reachableNodeCosts: Record<string, number>;
    usedRoutes: string[];
  } | null>(null);
  const maxTimeMinRef = useRef(maxTimeMin);
  useEffect(() => { maxTimeMinRef.current = maxTimeMin; }, [maxTimeMin]);

  // ── Worker 管理 ───────────────────────────────────────────────────────────
  const initWorker = useCallback(() => {
    if (workerRef.current) workerRef.current.terminate();
    workerRef.current = new Worker(
      new URL("../workers/isochroneWorker.ts", import.meta.url),
      { type: "module" }
    );
    return workerRef.current;
  }, []);

  // ── 地圖初始化 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: TAOYUAN_CENTER,
      zoom: TAOYUAN_ZOOM,
      maxZoom: 18,
      minZoom: 6,
      attributionControl: false,
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.on("load", () => {
      mapRef.current = map;
      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      workerRef.current?.terminate();
    };
  }, []);

  // ── 載入站牌圖層 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    if (!graph) {
      (map.getSource(SOURCES.ALL_STOPS) as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    // 將所有站牌轉為 GeoJSON（accessScore 初始為 0，等 routeMeta 載入後更新）
    const features = Object.entries(graph.nodes).map(([uid, node]) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [node.lon, node.lat] },
      properties: { uid, name: node.name, accessScore: 0 },
    }));
    const allStopsGeoJSON: FeatureCollection<Point> = {
      type: "FeatureCollection",
      features,
    };

    // Add sources
    if (!map.getSource(SOURCES.ALL_STOPS)) {
      map.addSource(SOURCES.ALL_STOPS,  { type: "geojson", data: allStopsGeoJSON });
      map.addSource(SOURCES.REACHABLE,  { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource(SOURCES.START,      { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource(SOURCES.ROUTES,     { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource(SOURCES.ISOCHRONE,  { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      // Layer order (bottom → top):
      //   ISO_FILL → ISO_OUTLINE → ROUTE_SHAPES → ALL_STOPS → REACHABLE_STOPS → ROUTE_HIGHLIGHT → START_PULSE → START_STOP
      // ROUTE_SHAPES（未點擊）維持在站牌下；ROUTE_HIGHLIGHT（點擊後）浮到所有站牌上方

      // Layer: Isochrone fill（等時線填色，最底層）
      map.addLayer({
        id: LAYERS.ISO_FILL,
        type: "fill",
        source: SOURCES.ISOCHRONE,
        paint: {
          "fill-color": "rgba(99,102,241,0.13)",
          "fill-opacity": 1,
        },
      });
      map.addLayer({
        id: LAYERS.ISO_OUTLINE,
        type: "line",
        source: SOURCES.ISOCHRONE,
        paint: {
          "line-color": "rgba(148,163,255,0.65)",
          "line-width": 1.5,
          "line-dasharray": [3, 2],
        },
      });

      // Layer: Route shapes（未點擊時的路線線條，顯示在站牌下方）
      map.addLayer({
        id: LAYERS.ROUTE_SHAPES,
        type: "line",
        source: SOURCES.ROUTES,
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#888888"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 4],
          "line-opacity": 0.7,
        },
      });

      // Layer: All stops（zoom ≥ 11 才顯示完整；有結果時淡化由 useEffect 控制）
      map.addLayer({
        id: LAYERS.ALL_STOPS,
        type: "circle",
        source: SOURCES.ALL_STOPS,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1, 11, 2.5, 13, 4, 16, 6],
          "circle-color": "#FFD306",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0, 13, 1],
          "circle-stroke-color": "rgba(220, 230, 255, 0.5)",
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 11, 0.7],
        },
      });

      // Layer: Reachable stops（依 cost 對齊 band 漸層色）
      map.addLayer({
        id: LAYERS.REACHABLE_STOPS,
        type: "circle",
        source: SOURCES.REACHABLE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 7],
          "circle-color": REACHABLE_STOP_COLOR_EXPR,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "rgba(255,255,255,0.4)",
          "circle-opacity": 0.9,
        },
      });

      // Layer: Route highlight（點選路線時高亮單條，浮到所有站牌上方）
      map.addSource("route-highlight-src", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYERS.ROUTE_HIGHLIGHT,
        type: "line",
        source: "route-highlight-src",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 14, 7],
          "line-opacity": 0.95,
        },
      });

      // Layer: Start pulse（橘色脈衝背景）
      map.addLayer({
        id: LAYERS.START_PULSE,
        type: "circle",
        source: SOURCES.START,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 16, 14, 28],
          "circle-color": "rgba(249, 115, 22, 0.15)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(249, 115, 22, 0.5)",
          "circle-opacity": 0.8,
        },
      });

      // Layer: Start stop（橘色實心點）
      map.addLayer({
        id: LAYERS.START_STOP,
        type: "circle",
        source: SOURCES.START,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 10],
          "circle-color": "#f97316",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#fff",
        },
      });

      // ── 互動：hover tooltip ───────────────────────────────────────────────
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
      });
      popupRef.current = popup;

      const showPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return;
        const feat = e.features[0];
        const coords = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
        const { name, uid, cost, accessScore } = feat.properties as { name: string; uid: string; cost?: number; accessScore?: number };

        map.getCanvas().style.cursor = "pointer";

        // 等時線可達站牌：顯示預計到達時間；背景站牌：開啟發車密度時顯示易達性
        const costStr = cost !== undefined
          ? `<span style="color:#34d399;font-size:11px;">🕐 預計到達 ${Math.round(cost)} 分鐘</span><br/>`
          : "";
        const scoreStr = (cost === undefined) && showFrequencyRef.current && accessScore !== undefined
          ? `<span style="color:var(--text-secondary);font-size:11px;">🚌 易達性: ${accessScore < 1 ? "< 1" : accessScore.toFixed(1)} 班/時</span><br/>`
          : "";
        popup
          .setLngLat(coords)
          .setHTML(`<strong>${name}</strong><br/><span style="color:var(--text-secondary);font-size:11px;">${uid}</span><br/>${costStr}${scoreStr}`)
          .addTo(map);
      };

      const hidePopup = () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      };

      map.on("mouseenter", LAYERS.ALL_STOPS,        showPopup);
      map.on("mouseenter", LAYERS.REACHABLE_STOPS,  showPopup);
      map.on("mouseleave", LAYERS.ALL_STOPS,        hidePopup);
      map.on("mouseleave", LAYERS.REACHABLE_STOPS,  hidePopup);

      // ── 互動：click 選擇站牌（再按一次取消選取）────────────────────────
      const handleClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return;
        const { uid, name } = e.features[0].properties as { uid: string; name: string };
        if (uid === selectedStopIdRef.current) { onClearRef.current(); return; }
        onStopSelect(uid, name);
      };

      map.on("click", LAYERS.ALL_STOPS,      handleClick);
      map.on("click", LAYERS.REACHABLE_STOPS, handleClick);

    }
  }, [mapReady, graph, onStopSelect]);

  // ── 路線模式：顯示此站路線形狀 ───────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current || !graph) return;
    if (mode !== "routes") return;

    const map = mapRef.current;
    const empty = { type: "FeatureCollection" as const, features: [] };

    // 清空等時線相關圖層
    (map.getSource(SOURCES.REACHABLE) as GeoJSONSource)?.setData(empty);

    if (!selectedStopId || stopRoutes.length === 0) {
      (map.getSource(SOURCES.ROUTES) as GeoJSONSource)?.setData(empty);
      (map.getSource(SOURCES.START) as GeoJSONSource)?.setData(empty);
      return;
    }

    // 更新起點圖層
    const startNode = graph.nodes[selectedStopId];
    if (startNode) {
      (map.getSource(SOURCES.START) as GeoJSONSource)?.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: [startNode.lon, startNode.lat] }, properties: { uid: selectedStopId, name: startNode.name } }],
      });
    }

    // 載入並顯示路線形狀（所有選取城市合併，focusedRoute 選中時只顯示該條）
    const resolveColor = (f: any) =>
      showFrequency
        ? getFrequencyColor(f.properties?.headway_weekday ?? -1)
        : getRouteColor(f.properties?.name ?? "");

    const display = (shapes: Record<string, any>) => {
      const routesToShow = focusedRoute ? [focusedRoute] : stopRoutes;
      const features = routesToShow
        .map(r => shapes[r])
        .filter(Boolean)
        .map(f => ({ ...f, properties: { ...f.properties, color: resolveColor(f) } }));
      (map.getSource(SOURCES.ROUTES) as GeoJSONSource)?.setData({ type: "FeatureCollection", features } as any);
    };

    getShapes(selectedCities).then(display).catch(() =>
      (map.getSource(SOURCES.ROUTES) as GeoJSONSource)?.setData(empty)
    );
  }, [mode, selectedStopId, stopRoutes, focusedRoute, showFrequency, graph, mapReady, selectedCities, getShapes]);

  // ── 城市切換：飛行到新增城市（僅當該城市是唯一選取項時），清快取與圖層 ────
  const prevCitiesRef = useRef<string[]>([]);
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    // 找出新加入的城市
    const added = selectedCities.find(c => !prevCitiesRef.current.includes(c));
    prevCitiesRef.current = selectedCities;
    // 有新加入的城市時飛行視角（通勤圈或單一城市）
    if (added) {
      const matchedZone = COMMUTE_ZONES.find(z =>
        z.cities.length === selectedCities.length &&
        z.cities.every(c => selectedCities.includes(c))
      );
      if (matchedZone) {
        mapRef.current.flyTo({ center: matchedZone.center, zoom: matchedZone.zoom, duration: 1200 });
      } else if (selectedCities.length === 1) {
        const config = CITY_CONFIG_MAP[added];
        if (config) mapRef.current.flyTo({ center: config.center, zoom: config.zoom, duration: 1200 });
      }
    }
    // 清快取與圖層
    isoCacheRef.current.clear();
    isoRoutesStateRef.current = null;
    // Evict shapes for cities no longer selected
    const validSet = new Set(selectedCities);
    for (const c of Object.keys(shapesPerCityRef.current)) {
      if (!validSet.has(c)) delete shapesPerCityRef.current[c];
    }
    const empty = { type: "FeatureCollection" as const, features: [] };
    (map.getSource(SOURCES.REACHABLE) as GeoJSONSource)?.setData(empty);
    (map.getSource(SOURCES.START)     as GeoJSONSource)?.setData(empty);
    (map.getSource(SOURCES.ROUTES)    as GeoJSONSource)?.setData(empty);
  }, [selectedCities, mapReady]);

  // maxTransfers 或 computeGraph 改變時清等時線快取（觸發重新計算）
  // computeGraph 在新城市完成載入時會產生新物件，若不清快取會用舊的部分路網結果
  useEffect(() => {
    isoCacheRef.current.clear();
    isoRoutesStateRef.current = null;
  }, [maxTransfers, computeGraph]);

  // 更新等時線多邊形圖層
  const updateIsoPolygon = useCallback((polygon: FeatureCollection<Polygon | MultiPolygon> | null) => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(SOURCES.ISOCHRONE) as GeoJSONSource;
    if (!src) return;
    src.setData(polygon ?? { type: "FeatureCollection", features: [] });
  }, []);

  // showPolygon 開關或 maxTimeMin 變化時：從目前已有的 nodeCosts 即時重算多邊形
  // isoRoutesStateRef 保存最新一次完整計算結果，ref 不在 deps 但在 effect 執行時仍可讀取到最新值
  useEffect(() => {
    if (!mapReady || !graph) return;
    if (!showPolygon) { updateIsoPolygon(null); return; }
    const state = isoRoutesStateRef.current;
    if (!state) return;
    updateIsoPolygon(buildPolygonFromCosts(state.reachableNodeCosts, graph, maxTimeMin));
  }, [showPolygon, maxTimeMin, mapReady, graph, updateIsoPolygon]);

  // 過濾 reachablePoints 只顯示 cost ≤ upToBand
  const renderReachablePoints = useCallback((fc: FeatureCollection<Point> | null, upToBand: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (!fc) {
      (map.getSource(SOURCES.REACHABLE) as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const features = fc.features.filter(f => ((f.properties as any)?.cost ?? 0) <= upToBand);
    (map.getSource(SOURCES.REACHABLE) as GeoJSONSource)?.setData({ type: "FeatureCollection", features } as any);
  }, []);

  // 畫等時線模式的路線（usedRoutes 為 Dijkstra 確認走過的路線）
  const drawIsoRoutes = useCallback((
    nodeCosts: Record<string, number>,
    upToTime: number,
    usedRoutes: string[],
  ) => {
    const map = mapRef.current;
    if (!map || !computeGraph) return;

    // 只顯示 Dijkstra 實際使用的路線（再依時間上限過濾）
    const reachableRouteSet = new Set(getRoutesFromNodes(nodeCosts, upToTime, computeGraph));
    const allRoutes = usedRoutes.filter(r => reachableRouteSet.has(r));
    const routesToShow = focusedRoute
      ? (allRoutes.includes(focusedRoute) ? [focusedRoute] : [])
      : allRoutes;

    const go = (shapes: Record<string, any>) => {
      const features = routesToShow
        .map(r => shapes[r])
        .filter(Boolean)
        .map((f: any) => {
          const color = showFrequency
            ? getFrequencyColor(f.properties?.headway_weekday ?? -1)
            : getRouteColor(f.properties?.name ?? "");
          return { ...f, properties: { ...f.properties, color } };
        });
      (map.getSource(SOURCES.ROUTES) as GeoJSONSource)?.setData({
        type: "FeatureCollection", features,
      } as any);
    };

    getShapes(selectedCities).then(go).catch(() =>
      (map.getSource(SOURCES.ROUTES) as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] })
    );
  }, [focusedRoute, showFrequency, computeGraph, selectedCities, getShapes]);

  // ── 等時線模式：Dijkstra 計算（漸進式 + 快取）────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current || !graph || !computeGraph || !selectedStopId) return;
    if (mode !== "isochrone") return;

    const map = mapRef.current;

    // 起點圖層
    const startNode = graph.nodes[selectedStopId];
    if (startNode) {
      (map.getSource(SOURCES.START) as GeoJSONSource)?.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: [startNode.lon, startNode.lat] }, properties: { uid: selectedStopId, name: startNode.name } }],
      });
    }

    // ── 先檢查快取 ────────────────────────────────────────────────────────
    const cached = isoCacheRef.current.get(selectedStopId);
    if (cached && cached.computedMaxTime >= maxTimeMin) {
      renderReachablePoints(cached.reachablePoints, maxTimeMin);
      isoRoutesStateRef.current = { reachableNodeCosts: cached.reachableNodeCosts, usedRoutes: cached.usedRoutes };
      if (showPolygon) updateIsoPolygon(buildPolygonFromCosts(cached.reachableNodeCosts, graph, maxTimeMin));
      drawIsoRoutes(cached.reachableNodeCosts, maxTimeMin, cached.usedRoutes);
      const nodeCount = cached.reachablePoints.features.filter(
        f => ((f.properties as any)?.cost ?? 0) <= maxTimeMin
      ).length;
      onCalculating(false);
      onIsoResult({ nodeCount, areaKm2: 0, durationMs: 0, usedRoutes: cached.usedRoutes });
      // LRU touch
      isoCacheRef.current.delete(selectedStopId);
      isoCacheRef.current.set(selectedStopId, cached);
      return;
    }

    // ── 無快取（或不足），啟動 Worker ─────────────────────────────────────
    onCalculating(true);
    onIsoResult(null);
    (map.getSource(SOURCES.REACHABLE) as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });
    (map.getSource(SOURCES.ROUTES)    as GeoJSONSource)?.setData({ type: "FeatureCollection", features: [] });

    const worker = initWorker();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "error") {
        console.error("Worker error:", msg.error);
        onCalculating(false);
        return;
      }

      if (msg.type === "progress") {
        // 進度：更新可達站點 + 顯示 Dijkstra 已走過的路線
        renderReachablePoints(msg.reachablePoints, msg.band);
        const progressNodeCosts: Record<string, number> = {};
        msg.reachablePoints.features.forEach(f => {
          const p = f.properties as any;
          if (p?.uid && p?.cost !== undefined) progressNodeCosts[p.uid] = p.cost;
        });
        isoRoutesStateRef.current = { reachableNodeCosts: progressNodeCosts, usedRoutes: msg.usedRoutes };
        drawIsoRoutes(progressNodeCosts, msg.band, msg.usedRoutes);
        onIsoResult({ nodeCount: msg.nodeCount, areaKm2: 0, durationMs: 0, usedRoutes: msg.usedRoutes });
        return;
      }

      if (msg.type === "done") {
        // 最終：顯示可達站點 + 路線（從 reachableNodes 推導）
        renderReachablePoints(msg.reachablePoints, maxTimeMin);
        // 建立 nodeCosts（uid → cost）
        const nodeCosts: Record<string, number> = {};
        for (const [uid, node] of Object.entries(msg.reachableNodes)) {
          nodeCosts[uid] = node.cost;
        }
        isoRoutesStateRef.current = { reachableNodeCosts: nodeCosts, usedRoutes: msg.usedRoutes };
        drawIsoRoutes(nodeCosts, maxTimeMin, msg.usedRoutes);

        // 更新多邊形（用目前 maxTimeMin 過濾後即時重算，確保範圍精確）
        if (showPolygonRef.current) {
          updateIsoPolygon(buildPolygonFromCosts(nodeCosts, graph, maxTimeMin));
        }

        // 快取（LRU）
        const entry: IsoCacheEntry = {
          computedMaxTime: maxTimeMin,
          reachablePoints: msg.reachablePoints,
          reachableNodeCosts: nodeCosts,
          finalNodeCount: msg.finalNodeCount,
          usedRoutes: msg.usedRoutes,
        };
        isoCacheRef.current.set(selectedStopId, entry);
        while (isoCacheRef.current.size > ISO_CACHE_MAX) {
          const firstKey = isoCacheRef.current.keys().next().value;
          if (firstKey === undefined) break;
          isoCacheRef.current.delete(firstKey);
        }

        onIsoResult({
          nodeCount: msg.finalNodeCount,
          areaKm2: 0,
          durationMs: msg.durationMs,
          usedRoutes: msg.usedRoutes,
        });
        onCalculating(false);
      }
    };

    worker.postMessage({ graph: computeGraph, startId: selectedStopId, maxTimeMin, maxTransfers });

    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      onCalculating(false);
    };
  }, [selectedStopId, maxTimeMin, maxTransfers, graph, computeGraph, mode, mapReady, showPolygon, initWorker, onCalculating, onIsoResult, drawIsoRoutes, renderReachablePoints, updateIsoPolygon]);

  // ── 等時線模式：focusedRoute / showFrequency 變動時重畫路線（不重算）─────
  useEffect(() => {
    if (!mapReady || mode !== "isochrone") return;
    const state = isoRoutesStateRef.current;
    if (!state) return;
    drawIsoRoutes(state.reachableNodeCosts, maxTimeMinRef.current, state.usedRoutes);
  }, [focusedRoute, showFrequency, mode, mapReady, drawIsoRoutes]);

  // ── routeMeta 載入後更新站牌易達性分數 ─────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current || !graph || Object.keys(routeMeta).length === 0) return;
    const map = mapRef.current;
    const src = map.getSource(SOURCES.ALL_STOPS) as GeoJSONSource | undefined;
    if (!src) return;

    const features = Object.entries(graph.nodes).map(([uid, node]) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [node.lon, node.lat] },
      properties: {
        uid,
        name: node.name,
        accessScore: computeAccessScore(node.routes ?? [], routeMeta),
      },
    }));
    src.setData({ type: "FeatureCollection", features });
  }, [mapReady, graph, routeMeta]);

  // ── 有選站牌時淡化背景站點，清除時恢復 ────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;
    const opacity = selectedStopId
      ? ["interpolate", ["linear"], ["zoom"], 9, 0.15, 11, 0.2]
      : ["interpolate", ["linear"], ["zoom"], 9, 0.4, 11, 0.7];
    map.setPaintProperty(LAYERS.ALL_STOPS, "circle-opacity", opacity);
  }, [selectedStopId, mapReady]);

  // ── 頻率模式：切換站牌顏色與路線顏色 ─────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;
    if (showFrequency) {
      map.setPaintProperty(LAYERS.ALL_STOPS, "circle-color", STOP_ACCESS_COLOR_EXPR);
      map.setPaintProperty(LAYERS.ALL_STOPS, "circle-radius",
        ["interpolate", ["linear"], ["zoom"], 10, 2, 13, 5, 16, 8]
      );
    } else {
      map.setPaintProperty(LAYERS.ALL_STOPS, "circle-color", "#FFD306");
      map.setPaintProperty(LAYERS.ALL_STOPS, "circle-radius",
        ["interpolate", ["linear"], ["zoom"], 10, 1.5, 13, 4, 16, 6]
      );
    }
  }, [showFrequency, mapReady]);

  // 路線聚焦邏輯已整合進路線模式 effect，此處僅調整線寬以示強調
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;
    const width = focusedRoute
      ? ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 6]
      : ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 4];
    map.setPaintProperty(LAYERS.ROUTE_SHAPES, "line-width", width);
  }, [focusedRoute, mapReady]);

  // ── 清除狀態（同時作為中止 Worker 的入口）─────────────────────────────────
  useEffect(() => {
    if (selectedStopId || !mapRef.current || !mapReady) return;
    // 中止進行中的 Worker（如果有）
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    isoRoutesStateRef.current = null;
    const map = mapRef.current;
    const empty = { type: "FeatureCollection" as const, features: [] };
    (map.getSource(SOURCES.REACHABLE)  as GeoJSONSource)?.setData(empty);
    (map.getSource(SOURCES.START)      as GeoJSONSource)?.setData(empty);
    (map.getSource(SOURCES.ROUTES)     as GeoJSONSource)?.setData(empty);
    (map.getSource(SOURCES.ISOCHRONE)  as GeoJSONSource)?.setData(empty);
  }, [selectedStopId, mapReady]);

  return (
    <div
      ref={mapContainer}
      id="map-container"
      style={{ position: "fixed", inset: 0, zIndex: 0 }}
    />
  );
}
