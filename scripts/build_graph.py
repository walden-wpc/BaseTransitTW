"""
build_graph.py — 公車路網圖論建構腳本
用途：將 fetch_tdx.py 的原始資料轉換為前端所需的靜態 graph.json
執行：python build_graph.py [--city Taoyuan]

輸出格式：
{
  "meta": { "city": "...", "node_count": N, "edge_count": N, "generated_at": "..." },
  "nodes": { "UID": { "lat": 0.0, "lon": 0.0, "name": "..." } },
  "edges": { "UID": [ { "to": "UID", "w": 2.5, "t": "bus", "r": "路線名", "wait": 5.0 } ] }
}
"""

import json
import math
import argparse
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

RAW_DIR    = Path(__file__).parent / "raw"
OUTPUT_DIR = Path(__file__).parent.parent / "public" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── 地理運算工具 ──────────────────────────────────────────────────────────────
EARTH_RADIUS_M = 6_371_000
WALK_SPEED_M_PER_MIN  = 80.0          # 步行速度 80 m/min ≈ 4.8 km/h
BUS_SPEED_M_PER_MIN   = 12_000 / 60  # 估算公車速度 12 km/h（無 S2S 資料時備用）
IC_SPEED_M_PER_MIN    = 60_000 / 60  # 國道客運估算速度 60 km/h
WALK_THRESHOLD_M      = 150.0         # 步行轉乘距離閾值
DEFAULT_HEADWAY_MIN   = 12.0          # 無班距資料時預設等候懲罰（分鐘，/2=6分平均等候）

# TDX tdxName → LocationCityCode（國道客運站牌用）
CITY_TO_CODE: dict[str, str] = {
    "Taipei": "TPE", "NewTaipei": "NWT", "Keelung": "KEE",
    "Taoyuan": "TAO", "Hsinchu": "HSZ", "HsinchuCounty": "HSQ",
    "YilanCounty": "ILA", "Taichung": "TXG", "MiaoliCounty": "MIA",
    "ChanghuaCounty": "CHA", "NantouCounty": "NAN", "YunlinCounty": "YUN",
    "Tainan": "TNN", "Kaohsiung": "KHH", "Chiayi": "CYI",
    "ChiayiCounty": "CYQ", "PingtungCounty": "PIF", "HualienCounty": "HUA",
    "TaitungCounty": "TTT", "PenghuCounty": "PEN", "KinmenCounty": "KIN",
    "LienchiangCounty": "LIE",
}


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """計算兩點間球面距離（公尺）"""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi  = math.radians(lat2 - lat1)
    dlam  = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


# ── 空間索引（Grid）加速步行邊搜尋 ────────────────────────────────────────────
class GridIndex:
    """
    將地球表面切成等角格子，快速查找 250m 鄰域。
    粗略：1° ≈ 111km，0.003° ≈ 330m，用 0.003° 格子足夠覆蓋 250m 閾值。
    """
    CELL_DEG = 0.003  # 每格約 330m

    def __init__(self):
        self._grid: dict[tuple, list] = defaultdict(list)

    def _cell(self, lat: float, lon: float) -> tuple:
        return (int(lat / self.CELL_DEG), int(lon / self.CELL_DEG))

    def insert(self, uid: str, lat: float, lon: float):
        self._grid[self._cell(lat, lon)].append((uid, lat, lon))

    def query_neighbors(self, lat: float, lon: float, radius_m: float) -> list:
        """回傳半徑 radius_m 內的所有 (uid, dist_m) 列表"""
        results = []
        cell_r = math.ceil(radius_m / (self.CELL_DEG * 111_000)) + 1
        cx, cy = self._cell(lat, lon)
        for dx in range(-cell_r, cell_r + 1):
            for dy in range(-cell_r, cell_r + 1):
                for uid, nlat, nlon in self._grid.get((cx + dx, cy + dy), []):
                    d = haversine(lat, lon, nlat, nlon)
                    if d <= radius_m:
                        results.append((uid, d))
        return results


