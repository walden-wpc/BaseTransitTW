"""
fetch_tdx.py — TDX API 資料擷取腳本
用途：呼叫 TDX 運輸資料流通服務 API，取得桃園市公車路網原始資料
執行：python fetch_tdx.py [--city Taoyuan] [--mock]
"""

import os
import sys
import json
import time
import argparse
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from pathlib import Path
from dotenv import load_dotenv

# ── 載入環境變數 ─────────────────────────────────────────────────────────────
load_dotenv(Path(__file__).parent / ".env")

TDX_CLIENT_ID     = os.getenv("TDX_CLIENT_ID", "")
TDX_CLIENT_SECRET = os.getenv("TDX_CLIENT_SECRET", "")
TDX_AUTH_URL      = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
TDX_API_BASE      = "https://tdx.transportdata.tw/api/basic"

OUTPUT_DIR = Path(__file__).parent / "raw"
OUTPUT_DIR.mkdir(exist_ok=True)


# ── OAuth Token ───────────────────────────────────────────────────────────────
def get_access_token() -> str:
    """取得 TDX OAuth 2.0 Access Token"""
    if not TDX_CLIENT_ID or not TDX_CLIENT_SECRET:
        raise RuntimeError(
            "TDX API 金鑰未設定！請在 scripts/.env 填入 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET"
        )
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
    token = resp.json()["access_token"]
    print(f"[Auth] Token 取得成功")
    return token


# ── 通用 API 擷取（含 OData 分頁） ────────────────────────────────────────────
def fetch_all(token: str, endpoint: str, top: int = 1000) -> list:
    """
    處理 OData $top/$skip 分頁，自動拉完所有資料
    endpoint 範例：/v2/Bus/Route/City/Taoyuan
    """
    headers = {"Authorization": f"Bearer {token}", "Accept-Encoding": "gzip"}
    results = []
    skip = 0

    while True:
        url = f"{TDX_API_BASE}{endpoint}?$format=JSON&$top={top}&$skip={skip}"

        # 429 時自動等待後重試（最多 5 次）
        for attempt in range(5):
            resp = requests.get(url, headers=headers, timeout=60)
            if resp.status_code == 429:
                wait = 15 * (attempt + 1)
                print(f"  [429] Rate limit，等待 {wait}s 後重試 ({attempt+1}/5)...")
                time.sleep(wait)
            else:
                resp.raise_for_status()
                break
        else:
            raise RuntimeError(f"連續 5 次 429，請稍後再試：{url}")

        data = resp.json()

        # TDX 有時回傳 list，有時包在 dict 的 value 裡
        if isinstance(data, list):
            batch = data
        elif isinstance(data, dict):
            batch = data.get("value", data.get("BusRoutes", data.get("Buses", [])))
        else:
            batch = []

        results.extend(batch)
        print(f"  → {endpoint.split('/')[-1]} skip={skip} 取得 {len(batch)} 筆，累計 {len(results)}")

        if len(batch) < top:
            break  # 不足一頁，表示已到底
        skip += top
        time.sleep(1.0)  # 頁間間隔 1 秒，避免 rate limit

    return results


