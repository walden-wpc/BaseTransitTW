/**
 * isochrone.ts — Turf.js 等時線多邊形生成
 *
 * 將 Dijkstra 輸出的可達節點集合，轉換為 GeoJSON 等時線多邊形。
 * 使用 convex hull + single buffer，O(n log n)，不再做 per-point buffer + union。
 */

import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point } from "geojson";
import type { Graph } from "./graphLoader";
import type { ReachableNodes } from "./dijkstra";

export interface IsochroneResult {
  polygon: FeatureCollection<Polygon | MultiPolygon> | null;
  reachablePoints: FeatureCollection<Point>;
  nodeCount: number;
  areaKm2: number;
}

/**
 * buildIsochronePolygon
 *
 * @param reachable   Dijkstra 輸出的可達節點集合
 * @param graph       路網資料（取座標用）
 * @param bufferKm    外擴緩衝半徑（km），預設 0.1km
 * @param maxEdgeKm   凹包最大邊長（km），預設 0.8km；超過此距離的邊不進凹包，自動 fallback 到凸包
 */
export function buildIsochronePolygon(
  reachable: ReachableNodes,
  graph: Graph,
  bufferKm = 0.1,
  maxEdgeKm = 0.8,
): IsochroneResult {
  const ids = Object.keys(reachable);

  const points: Feature<Point>[] = ids
    .filter((id) => graph.nodes[id])
    .map((id) => {
      const node = graph.nodes[id];
      return turf.point([node.lon, node.lat], {
        uid: id,
        name: node.name,
        cost: reachable[id].cost,
      });
    });

  const reachablePoints: FeatureCollection<Point> = turf.featureCollection(points);

  // 依座標去重複計算實體站牌數（同位置多個 UID 只算一個）
  const uniqueLocations = new Set(
    points.map(p => `${Math.round(p.geometry.coordinates[0] * 10000)},${Math.round(p.geometry.coordinates[1] * 10000)}`)
  );
  const uniqueNodeCount = uniqueLocations.size;

  if (points.length < 3) {
    return { polygon: null, reachablePoints, nodeCount: uniqueNodeCount, areaKm2: 0 };
  }

  // 優先使用凹包（Concave Hull）以追蹤站牌群實際輪廓；稀疏區段 fallback 到凸包
  const hull = turf.concave(reachablePoints, { maxEdge: maxEdgeKm, units: "kilometers" })
            ?? turf.convex(reachablePoints);
  if (!hull) {
    return { polygon: null, reachablePoints, nodeCount: uniqueNodeCount, areaKm2: 0 };
  }

  const buffered = turf.buffer(hull, bufferKm, { units: "kilometers", steps: 16 });
  if (!buffered) {
    const area = turf.area(hull) / 1_000_000;
    return {
      polygon: turf.featureCollection([hull as Feature<Polygon | MultiPolygon>]),
      reachablePoints,
      nodeCount: uniqueNodeCount,
      areaKm2: area,
    };
  }

  const areaKm2 = turf.area(buffered) / 1_000_000;
  return {
    polygon: turf.featureCollection([buffered as Feature<Polygon | MultiPolygon>]),
    reachablePoints,
    nodeCount: uniqueNodeCount,
    areaKm2,
  };
}

/**
 * 從 reachableNodeCosts（uid→cost）即時建多邊形，依 maxCost 過濾。
 * 輕量呼叫（< 30ms），不快取，每次 maxTimeMin 變動時直接重算。
 */
export function buildPolygonFromCosts(
  nodeCosts: Record<string, number>,
  graph: Graph,
  maxCost: number,
  bufferKm = 0.1,
  maxEdgeKm = 0.8,
): FeatureCollection<Polygon | MultiPolygon> | null {
  const points: Feature<Point>[] = [];
  for (const [uid, cost] of Object.entries(nodeCosts)) {
    if (cost > maxCost) continue;
    const node = graph.nodes[uid];
    if (!node) continue;
    points.push(turf.point([node.lon, node.lat]));
  }
  if (points.length < 3) return null;

  const fc = turf.featureCollection(points);
  const hull = turf.concave(fc, { maxEdge: maxEdgeKm, units: "kilometers" })
            ?? turf.convex(fc);
  if (!hull) return null;

  const buffered = turf.buffer(hull, bufferKm, { units: "kilometers", steps: 12 });
  if (!buffered) return turf.featureCollection([hull as Feature<Polygon | MultiPolygon>]);
  return turf.featureCollection([buffered as Feature<Polygon | MultiPolygon>]);
}