# ── 讀取原始資料 ──────────────────────────────────────────────────────────────
def load_json(city: str, suffix: str) -> list:
    path = RAW_DIR / f"{city.lower()}_{suffix}.json"
    if not path.exists():
        print(f"  [!] 找不到 {path}，跳過")
        return []
    return json.loads(path.read_text(encoding="utf-8"))


# ── 國道客運合併 ──────────────────────────────────────────────────────────────
def merge_intercity_routes(
    city: str,
    nodes: dict,
    edges: dict,
    grid: "GridIndex",
    node_routes: dict,
) -> int:
    """
    將國道客運站牌與路線合併至城市圖論。
    找出服務本城市的路線，加入該路線的所有站牌（含外縣市站牌，讓 Dijkstra
    可跨市追蹤國道客運行程）。
    回傳新增的 transit edge 數量。
    """
    city_code = CITY_TO_CODE.get(city)
    if not city_code:
        print(f"  [!] 找不到 {city} 的 LocationCityCode，跳過國道客運合併")
        return 0

    ic_stops_path = RAW_DIR / "intercity_stops.json"
    ic_sor_path   = RAW_DIR / "intercity_stop_of_route.json"
    if not ic_stops_path.exists() or not ic_sor_path.exists():
        print("  [!] 找不到國道客運資料（請先執行 fetch_tdx.py --intercity），略過合併")
        return 0

    ic_stops_raw = json.loads(ic_stops_path.read_text(encoding="utf-8"))
    ic_sor_raw   = json.loads(ic_sor_path.read_text(encoding="utf-8"))

    # 建立站牌 UID → {lat, lon, name} 查找表，並記錄本城市站牌
    ic_stop_map:    dict[str, dict] = {}
    city_stop_uids: set[str]        = set()
    for s in ic_stops_raw:
        uid = s.get("StopUID", "")
        pos = s.get("StopPosition", {})
        lat = pos.get("PositionLat")
        lon = pos.get("PositionLon")
        if not uid or lat is None or lon is None:
            continue
        ic_stop_map[uid] = {
            "lat":  lat,
            "lon":  lon,
            "name": s.get("StopName", {}).get("Zh_tw", ""),
        }
        if s.get("LocationCityCode") == city_code:
            city_stop_uids.add(uid)

    if not city_stop_uids:
        print(f"  [!] 本市（{city_code}）無國道客運站牌，略過合併")
        return 0

    # 找出服務本城市的路線 RouteUID
    relevant_route_uids: set[str] = set()
    for sor in ic_sor_raw:
        for stop in sor.get("Stops", []):
            if stop.get("StopUID", "") in city_stop_uids:
                relevant_route_uids.add(sor.get("RouteUID", ""))
                break

    print(f"  [國道] 城市代碼 {city_code}，本市站牌 {len(city_stop_uids)} 個，"
          f"服務路線 {len(relevant_route_uids)} 條")

    # 加入相關路線的所有站牌（含外縣市，讓 Dijkstra 可完整追蹤跨市行程）
    new_nodes = 0
    for sor in ic_sor_raw:
        if sor.get("RouteUID", "") not in relevant_route_uids:
            continue
        for stop in sor.get("Stops", []):
            uid = stop.get("StopUID", "")
            if uid and uid not in nodes and uid in ic_stop_map:
                data = ic_stop_map[uid]
                nodes[uid] = {"lat": data["lat"], "lon": data["lon"], "name": data["name"]}
                grid.insert(uid, data["lat"], data["lon"])
                new_nodes += 1

    print(f"  [國道] 新增節點：{new_nodes} 個")

    # 建立 transit edges，並為本城市站牌標記路線歸屬
    ic_transit = 0
    for sor in ic_sor_raw:
        if sor.get("RouteUID", "") not in relevant_route_uids:
            continue
        route_name = sor.get("RouteName", {}).get("Zh_tw", sor.get("RouteUID", ""))
        stops_seq  = sorted(sor.get("Stops", []), key=lambda x: x.get("StopSequence", 0))

        for stop in stops_seq:
            uid = stop.get("StopUID", "")
            if uid in city_stop_uids and uid in nodes:
                node_routes[uid].add(route_name)

        for i in range(len(stops_seq) - 1):
            from_uid = stops_seq[i].get("StopUID", "")
            to_uid   = stops_seq[i + 1].get("StopUID", "")
            if from_uid not in nodes or to_uid not in nodes:
                continue
            dist = haversine(
                nodes[from_uid]["lat"], nodes[from_uid]["lon"],
                nodes[to_uid]["lat"],   nodes[to_uid]["lon"],
            )
            w = dist / IC_SPEED_M_PER_MIN
            edges[from_uid].append({
                "to":   to_uid,
                "w":    round(w, 3),
                "t":    "bus",
                "r":    route_name,
                "wait": round(DEFAULT_HEADWAY_MIN / 2.0, 2),
            })
            ic_transit += 1

    print(f"  [國道] 新增 Transit Edges：{ic_transit} 條")
    return ic_transit


