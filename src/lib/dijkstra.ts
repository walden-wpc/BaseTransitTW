/**
 * dijkstra.ts — Isochrone Flooding（最短路徑樹）演算法
 *
 * 從起點向外擴張，計算在 maxTimeMin 內可到達的所有站牌。
 * 使用 Binary MinHeap Priority Queue 確保 O((V+E)logV) 效率。
 */

import type { Graph, GraphEdge } from "./graphLoader";

// ── MinHeap Priority Queue ────────────────────────────────────────────────────
interface HeapNode { cost: number; id: string; prevRoute: string; transfers: number }

class MinHeap {
  private heap: HeapNode[] = [];

  get size() { return this.heap.length; }

  push(node: HeapNode) {
    this.heap.push(node);
    this._bubbleUp(this.heap.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  private _bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].cost <= this.heap[i].cost) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private _siftDown(i: number) {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.heap[l].cost < this.heap[smallest].cost) smallest = l;
      if (r < n && this.heap[r].cost < this.heap[smallest].cost) smallest = r;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }
}

// ── 演算法輸出型別 ────────────────────────────────────────────────────────────
export interface ReachableNode {
  cost: number;         // 從起點到此站的最短時間成本（分鐘）
  via: string | null;   // 前置站牌 UID（用於路徑重建）
  lastEdgeType: "bus" | "walk" | "start";
}

export type ReachableNodes = Record<string, ReachableNode>;

// ── 漸進式 checkpoint ─────────────────────────────────────────────────────────
export interface ProgressCheckpoint {
  band: number;              // 本次快照對應的時間帶（分鐘）
  nodes: ReachableNodes;     // cost ≤ band 的子集
  usedRoutes: string[];      // 在 cost ≤ band 時已用到的路線
}

// ── 主要函式 ──────────────────────────────────────────────────────────────────
/**
 * computeIsochrone
 *
 * @param graph       預載入的路網資料
 * @param startId     起點站牌 UID
 * @param maxTimeMin  時間上限（分鐘）
 * @param onProgress  漸進式回呼：每跨越一個 band（預設每 5 分鐘）觸發一次
 * @param bandStepMin band 步進（預設 5 分鐘）
 * @returns           所有可達節點 + 使用到的路線
 */
