"""
generate_shapes.py — 公車路線幾何形狀生成腳本
用途：呼叫 TDX Shape API 取得真實路線幾何；若無 API 金鑰則從 graph.json 重建
執行：python generate_shapes.py [--city Taoyuan] [--fallback]
"""

import os
import sys
import json
import time
import argparse
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

TDX_CLIENT_ID     = os.getenv("TDX_CLIENT_ID", "")
TDX_CLIENT_SECRET = os.getenv("TDX_CLIENT_SECRET", "")
TDX_AUTH_URL      = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
TDX_API_BASE      = "https://tdx.transportdata.tw/api/basic"

RAW_DIR    = Path(__file__).parent / "raw"
OUTPUT_DIR = Path(__file__).parent.parent / "public" / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ── OAuth Token ───────────────────────────────────────────────────────────────
def get_access_token() -> str:
    resp = requests.post(
        TDX_AUTH_URL,
        data={
            "grant_type":    "client_credentials",
            "client_id":     TDX_CLIENT_ID,
            "client_secret": TDX_CLIENT_SECRET,
        },
        timeout=15,
    )
    resp.raise_for_status()
    print("[Auth] Token 取得成功")
    return resp.json()["access_token"]


# ── 從 TDX Shape API 取得真實路線幾何 ─────────────────────────────────────────
def fetch_shapes_from_tdx(city: str) -> dict:
    """
    呼叫 /v2/Bus/Shape/City/{city}
    回傳 { route_name: GeoJSON Feature } 字典
    """
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Accept-Encoding": "gzip"}
    shapes: dict = {}
    skip = 0
    top  = 1000

    print(f"[TDX] 擷取 {city} 路線幾何...")

    while True:
        url = f"{TDX_API_BASE}/v2/Bus/Shape/City/{city}?$format=JSON&$top={top}&$skip={skip}"
        resp = requests.get(url, headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        batch = data if isinstance(data, list) else data.get("value", [])

        for item in batch:
            route_name = item.get("RouteName", {}).get("Zh_tw") or item.get("RouteUID", "")
            geometry_str = item.get("Geometry", "")
            if not route_name or not geometry_str:
                continue

            # TDX 幾何欄位是 WKT 格式，解析後回傳多段列表
            segments = _parse_wkt_linestring(geometry_str)
            if not segments:
                continue

            # 同路線多個 direction/sub-route → 合併為 MultiLineString
            if route_name not in shapes:
                shapes[route_name] = {
                    "type": "Feature",
                    "properties": {"name": route_name},
                    "geometry": {"type": "MultiLineString", "coordinates": []},
                }
            # 將所有段加入（修復舊版只取 MULTILINESTRING 第一段的 bug）
            for seg in segments:
                shapes[route_name]["geometry"]["coordinates"].append(seg)

        print(f"  skip={skip} 取得 {len(batch)} 筆，累計路線數 {len(shapes)}")
        if len(batch) < top:
            break
        skip += top

    return shapes


def _parse_wkt_linestring(wkt: str) -> list[list]:
    """
    將 WKT 幾何解析為座標段列表（list of segments）。
    LINESTRING → [[pt, pt, ...]] （單段）
    MULTILINESTRING → [[pt, pt, ...], [pt, pt, ...], ...] （多段，不再只取第一段）
    """
    def _parse_segment(seg_str: str) -> list:
        coords = []
        for pair in seg_str.strip().split(","):
            parts = pair.strip().split()
            if len(parts) >= 2:
                try:
                    coords.append([float(parts[0]), float(parts[1])])
                except ValueError:
                    pass
        return coords

    try:
        wkt = wkt.strip()
        if wkt.upper().startswith("MULTILINESTRING"):
            # 擷取 (( ... )) 之間的所有段
            inner = wkt[wkt.index("((") + 2 : wkt.rindex("))")]
            segments = []
            for seg_str in inner.split("),("):
                seg = _parse_segment(seg_str)
                if seg:
                    segments.append(seg)
            return segments
        elif wkt.upper().startswith("LINESTRING"):
            inner = wkt[wkt.index("(") + 1 : wkt.rindex(")")]
            seg = _parse_segment(inner)
            return [seg] if seg else []
        else:
            return []
    except Exception:
        return []


# ── Fallback：從 graph.json 重建路線幾何 ──────────────────────────────────────
def build_shapes_from_graph(city: str) -> dict:
    """當沒有 TDX Key 或 API 失敗時，從已建好的 graph.json 重建路線幾何"""
    graph_path = OUTPUT_DIR / f"{city.lower()}.json"
    if not graph_path.exists():
        raise FileNotFoundError(
            f"找不到 {graph_path}，請先執行 build_graph.py --city {city}"
        )

    print(f"[Fallback] 從 {graph_path} 重建路線幾何...")
    with open(graph_path, encoding="utf-8") as f:
        data = json.load(f)

    nodes = data["nodes"]
    edges = data["edges"]
    route_segments: dict[str, list] = {}

    for start_id, edge_list in edges.items():
        if start_id not in nodes:
            continue
        s = nodes[start_id]
        for edge in edge_list:
            if edge.get("t") != "bus" or not edge.get("r"):
                continue
            route_name = edge["r"]
            end_id = edge["to"]
            if end_id not in nodes:
                continue
            e = nodes[end_id]
            route_segments.setdefault(route_name, []).append(
                [[s["lon"], s["lat"]], [e["lon"], e["lat"]]]
            )

    shapes = {}
    for route_name, segments in route_segments.items():
        shapes[route_name] = {
            "type": "Feature",
            "properties": {"name": route_name},
            "geometry": {"type": "MultiLineString", "coordinates": segments},
        }

    print(f"[Fallback] 重建了 {len(shapes)} 條路線")
    return shapes


# ── 主程式 ────────────────────────────────────────────────────────────────────
def compute_headways(city: str) -> dict:
    """
    從 schedule.json 計算每條路線的平日/假日班距（分鐘）。
    回傳 { route_name: { "weekday": N, "weekend": N } }

    處理循環路線（只有 Dir0）：直接用 Dir0 的班距。
    班距計算：取首班站發車時間，排序後算相鄰班次間隔的中位數，
             只考慮 06:00–22:00 之間的班次（排除夜班干擾）。
    """
    schedule_path = RAW_DIR / f"{city.lower()}_schedule.json"
    if not schedule_path.exists():
        print(f"  [!] 找不到 {schedule_path}，跳過班距計算")
        return {}

    schedule = json.loads(schedule_path.read_text(encoding="utf-8"))

    # 收集每條路線每個方向的平日/假日發車時間
    # { route_name: { direction: { "weekday": [min,...], "weekend": [min,...] } } }
    from collections import defaultdict
    route_times: dict = defaultdict(lambda: defaultdict(lambda: {"weekday": [], "weekend": []}))

    for entry in schedule:
        rname = entry.get("RouteName", {}).get("Zh_tw", "")
        direction = entry.get("Direction", 0)
        if not rname:
            continue

        for trip in entry.get("Timetables", []):
            sd = trip.get("ServiceDay", {})
            stop_times = trip.get("StopTimes", [])
            if not stop_times:
                continue

            # 取第一站的發車時間
            dep_str = stop_times[0].get("DepartureTime", "")
            if not dep_str or ":" not in dep_str:
                continue

            try:
                h, m = int(dep_str.split(":")[0]), int(dep_str.split(":")[1])
            except ValueError:
                continue

            # 只計算 06:00–22:00 之間的班次
            total_min = h * 60 + m
            if not (360 <= total_min <= 1320):
                continue

            is_weekday = any(sd.get(d, 0) for d in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
            is_weekend = any(sd.get(d, 0) for d in ["Saturday", "Sunday"])

            if is_weekday:
                route_times[rname][direction]["weekday"].append(total_min)
            if is_weekend:
                route_times[rname][direction]["weekend"].append(total_min)

    def median_interval(times: list) -> float | None:
        if len(times) < 2:
            return None
        times = sorted(set(times))
        intervals = [times[i+1] - times[i] for i in range(len(times)-1)
                     if 0 < times[i+1] - times[i] <= 120]
        if not intervals:
            return None
        intervals.sort()
        return intervals[len(intervals) // 2]

    result = {}
    for rname, dir_data in route_times.items():
        # 是否為循環路線（只有單方向）
        dirs = list(dir_data.keys())
        is_circular = len(dirs) == 1

        # 優先取 Dir0；循環路線 Dir0 即代表全路線
        primary_dir = dirs[0]

        weekday_hw = median_interval(dir_data[primary_dir]["weekday"])
        weekend_hw = median_interval(dir_data[primary_dir]["weekend"])

        # 若某類型沒資料，用另一類型補
        if weekday_hw is None:
            weekday_hw = weekend_hw
        if weekend_hw is None:
            weekend_hw = weekday_hw

        if weekday_hw is not None:
            result[rname] = {
                "headway_weekday": round(weekday_hw, 1),
                "headway_weekend": round(weekend_hw, 1) if weekend_hw else round(weekday_hw, 1),
                "is_circular": is_circular,
            }

    print(f"[Headway] 計算完成：{len(result)} 條路線有班距資料")
    # 統計分佈
    bands = {"<10":0, "10-20":0, "20-40":0, "40-60":0, "60+":0}
    for v in result.values():
        hw = v["headway_weekday"]
        if hw < 10: bands["<10"] += 1
        elif hw < 20: bands["10-20"] += 1
        elif hw < 40: bands["20-40"] += 1
        elif hw < 60: bands["40-60"] += 1
        else: bands["60+"] += 1
    print(f"  班距分佈: {bands}")
    return result


def load_route_meta(city: str) -> dict:
    """從 raw routes.json 建立路線元資訊查找表 { route_name: {departure, destination, headsign, operator} }"""
    routes_path = RAW_DIR / f"{city.lower()}_routes.json"
    if not routes_path.exists():
        return {}

    meta = {}
    routes = json.loads(routes_path.read_text(encoding="utf-8"))
    for r in routes:
        name = r.get("RouteName", {}).get("Zh_tw", "")
        if not name:
            continue
        # Headsign 取 Direction=0 的 SubRoute
        headsign = ""
        for sub in r.get("SubRoutes", []):
            if sub.get("Direction", 0) == 0:
                headsign = sub.get("Headsign", "") or sub.get("HeadsignEn", "")
                break

        meta[name] = {
            "departure":   r.get("DepartureStopNameZh", ""),
            "destination": r.get("DestinationStopNameZh", ""),
            "headsign":    headsign,
            "operator":    r.get("Operators", [{}])[0].get("OperatorName", {}).get("Zh_tw", "") if r.get("Operators") else "",
        }
    print(f"[Meta] 載入 {len(meta)} 條路線元資訊")
    return meta


def fetch_intercity_shapes_from_tdx() -> dict:
    """從 TDX Shape API 取得國道客運路線幾何（含 429 重試）"""
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Accept-Encoding": "gzip"}
    shapes: dict = {}
    skip = 0
    top  = 1000

    print("[TDX] 擷取國道客運路線幾何...")

    while True:
        url = f"{TDX_API_BASE}/v2/Bus/Shape/InterCity?$format=JSON&$top={top}&$skip={skip}"

        for attempt in range(5):
            resp = requests.get(url, headers=headers, timeout=60)
            if resp.status_code == 429:
                wait = 20 * (attempt + 1)
                print(f"  [429] Rate limit，等待 {wait}s 後重試 ({attempt+1}/5)...")
                time.sleep(wait)
            else:
                resp.raise_for_status()
                break
        else:
            raise RuntimeError("連續 5 次 429，請稍候再試")

        data = resp.json()
        batch = data if isinstance(data, list) else data.get("value", [])

        for item in batch:
            route_name = item.get("RouteName", {}).get("Zh_tw") or item.get("RouteUID", "")
            geometry_str = item.get("Geometry", "")
            if not route_name or not geometry_str:
                continue
            segments = _parse_wkt_linestring(geometry_str)
            if not segments:
                continue
            if route_name not in shapes:
                shapes[route_name] = {
                    "type": "Feature",
                    "properties": {"name": route_name},
                    "geometry": {"type": "MultiLineString", "coordinates": []},
                }
            for seg in segments:
                shapes[route_name]["geometry"]["coordinates"].append(seg)

        print(f"  skip={skip} 取得 {len(batch)} 筆，累計路線數 {len(shapes)}")
        if len(batch) < top:
            break
        skip += top
        time.sleep(1.0)

    return shapes


def build_intercity_city_map() -> dict[str, list[str]]:
    """
    從 raw/intercity_stop_of_route.json + intercity_stops.json
    建立 { route_name: [city1, city2, ...] } 的服務縣市對照表。
    city 使用 TDX 英文名稱（與 CITY_CONFIGS 的 tdxName 一致）。
    國道客運站牌只有 LocationCityCode（三碼），需轉換。
    """
    # LocationCityCode → TDX tdxName 對照
    CODE_TO_CITY: dict[str, str] = {
        "TPE": "Taipei",
        "NWT": "NewTaipei",
        "KEE": "Keelung",
        "TAO": "Taoyuan",
        "HSZ": "Hsinchu",
        "HSQ": "HsinchuCounty",
        "ILA": "YilanCounty",
        "TXG": "Taichung",
        "MIA": "MiaoliCounty",
        "CHA": "ChanghuaCounty",
        "NAN": "NantouCounty",
        "YUN": "YunlinCounty",
        "TNN": "Tainan",
        "KHH": "Kaohsiung",
        "CYI": "Chiayi",
        "CYQ": "ChiayiCounty",
        "PIF": "PingtungCounty",
        "HUA": "HualienCounty",
        "TTT": "TaitungCounty",
        "PEN": "PenghuCounty",
        "KIN": "KinmenCounty",
        "LIE": "LienchiangCounty",
    }

    stops_path = RAW_DIR / "intercity_stops.json"
    sor_path   = RAW_DIR / "intercity_stop_of_route.json"
    if not stops_path.exists() or not sor_path.exists():
        print("  [!] 找不到 intercity_stops/stop_of_route，跳過縣市對照")
        return {}

    stops_raw = json.loads(stops_path.read_text(encoding="utf-8"))
    sor_raw   = json.loads(sor_path.read_text(encoding="utf-8"))

    # 建立 stop UID → tdxName 對照（via LocationCityCode）
    stop_city: dict[str, str] = {}
    for s in stops_raw:
        uid  = s.get("StopUID", "")
        code = s.get("LocationCityCode", "")
        city = CODE_TO_CITY.get(code, "")
        if uid and city:
            stop_city[uid] = city

    # 每條路線彙整服務縣市
    route_cities: dict[str, set] = {}
    for sor in sor_raw:
        rname = sor.get("RouteName", {}).get("Zh_tw", "")
        if not rname:
            continue
        for stop in sor.get("Stops", []):
            uid = stop.get("StopUID", "")
            city = stop_city.get(uid, "")
            if city:
                route_cities.setdefault(rname, set()).add(city)

    print(f"[Intercity] 建立了 {len(route_cities)} 條路線的縣市對照")
    return {k: sorted(v) for k, v in route_cities.items()}


def generate_intercity_shapes() -> None:
    """生成國道客運 shapes（intercity_shapes.json），含服務縣市清單"""
    if not TDX_CLIENT_ID or not TDX_CLIENT_SECRET:
        print("[錯誤] 未設定 TDX API 金鑰，無法生成國道客運幾何")
        sys.exit(1)

    try:
        shapes = fetch_intercity_shapes_from_tdx()
    except Exception as e:
        print(f"[錯誤] TDX 國道客運 Shape API 失敗：{e}")
        sys.exit(1)

    meta     = load_route_meta("intercity")
    headways = compute_headways("intercity")
    city_map = build_intercity_city_map()

    for name, feature in shapes.items():
        m  = meta.get(name, {})
        hw = headways.get(name, {})
        feature["properties"].update({
            "departure":       m.get("departure", ""),
            "destination":     m.get("destination", ""),
            "headsign":        m.get("headsign", ""),
            "operator":        m.get("operator", ""),
            "headway_weekday": hw.get("headway_weekday", -1),
            "headway_weekend": hw.get("headway_weekend", -1),
            "is_circular":     hw.get("is_circular", False),
            "cities":          city_map.get(name, []),  # 服務縣市列表
        })

    out_path = OUTPUT_DIR / "intercity_shapes.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(shapes, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"\n[OK] Done! Output: {out_path}")
    print(f"   路線數：{len(shapes)}")
    print(f"   File size: {size_kb:.1f} KB")

    # 同時輸出國道客運站牌 GeoJSON（供地圖直接顯示站點用）
    stops_path = RAW_DIR / "intercity_stops.json"
    if stops_path.exists():
        ic_stops_raw = json.loads(stops_path.read_text(encoding="utf-8"))
        stop_features = []
        for s in ic_stops_raw:
            uid  = s.get("StopUID", "")
            pos  = s.get("StopPosition", {})
            lat  = pos.get("PositionLat")
            lon  = pos.get("PositionLon")
            name = s.get("StopName", {}).get("Zh_tw", "")
            code = s.get("LocationCityCode", "")
            if uid and lat is not None and lon is not None:
                stop_features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"uid": uid, "name": name, "cityCode": code},
                })
        stops_geo = {"type": "FeatureCollection", "features": stop_features}
        stops_out = OUTPUT_DIR / "intercity_stops_geo.json"
        with open(stops_out, "w", encoding="utf-8") as f:
            json.dump(stops_geo, f, ensure_ascii=False, separators=(",", ":"))
        print(f"   站牌 GeoJSON：{stops_out} ({len(stop_features)} 站)")