# ── 主要建圖邏輯 ──────────────────────────────────────────────────────────────
def build_graph(city: str, with_intercity: bool = False) -> dict:
    print(f"\n=== 建構 {city} 路網圖 ===\n")

    # 1. 讀取原始資料
    routes_raw    = load_json(city, "routes")
    stops_raw     = load_json(city, "stops")
    sor_raw       = load_json(city, "stop_of_route")   # Stop Of Route
    s2s_raw       = load_json(city, "s2s_travel_time")

    # 2. 建立路線班距查找表 { RouteUID: wait_min }
    route_wait: dict[str, float] = {}
    for r in routes_raw:
        uid = r.get("RouteUID", "")
        hw  = r.get("HeadwayMin") or r.get("Headway") or None
        if hw is not None:
            try:
                route_wait[uid] = float(hw) / 2.0
            except (TypeError, ValueError):
                pass
    print(f"  路線班距資料：{len(route_wait)} 條路線有 HeadwayMin")

    # 3. 建立站牌節點 { UID: {lat, lon, name} }
    nodes: dict[str, dict] = {}
    grid = GridIndex()

    for s in stops_raw:
        uid  = s.get("StopUID", "")
        name = s.get("StopName", {}).get("Zh_tw", "未知站牌")
        pos  = s.get("StopPosition", {})
        lat  = pos.get("PositionLat")
        lon  = pos.get("PositionLon")
        if not uid or lat is None or lon is None:
            continue
        nodes[uid] = {"lat": lat, "lon": lon, "name": name}
        grid.insert(uid, lat, lon)

    print(f"  站牌節點：{len(nodes)} 個")

    # 4. 建立 S2S 行駛時間查找表 { (RouteUID, Dir, FromUID, ToUID): seconds }
    s2s_map: dict[tuple, float] = {}
    for entry in s2s_raw:
        key = (
            entry.get("RouteUID", ""),
            entry.get("Direction", 0),
            entry.get("FromStopUID", ""),
            entry.get("ToStopUID",   ""),
        )
        rt = entry.get("RunTime")
        if rt is not None:
            s2s_map[key] = float(rt)

    print(f"  S2S 站間時間：{len(s2s_map)} 筆")

    # 5. 建立邊（adjacency list）
    edges: dict[str, list] = defaultdict(list)
    transit_count = 0
    walk_count    = 0
    fallback_count = 0

    # 5a. Transit Edges（搭車邊）
    # 每個節點的服務路線集合（含終點站）
    node_routes: dict[str, set] = defaultdict(set)

    for sor in sor_raw:
        route_uid  = sor.get("RouteUID", "")
        route_name = sor.get("RouteName", {}).get("Zh_tw", route_uid)
        direction  = sor.get("Direction", 0)
        stops_seq  = sorted(sor.get("Stops", []), key=lambda x: x.get("StopSequence", 0))
        wait_min   = route_wait.get(route_uid, DEFAULT_HEADWAY_MIN / 2.0)

        for stop in stops_seq:
            uid = stop.get("StopUID", "")
            if uid in nodes:
                node_routes[uid].add(route_name)

        for i in range(len(stops_seq) - 1):
            from_uid = stops_seq[i].get("StopUID", "")
            to_uid   = stops_seq[i + 1].get("StopUID", "")

            if from_uid not in nodes or to_uid not in nodes:
                continue

            # 查找實際行駛時間（秒→分鐘）
            s2s_key = (route_uid, direction, from_uid, to_uid)
            if s2s_key in s2s_map:
                w = s2s_map[s2s_key] / 60.0
            else:
                # 降級：用直線距離估算
                dist = haversine(
                    nodes[from_uid]["lat"], nodes[from_uid]["lon"],
                    nodes[to_uid]["lat"],   nodes[to_uid]["lon"],
                )
                w = dist / BUS_SPEED_M_PER_MIN
                fallback_count += 1

            edges[from_uid].append({
                "to":   to_uid,
                "w":    round(w, 3),
                "t":    "bus",
                "r":    route_name,
                "wait": round(wait_min, 2),
            })
            transit_count += 1

    print(f"  Transit Edges：{transit_count} 條（其中 {fallback_count} 條使用距離估算）")

    # 5b. 合併國道客運（在步行邊之前，讓國道站牌能與城市站牌建立步行連接）
    if with_intercity:
        ic_count = merge_intercity_routes(city, nodes, edges, grid, node_routes)
        transit_count += ic_count

    # 將服務路線列表寫入節點（含國道客運路線）
    for uid, route_set in node_routes.items():
        if uid in nodes:
            nodes[uid]["routes"] = sorted(route_set)

    # 5c. Walk Edges（步行轉乘邊，此時 grid 已含國道客運站牌）
    for uid, node in nodes.items():
        neighbors = grid.query_neighbors(node["lat"], node["lon"], WALK_THRESHOLD_M)
        for n_uid, dist_m in neighbors:
            if n_uid == uid:
                continue
            w = dist_m / WALK_SPEED_M_PER_MIN
            edges[uid].append({
                "to": n_uid,
                "w":  round(w, 3),
                "t":  "walk",
            })
            walk_count += 1

    print(f"  Walk Edges：{walk_count} 條（雙向計入）")

    # 6. 組裝輸出
    graph = {
        "meta": {
            "city":           city,
            "node_count":     len(nodes),
            "edge_count":     transit_count + walk_count,
            "transit_edges":  transit_count,
            "walk_edges":     walk_count,
            "generated_at":   datetime.now(timezone.utc).isoformat(),
        },
        "nodes": nodes,
        "edges": dict(edges),
    }

    return graph


# ── 主程式 ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="公車路網圖論建構腳本")
    parser.add_argument("--city",      default="Taoyuan", help="縣市名稱（英文）")
    parser.add_argument("--intercity", action="store_true",
                        help="合併國道客運資料（需先執行 fetch_tdx.py --intercity）")
    args = parser.parse_args()

    graph = build_graph(args.city, with_intercity=args.intercity)

    out_path = OUTPUT_DIR / f"{args.city.lower()}.json"
    out_path.write_text(
        json.dumps(graph, ensure_ascii=False, separators=(",", ":")),  # 緊湊格式，縮小檔案大小
        encoding="utf-8",
    )

    meta = graph["meta"]
    print(f"\n[OK] Done! Output: {out_path}")
    print(f"   Nodes: {meta['node_count']}")
    print(f"   Edges: {meta['edge_count']} (Transit: {meta['transit_edges']}, Walk: {meta['walk_edges']})")
    print(f"   File size: {out_path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
