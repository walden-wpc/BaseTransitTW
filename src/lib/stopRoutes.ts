import type { Graph } from "./graphLoader";

/**
 * 取得一個站牌可搭乘的所有路線名稱。
 * 優先使用 node.routes（build_graph 預先建立，含終點站）。
 * 同時合併零距離相鄰站牌（同站牌群）的路線。
 */
export function getStopRoutes(graph: Graph, stopId: string): string[] {
  const routes = new Set<string>();

  const collectRoutes = (uid: string) => {
    const node = graph.nodes[uid];
    if (!node) return;
    // 優先用預建的 routes 列表（包含終點站）
    if (node.routes && node.routes.length > 0) {
      node.routes.forEach(r => routes.add(r));
      return;
    }
    // fallback：掃出發邊（舊圖資相容）
    for (const edge of graph.edges[uid] ?? []) {
      if (edge.t === "bus" && edge.r) routes.add(edge.r);
    }
  };

  // BFS 展開起點站牌群（與 dijkstra.ts SAME_STOP_MIN 閾值一致）
  const SAME_STOP_MIN = 1.0;
  const queue = [stopId];
  const visited = new Set<string>([stopId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    collectRoutes(cur);
    for (const edge of graph.edges[cur] ?? []) {
      if (edge.t === "walk" && edge.w <= SAME_STOP_MIN && !visited.has(edge.to) && graph.nodes[edge.to]) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  return Array.from(routes).sort();
}