def merge_intercity_into_city(city_tdx: str, shapes: dict) -> int:
    """
    從已生成的 intercity_shapes.json 篩選服務本城市的國道路線，合併進 shapes。
    若 intercity_shapes.json 不存在則靜默跳過（不影響城市 shapes 生成）。
    city_tdx: TDX tdxName，e.g. "Taoyuan"
    回傳合併路線數。
    """
    ic_path = OUTPUT_DIR / "intercity_shapes.json"
    if not ic_path.exists():
        return 0
    try:
        ic_shapes = json.loads(ic_path.read_text(encoding="utf-8"))
    except Exception:
        return 0

    merged = 0
    for name, feat in ic_shapes.items():
        served_cities: list[str] = feat.get("properties", {}).get("cities", [])
        if city_tdx in served_cities and name not in shapes:
            shapes[name] = feat
            merged += 1

    if merged:
        print(f"  [國道] 合併 {merged} 條國道客運路線（來源：intercity_shapes.json）")
    return merged


def main():
    parser = argparse.ArgumentParser(description="公車路線幾何形狀生成腳本")
    parser.add_argument("--city",      default="Taoyuan", help="縣市名稱（英文，例如 Taoyuan）")
    parser.add_argument("--fallback",  action="store_true", help="強制使用 graph.json 重建（不呼叫 TDX API）")
    parser.add_argument("--intercity", action="store_true", help="生成國道客運（城際公車）幾何")
    parser.add_argument("--force",     action="store_true",
                        help="強制覆蓋：即使 TDX API 失敗也改用 fallback 覆蓋既有檔案（預設：失敗時保留現有檔案）")
    args = parser.parse_args()

    if args.intercity:
        print("=== 國道客運路線幾何生成 ===\n")
        generate_intercity_shapes()
        return

    city = args.city

    out_path_check = OUTPUT_DIR / f"{city.lower()}_shapes.json"

    if args.fallback or not TDX_CLIENT_ID or not TDX_CLIENT_SECRET:
        if not args.fallback:
            print("[警告] 未設定 TDX API 金鑰，改用 fallback 模式")
        shapes = build_shapes_from_graph(city)
    else:
        try:
            shapes = fetch_shapes_from_tdx(city)
        except Exception as e:
            # TDX API 失敗時：預設保留舊檔；加 --force 才允許用 fallback 覆蓋
            if out_path_check.exists() and not args.force:
                print(f"[警告] TDX Shape API 失敗：{e}")
                print(f"  → 已有 {out_path_check.name}，保留現有資料（加 --force 可改用 fallback 覆蓋）")
                return
            print(f"[警告] TDX Shape API 失敗：{e}，改用 fallback 模式")
            shapes = build_shapes_from_graph(city)

    # 將路線元資訊合併進 shapes properties
    meta = load_route_meta(city)
    headways = compute_headways(city)
    for name, feature in shapes.items():
        m = meta.get(name, {})
        hw = headways.get(name, {})
        feature["properties"].update({
            "departure":        m.get("departure", ""),
            "destination":      m.get("destination", ""),
            "headsign":         m.get("headsign", ""),
            "operator":         m.get("operator", ""),
            "headway_weekday":  hw.get("headway_weekday", -1),
            "headway_weekend":  hw.get("headway_weekend", -1),
            "is_circular":      hw.get("is_circular", False),
        })

    # 合併國道客運路線至城市 shapes（若 intercity_shapes.json 已存在）
    merge_intercity_into_city(city, shapes)

    out_path = OUTPUT_DIR / f"{city.lower()}_shapes.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(shapes, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"\n[OK] Done! Output: {out_path}")
    print(f"   路線數：{len(shapes)}")
    print(f"   File size: {size_kb:.1f} KB")


if __name__ == "__main__":
    main()