export function computeIsochrone(
  graph: Graph,
  startId: string,
  maxTimeMin: number,
  onProgress?: (checkpoint: ProgressCheckpoint) => void,
  bandStepMin: number = 5,
  maxTransfers: number = 2,   // 最多允許幾次轉乘（大幅減少長時間運算量）
): { nodes: ReachableNodes; usedRoutes: string[] } {
  const { nodes, edges } = graph;

  if (!nodes[startId]) return { nodes: {}, usedRoutes: [] };

  // dist[id][t] = 以恰好 t 次轉乘抵達 id 的最低費時（二維追蹤，避免高轉乘路徑覆蓋低轉乘路徑）
  const dist: Record<string, number[]> = {};
  const result: ReachableNodes = {};
  const pq = new MinHeap();
  const usedRoutesSet = new Set<string>();
  const routeFirstCost: Record<string, number> = {};

  // 步一：BFS 展開同站群（嚴格同位置，w=0）
  const SAME_STOP_MIN = 1.0; // 步行轉乘閾值（分鐘），用於旅途中判斷
  const startCluster: string[] = [];
  const clusterVisited = new Set<string>([startId]);
  const clusterQueue = [startId];
  while (clusterQueue.length > 0) {
    const cur = clusterQueue.shift()!;
    startCluster.push(cur);
    for (const edge of edges[cur] ?? []) {
      if (edge.t === "walk" && edge.w === 0 && nodes[edge.to] && !clusterVisited.has(edge.to)) {
        clusterVisited.add(edge.to);
        clusterQueue.push(edge.to);
      }
    }
  }

  // 步二：找出 node.routes 列有、但起點群沒有出發邊的路線
  //       （例如終點站 UID 只有到站邊，出發 UID 在附近）
  const routesWithOutbound = new Set<string>();
  for (const uid of startCluster) {
    for (const edge of edges[uid] ?? []) {
      if (edge.t === "bus" && edge.r) routesWithOutbound.add(edge.r);
    }
  }
  const missingRoutes = new Set<string>();
  for (const uid of startCluster) {
    for (const r of nodes[uid].routes ?? []) {
      if (!routesWithOutbound.has(r)) missingRoutes.add(r);
    }
  }
  // 步三：往外一跳（任意步行邊），找到缺失路線的出發站，納入起點群
  if (missingRoutes.size > 0) {
    for (const uid of [...startCluster]) {
      for (const walkEdge of edges[uid] ?? []) {
        if (walkEdge.t !== "walk" || clusterVisited.has(walkEdge.to) || !nodes[walkEdge.to]) continue;
        const hasNeeded = (edges[walkEdge.to] ?? []).some(
          e => e.t === "bus" && e.r && missingRoutes.has(e.r)
        );
        if (hasNeeded) {
          clusterVisited.add(walkEdge.to);
          startCluster.push(walkEdge.to);
          for (const e of edges[walkEdge.to] ?? []) {
            if (e.t === "bus" && e.r) {
              routesWithOutbound.add(e.r);
              missingRoutes.delete(e.r);
            }
          }
        }
      }
    }
  }

  for (const uid of startCluster) {
    dist[uid] = new Array(maxTransfers + 1).fill(Infinity);
    dist[uid][0] = 0;
    pq.push({ cost: 0, id: uid, prevRoute: "start", transfers: 0 });
    for (const route of nodes[uid].routes ?? []) {
      if (!usedRoutesSet.has(route)) {
        usedRoutesSet.add(route);
        routeFirstCost[route] = 0;
      }
    }
  }

  let nextBand = bandStepMin;

  const emitBand = (band: number) => {
    if (!onProgress) return;
    const filteredNodes: ReachableNodes = {};
    for (const uid in result) {
      if (result[uid].cost <= band) filteredNodes[uid] = result[uid];
    }
    const filteredRoutes: string[] = [];
    for (const r of usedRoutesSet) {
      if ((routeFirstCost[r] ?? Infinity) <= band) filteredRoutes.push(r);
    }
    onProgress({ band, nodes: filteredNodes, usedRoutes: filteredRoutes });
  };

  while (pq.size > 0) {
    const { cost, id, prevRoute, transfers } = pq.pop()!;

    // 已用更短路徑抵達（lazy deletion，按 (id, transfers) 二維）
    if (cost > (dist[id]?.[transfers] ?? Infinity)) continue;

    // 跨越 band 時 emit 快照（在處理此節點之前）
    while (onProgress && nextBand <= maxTimeMin && cost > nextBand) {
      emitBand(nextBand);
      nextBand += bandStepMin;
    }

    // 超過時間上限，停止擴張此分支
    if (cost > maxTimeMin) continue;

    // 寫入結果（保留最低費時；同節點可能被不同 transfers 數多次處理）
    if (!result[id] || cost < result[id].cost) {
      result[id] = {
        cost,
        via: null,
        lastEdgeType: prevRoute === "start" ? "start" : (prevRoute === "walk" ? "walk" : "bus"),
      };
    }

    if (prevRoute && prevRoute !== "walk" && prevRoute !== "start") {
      if (!usedRoutesSet.has(prevRoute)) {
        usedRoutesSet.add(prevRoute);
        routeFirstCost[prevRoute] = cost;
      }
    }

    const neighborEdges: GraphEdge[] = edges[id] ?? [];

    for (const edge of neighborEdges) {
      const { to, w, t, r, wait } = edge;

      if (!nodes[to]) continue; // 防禦性檢查

      let newCost = cost + w;
      let nextTransfers = transfers;

      if (t === "walk") {
        if (w > SAME_STOP_MIN) {
          // 超過同站閾值的步行 = 真正移動到不同站牌，消耗一次轉乘
          nextTransfers = transfers + 1;
        }
        // 同站閾值內的步行不計轉乘、不改 prevRoute
      } else {
        // t === "bus"
        const routeName = r ?? "bus";
        // 路線切換才算轉乘（walk 已在步行時扣過，此處排除）
        const isRouteChange = prevRoute !== "start" && prevRoute !== "walk" && prevRoute !== routeName;
        if (isRouteChange) {
          nextTransfers = transfers + 1;
          if (wait !== undefined) newCost += wait;
        }
      }

      if (nextTransfers > maxTransfers) continue;
      if (!dist[to]) dist[to] = new Array(maxTransfers + 1).fill(Infinity);
      if (newCost >= dist[to][nextTransfers]) continue;
      if (newCost > maxTimeMin) continue;

      dist[to][nextTransfers] = newCost;
      // 同站閾值內步行保留 prevRoute 脈絡；超過閾值設為 "walk"
      const nextPrevRoute = t === "bus" ? (r ?? "bus") : (w <= SAME_STOP_MIN ? prevRoute : "walk");
      pq.push({ cost: newCost, id: to, prevRoute: nextPrevRoute, transfers: nextTransfers });
    }
  }

  // Dijkstra 結束後，flush 還沒 emit 的 band（例如所有可達點早於 maxTime 就結束）
  while (onProgress && nextBand <= maxTimeMin) {
    emitBand(nextBand);
    nextBand += bandStepMin;
  }
  // 若 maxTimeMin 不是 bandStepMin 的倍數，再補最終 band
  if (onProgress && (nextBand - bandStepMin) < maxTimeMin) {
    emitBand(maxTimeMin);
  }

  return { nodes: result, usedRoutes: Array.from(usedRoutesSet) };
}
