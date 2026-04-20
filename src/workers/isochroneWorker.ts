/**
 * isochroneWorker.ts — Web Worker（漸進式）
 *
 * 將 Dijkstra 運算移出主執行緒，避免 UI 凍結。
 * 每算完一個時間帶（band，預設 5 分鐘）就 postMessage 一次 progress。
 * progress 只送可達站點（GeoJSON points），不做多邊形運算。
 * 最後發 "done" 訊息，帶完整結果（含 convex hull polygon）。
 */

import { computeIsochrone } from "@/lib/dijkstra";
import { buildIsochronePolygon } from "@/lib/isochrone";
import type { ReachableNodes } from "@/lib/dijkstra";
import type { Graph } from "@/lib/graphLoader";
import type { FeatureCollection, Polygon, MultiPolygon, Point } from "geojson";

export interface WorkerRequest {
  graph: Graph;
  startId: string;
  maxTimeMin: number;
  maxTransfers: number;
}

export type WorkerResponse =
  | {
      type: "progress";
      band: number;
      reachablePoints: FeatureCollection<Point>;
      nodeCount: number;
      usedRoutes: string[];
    }
  | {
      type: "done";
      reachablePoints: FeatureCollection<Point>;
      polygon: FeatureCollection<Polygon | MultiPolygon> | null;
      finalBand: number;
      finalNodeCount: number;
      finalAreaKm2: number;
      usedRoutes: string[];
      reachableNodes: ReachableNodes;
      durationMs: number;
    }
  | { type: "error"; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { graph, startId, maxTimeMin, maxTransfers } = event.data;
  const t0 = performance.now();

  try {
    let lastNodeCount = -1;

    const { nodes: reachableNodes, usedRoutes } = computeIsochrone(
      graph,
      startId,
      maxTimeMin,
      (cp) => {
        const count = Object.keys(cp.nodes).length;
        if (count === lastNodeCount) return;
        lastNodeCount = count;

        // 只做 O(n) 的 GeoJSON 轉換，不做任何 turf 多邊形運算
        const features = Object.entries(cp.nodes)
          .filter(([id]) => graph.nodes[id])
          .map(([id, info]) => {
            const node = graph.nodes[id];
            return {
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [node.lon, node.lat] },
              properties: { uid: id, name: node.name, cost: info.cost },
            };
          });

        const reachablePoints: FeatureCollection<Point> = {
          type: "FeatureCollection",
          features,
        };

        const msg: WorkerResponse = {
          type: "progress",
          band: cp.band,
          reachablePoints,
          nodeCount: count,
          usedRoutes: cp.usedRoutes,
        };
        self.postMessage(msg);
      },
      5,             // bandStepMin
      maxTransfers,
    );

    // 最終：做一次 convex hull + buffer
    const finalPoly = buildIsochronePolygon(reachableNodes, graph);
    const doneMsg: WorkerResponse = {
      type: "done",
      reachablePoints: finalPoly.reachablePoints,
      polygon: finalPoly.polygon,
      finalBand: maxTimeMin,
      finalNodeCount: finalPoly.nodeCount,
      finalAreaKm2: finalPoly.areaKm2,
      usedRoutes,
      reachableNodes,
      durationMs: Math.round(performance.now() - t0),
    };
    self.postMessage(doneMsg);
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
