"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import "./globals.css";
import { loadGraph, CITY_CONFIG_MAP, CITY_CONFIGS, ALL_CITY_KEYS } from "@/lib/graphLoader";
import type { Graph, GraphNode, GraphEdge } from "@/lib/graphLoader";
import { getStopRoutes } from "@/lib/stopRoutes";
import ControlPanel from "@/components/ControlPanel";
import InfoOverlay from "@/components/InfoOverlay";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

export type AppMode = "isochrone" | "routes";

interface IsochroneResult {
  nodeCount: number;
  areaKm2: number;
  durationMs: number;
  usedRoutes: string[];
}

type RouteMeta = Record<string, {
  departure: string; destination: string; headsign: string;
  operator: string; headway_weekday: number; headway_weekend: number; is_circular: boolean;
}>;

export default function HomePage() {
  // ── 城市選擇 ──────────────────────────────────────────────────────────────
  const [selectedCities, setSelectedCities] = useState<string[]>(["taoyuan"]);
  const [cityGraphs, setCityGraphs]   = useState<Record<string, Graph>>({});
  const [cityErrors, setCityErrors]   = useState<Record<string, string>>({});
  const [activeCity, setActiveCity]   = useState<string>("taoyuan");

  // ── 地圖狀態 ──────────────────────────────────────────────────────────────
  const [mode, setMode]               = useState<AppMode>("routes");
  const [maxTimeMin, setMaxTimeMin]   = useState(30);
  const [maxTransfers, setMaxTransfers] = useState(2);
  const [fullTaiwan, setFullTaiwan]   = useState(false);
  const [selectedStop, setSelectedStop] = useState<{ uid: string; name: string } | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isoResult, setIsoResult]     = useState<IsochroneResult | null>(null);
  const [stopRoutes, setStopRoutes]   = useState<string[]>([]);
  const [focusedRoute, setFocusedRoute] = useState<string | null>(null);
  const [showFrequency, setShowFrequency] = useState(false);
  const [showPolygon, setShowPolygon] = useState(false);
  const [routeMeta, setRouteMeta]     = useState<RouteMeta>({});

  const prevCitiesRef = useRef<string[]>(["taoyuan"]);

  // ── 載入新加入城市的 graph ──────────────────────────────────────────────────
  useEffect(() => {
    const toLoad = selectedCities.filter(c => !cityGraphs[c] && !cityErrors[c]);
    if (toLoad.length === 0) return;
    toLoad.forEach(city => {
      loadGraph(city)
        .then(g => setCityGraphs(prev => ({ ...prev, [city]: g })))
        .catch(err => {
          console.error(`${city} 圖資載入失敗：`, err);
          setCityErrors(prev => ({ ...prev, [city]: err.message ?? "載入失敗" }));
        });
    });
  }, [selectedCities]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 載入所有選取城市的 shapes（合併為 routeMeta）──────────────────────────
  useEffect(() => {
    if (selectedCities.length === 0) { setRouteMeta({}); return; }
    setRouteMeta({});
    Promise.all(
      selectedCities.map(city =>
        fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/${city}_shapes.json`)
          .then(r => r.ok ? r.json() : {})
          .catch(() => ({}))
      )
    ).then(allShapes => {
      const merged: RouteMeta = {};
      for (const shapes of allShapes) {
        for (const [name, feat] of Object.entries(shapes as Record<string, any>)) {
          const p = (feat as any).properties ?? {};
          merged[name] = {
            departure:       p.departure ?? "",
            destination:     p.destination ?? "",
            headsign:        p.headsign ?? "",
            operator:        p.operator ?? "",
            headway_weekday: p.headway_weekday ?? -1,
            headway_weekend: p.headway_weekend ?? -1,
            is_circular:     p.is_circular ?? false,
          };
        }
      }
      setRouteMeta(merged);
    });
  }, [selectedCities]);

  // ── 合併所有選取城市的 graph（nodes + edges，供顯示與 Dijkstra 共用）────────
  const computeGraph = useMemo((): Graph | null => {
    const loaded = selectedCities.map(c => cityGraphs[c]).filter(Boolean) as Graph[];
    if (loaded.length === 0) return null;
    if (loaded.length === 1) return loaded[0];

    const mergedNodes: Record<string, GraphNode> = {};
    const mergedEdges: Record<string, GraphEdge[]> = {};

    // Concatenate edges (not overwrite) so no city loses its edges
    for (const g of loaded) {
      Object.assign(mergedNodes, g.nodes);
      for (const [uid, edgeList] of Object.entries(g.edges)) {
        if (mergedEdges[uid]) mergedEdges[uid] = mergedEdges[uid].concat(edgeList);
        else mergedEdges[uid] = edgeList;
      }
    }

    // Build spatial grid to find cross-city nearby stops for walk edges
    const CELL_DEG = 0.003;        // ~330m grid cell
    const WALK_THRESHOLD_M = 150;  // max walk distance between city border stops
    const WALK_SPEED = 80;         // m/min
    const DEG_TO_M_LAT = 111320;
    const grid: Record<string, string[]> = {};
    for (const uid of Object.keys(mergedNodes)) {
      const n = mergedNodes[uid];
      const cx = Math.floor(n.lon / CELL_DEG);
      const cy = Math.floor(n.lat / CELL_DEG);
      const key = `${cx},${cy}`;
      if (!grid[key]) grid[key] = [];
      grid[key].push(uid);
    }

    // Track which city each stop came from (last loaded city wins for shared UIDs)
    const stopCity: Record<string, number> = {};
    loaded.forEach((g, i) => { for (const uid of Object.keys(g.nodes)) stopCity[uid] = i; });

    // For each stop, check neighbouring cells for cross-city stops within threshold
    for (const uid of Object.keys(mergedNodes)) {
      const n = mergedNodes[uid];
      const cx = Math.floor(n.lon / CELL_DEG);
      const cy = Math.floor(n.lat / CELL_DEG);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbours = grid[`${cx + dx},${cy + dy}`];
          if (!neighbours) continue;
          for (const nid of neighbours) {
            if (nid === uid) continue;
            if (stopCity[nid] === stopCity[uid]) continue; // same city, skip
            const nb = mergedNodes[nid];
            const dLat = (nb.lat - n.lat) * DEG_TO_M_LAT;
            const dLon = (nb.lon - n.lon) * DEG_TO_M_LAT * Math.cos(n.lat * Math.PI / 180);
            const dist = Math.sqrt(dLat * dLat + dLon * dLon);
            if (dist > WALK_THRESHOLD_M) continue;
            const w = Math.round(dist / WALK_SPEED * 10) / 10;
            if (!mergedEdges[uid]) mergedEdges[uid] = [];
            // Avoid duplicate walk edges
            if (!mergedEdges[uid].some(e => e.to === nid && e.t === "walk")) {
              mergedEdges[uid].push({ to: nid, w, t: "walk" });
            }
          }
        }
      }
    }

    return { ...loaded[0], nodes: mergedNodes, edges: mergedEdges };
  }, [selectedCities, cityGraphs]);

  // ── 城市選擇變更 ──────────────────────────────────────────────────────────
  const handleCitiesChange = useCallback((cities: string[], newlyAdded: string | null) => {
    setSelectedCities(cities);
    if (newlyAdded) {
      setActiveCity(newlyAdded);
    } else if (cities.length > 0 && !cities.includes(activeCity)) {
      setActiveCity(cities[0]);
    }
    setSelectedStop(null);
    setIsoResult(null);
    setIsCalculating(false);
    setStopRoutes([]);
    setFocusedRoute(null);
  }, [activeCity]);

  // ── 全台路網開關 ──────────────────────────────────────────────────────────
  const handleFullTaiwanChange = useCallback((v: boolean) => {
    setFullTaiwan(v);
    if (v) {
      prevCitiesRef.current = selectedCities;
      handleCitiesChange(ALL_CITY_KEYS, null);
    } else {
      handleCitiesChange(prevCitiesRef.current, null);
    }
  }, [selectedCities, handleCitiesChange]);

  // ── 站牌選取（自動判斷 activeCity）────────────────────────────────────────
  const handleStopSelect = useCallback((uid: string, name: string) => {
    setSelectedStop({ uid, name });
    setIsoResult(null);
    setFocusedRoute(null);
    for (const city of selectedCities) {
      if (cityGraphs[city]?.nodes[uid]) {
        setActiveCity(city);
        return;
      }
    }
  }, [selectedCities, cityGraphs]);

  // 選站牌後立即查路線
  useEffect(() => {
    if (!computeGraph || !selectedStop) { setStopRoutes([]); return; }
    setStopRoutes(getStopRoutes(computeGraph, selectedStop.uid));
  }, [computeGraph, selectedStop]);

  const handleClear = useCallback(() => {
    setSelectedStop(null);
    setIsoResult(null);
    setIsCalculating(false);
    setStopRoutes([]);
    setFocusedRoute(null);
  }, []);

  const handleModeChange = useCallback((m: AppMode) => {
    setMode(m);
    setIsoResult(null);
    setFocusedRoute(null);
  }, []);

  const isLoadingAny = selectedCities.some(c => !cityGraphs[c] && !cityErrors[c]);

  return (
    <>
      <MapView
        graph={computeGraph}
        computeGraph={computeGraph}
        mode={mode}
        maxTimeMin={maxTimeMin}
        maxTransfers={maxTransfers}
        onStopSelect={handleStopSelect}
        onCalculating={setIsCalculating}
        onIsoResult={setIsoResult}
        selectedStopId={selectedStop?.uid ?? null}
        onClear={handleClear}
        focusedRoute={focusedRoute}
        stopRoutes={stopRoutes}
        showFrequency={showFrequency}
        showPolygon={showPolygon}
        routeMeta={routeMeta}
        activeCity={activeCity}
        selectedCities={selectedCities}
      />

      <ControlPanel
        selectedStop={selectedStop}
        graph={computeGraph}
        onStopSelect={handleStopSelect}
        mode={mode}
        onModeChange={handleModeChange}
        maxTimeMin={maxTimeMin}
        onMaxTimeChange={setMaxTimeMin}
        maxTransfers={maxTransfers}
        onMaxTransfersChange={setMaxTransfers}
        fullTaiwan={fullTaiwan}
        onFullTaiwanChange={handleFullTaiwanChange}
        showPolygon={showPolygon}
        onShowPolygonToggle={setShowPolygon}
        isCalculating={isCalculating}
        onClear={handleClear}
        showFrequency={showFrequency}
        onFrequencyToggle={setShowFrequency}
        selectedCities={selectedCities}
        onCitiesChange={handleCitiesChange}
        cityErrors={cityErrors}
        activeCity={activeCity}
      />

      <InfoOverlay
        mode={mode}
        isoResult={isoResult}
        stopRoutes={stopRoutes}
        routeMeta={routeMeta}
        maxTimeMin={maxTimeMin}
        focusedRoute={focusedRoute}
        onRouteClick={setFocusedRoute}
        showFrequency={showFrequency}
      />

      {isLoadingAny && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          background: "rgba(10,14,22,0.85)", backdropFilter: "blur(12px)",
          border: "1px solid var(--border)", borderRadius: 20,
          padding: "8px 18px", fontSize: 13, color: "var(--text-secondary)",
          display: "flex", alignItems: "center", gap: 10, zIndex: 20,
        }}>
          <div className="spinner" />
          載入路網圖資中…
        </div>
      )}
    </>
  );
}