# ── Mock 模式（無需 TDX API Key，用假資料測試流程） ───────────────────────────
def generate_mock_data(city: str) -> None:
    """產生少量假站牌資料，用於在沒有 TDX Key 時驗證 build_graph.py 流程"""
    print(f"[Mock] 產生 {city} 假資料...")

    # 假設桃園市區幾個站牌
    stops = [
        {"StopUID": "TYC_S001", "StopName": {"Zh_tw": "桃園車站"}, "StopPosition": {"PositionLat": 24.9894, "PositionLon": 121.3128}},
        {"StopUID": "TYC_S002", "StopName": {"Zh_tw": "縣府路口"}, "StopPosition": {"PositionLat": 24.9921, "PositionLon": 121.3085}},
        {"StopUID": "TYC_S003", "StopName": {"Zh_tw": "桃園市政府"}, "StopPosition": {"PositionLat": 24.9948, "PositionLon": 121.3031}},
        {"StopUID": "TYC_S004", "StopName": {"Zh_tw": "中正公園"}, "StopPosition": {"PositionLat": 24.9871, "PositionLon": 121.3174}},
        {"StopUID": "TYC_S005", "StopName": {"Zh_tw": "中壢車站"}, "StopPosition": {"PositionLat": 24.9538, "PositionLon": 121.2257}},
        {"StopUID": "TYC_S006", "StopName": {"Zh_tw": "中壢後站"}, "StopPosition": {"PositionLat": 24.9521, "PositionLon": 121.2243}},
        {"StopUID": "TYC_S007", "StopName": {"Zh_tw": "環北路口"}, "StopPosition": {"PositionLat": 24.9601, "PositionLon": 121.2308}},
        {"StopUID": "TYC_S008", "StopName": {"Zh_tw": "中原大學"}, "StopPosition": {"PositionLat": 24.9678, "PositionLon": 121.2437}},
        {"StopUID": "TYC_S009", "StopName": {"Zh_tw": "八德區公所"}, "StopPosition": {"PositionLat": 24.9426, "PositionLon": 121.2913}},
        {"StopUID": "TYC_S010", "StopName": {"Zh_tw": "介壽路口"}, "StopPosition": {"PositionLat": 24.9437, "PositionLon": 121.2974}},
    ]

    # 路線一：桃園幹線 (TYC_S001 → TYC_S004, 中間站 S002, S003)
    stop_of_route = [
        {
            "RouteUID": "TYC_R1", "RouteName": {"Zh_tw": "桃園幹線"},
            "Direction": 0,
            "Stops": [
                {"StopUID": "TYC_S001", "StopSequence": 1},
                {"StopUID": "TYC_S002", "StopSequence": 2},
                {"StopUID": "TYC_S003", "StopSequence": 3},
                {"StopUID": "TYC_S004", "StopSequence": 4},
            ]
        },
        {
            "RouteUID": "TYC_R2", "RouteName": {"Zh_tw": "中壢快線"},
            "Direction": 0,
            "Stops": [
                {"StopUID": "TYC_S005", "StopSequence": 1},
                {"StopUID": "TYC_S006", "StopSequence": 2},
                {"StopUID": "TYC_S007", "StopSequence": 3},
                {"StopUID": "TYC_S008", "StopSequence": 4},
            ]
        },
        {
            "RouteUID": "TYC_R3", "RouteName": {"Zh_tw": "桃中直達"},
            "Direction": 0,
            "Stops": [
                {"StopUID": "TYC_S001", "StopSequence": 1},
                {"StopUID": "TYC_S009", "StopSequence": 2},
                {"StopUID": "TYC_S010", "StopSequence": 3},
                {"StopUID": "TYC_S005", "StopSequence": 4},
            ]
        },
    ]

    # 站間行駛時間（秒）
    s2s = [
        {"RouteUID": "TYC_R1", "Direction": 0, "FromStopUID": "TYC_S001", "ToStopUID": "TYC_S002", "RunTime": 90},
        {"RouteUID": "TYC_R1", "Direction": 0, "FromStopUID": "TYC_S002", "ToStopUID": "TYC_S003", "RunTime": 120},
        {"RouteUID": "TYC_R1", "Direction": 0, "FromStopUID": "TYC_S003", "ToStopUID": "TYC_S004", "RunTime": 75},
        {"RouteUID": "TYC_R2", "Direction": 0, "FromStopUID": "TYC_S005", "ToStopUID": "TYC_S006", "RunTime": 60},
        {"RouteUID": "TYC_R2", "Direction": 0, "FromStopUID": "TYC_S006", "ToStopUID": "TYC_S007", "RunTime": 180},
        {"RouteUID": "TYC_R2", "Direction": 0, "FromStopUID": "TYC_S007", "ToStopUID": "TYC_S008", "RunTime": 240},
        {"RouteUID": "TYC_R3", "Direction": 0, "FromStopUID": "TYC_S001", "ToStopUID": "TYC_S009", "RunTime": 600},
        {"RouteUID": "TYC_R3", "Direction": 0, "FromStopUID": "TYC_S009", "ToStopUID": "TYC_S010", "RunTime": 120},
        {"RouteUID": "TYC_R3", "Direction": 0, "FromStopUID": "TYC_S010", "ToStopUID": "TYC_S005", "RunTime": 540},
    ]

    # 路線班距（分鐘）
    routes = [
        {"RouteUID": "TYC_R1", "RouteName": {"Zh_tw": "桃園幹線"}, "HeadwayMin": 10},
        {"RouteUID": "TYC_R2", "RouteName": {"Zh_tw": "中壢快線"}, "HeadwayMin": 15},
        {"RouteUID": "TYC_R3", "RouteName": {"Zh_tw": "桃中直達"}, "HeadwayMin": 20},
    ]

    (OUTPUT_DIR / f"{city.lower()}_stops.json").write_text(json.dumps(stops, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / f"{city.lower()}_stop_of_route.json").write_text(json.dumps(stop_of_route, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / f"{city.lower()}_s2s_travel_time.json").write_text(json.dumps(s2s, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / f"{city.lower()}_routes.json").write_text(json.dumps(routes, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[Mock] Done! Raw data saved to scripts/raw/{city.lower()}_*.json")


# ── 真實 TDX 模式 ─────────────────────────────────────────────────────────────
def fetch_real_data(city: str) -> None:
    """使用 TDX API 取得真實路網資料"""
    token = get_access_token()

    endpoints = {
        f"{city.lower()}_routes.json":           f"/v2/Bus/Route/City/{city}",
        f"{city.lower()}_stops.json":             f"/v2/Bus/Stop/City/{city}",
        f"{city.lower()}_stop_of_route.json":     f"/v2/Bus/StopOfRoute/City/{city}",
        f"{city.lower()}_s2s_travel_time.json":   f"/v3/Bus/S2STravelTime/City/{city}",
        f"{city.lower()}_schedule.json":          f"/v2/Bus/Schedule/City/{city}",
    }

    for filename, endpoint in endpoints.items():
        print(f"\n[Fetch] {endpoint}")
        try:
            data = fetch_all(token, endpoint)
            out_path = OUTPUT_DIR / filename
            out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  [OK] 存至 {out_path}（共 {len(data)} 筆）")
        except requests.HTTPError as e:
            print(f"  [FAIL] 失敗：{e}")
            # S2STravelTime 可能部分縣市無資料，允許跳過
            if "S2STravelTime" in endpoint:
                print(f"  → 跳過 S2STravelTime，build_graph.py 將改用距離估算")
                (OUTPUT_DIR / filename).write_text("[]", encoding="utf-8")
            else:
                raise


# ── 國道客運（城際）TDX 模式 ─────────────────────────────────────────────────
def fetch_intercity_data() -> None:
    """使用 TDX API 取得全台國道客運（城際公車）資料"""
    token = get_access_token()

    # 國道客運 endpoint 不需要城市參數
    endpoints = {
        "intercity_routes.json":         "/v2/Bus/Route/InterCity",
        "intercity_stops.json":          "/v2/Bus/Stop/InterCity",
        "intercity_stop_of_route.json":  "/v2/Bus/StopOfRoute/InterCity",
        "intercity_schedule.json":       "/v2/Bus/Schedule/InterCity",
    }

    for filename, endpoint in endpoints.items():
        print(f"\n[Fetch] {endpoint}")
        try:
            data = fetch_all(token, endpoint)
            out_path = OUTPUT_DIR / filename
            out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  [OK] 存至 {out_path}（共 {len(data)} 筆）")
        except requests.HTTPError as e:
            print(f"  [FAIL] 失敗：{e}")
            (OUTPUT_DIR / filename).write_text("[]", encoding="utf-8")
            print(f"  → 跳過，存空檔案")


# ── 主程式 ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="TDX 公車資料擷取腳本")
    parser.add_argument("--city",      default="Taoyuan", help="縣市名稱（英文，例如 Taoyuan）")
    parser.add_argument("--mock",      action="store_true", help="使用假資料（無需 TDX API Key）")
    parser.add_argument("--intercity", action="store_true", help="擷取國道客運（城際公車）資料")
    args = parser.parse_args()

    if args.intercity:
        print("=== TDX 資料擷取 | 國道客運（城際）===\n")
        fetch_intercity_data()
        print("\n[OK] 完成！請接著執行：python generate_shapes.py --intercity")
    elif args.mock:
        print(f"=== TDX 資料擷取 | 城市：{args.city} | 模式：Mock ===\n")
        generate_mock_data(args.city)
        print("\n[OK] 完成！請接著執行：python build_graph.py")
    else:
        print(f"=== TDX 資料擷取 | 城市：{args.city} ===\n")
        fetch_real_data(args.city)
        print("\n[OK] 完成！請接著執行：python build_graph.py")


if __name__ == "__main__":
    main()
