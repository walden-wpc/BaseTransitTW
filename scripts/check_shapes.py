#!/usr/bin/env python3
"""
check_shapes.py — 診斷各縣市路線幾何品質

判斷 *_shapes.json 是否為真實 TDX 幾何（多點折線）或 fallback（兩點直線段）。
若某縣市絕大多數路線段只有 2 個座標點，即為 fallback 資料，需重新抓取。

使用方式：
  python scripts/check_shapes.py                # 檢查全部縣市
  python scripts/check_shapes.py Taoyuan Taipei # 只檢查指定縣市（TDX 名稱）
  python scripts/check_shapes.py --fix-list     # 輸出需重跑的縣市清單

輸出範例（用 Sublime 開啟 shapes_report.txt 可快速檢視）：
  REAL     台北市  (taipei)         routes=1423  real=1420  fallback=3    size=4821.3 KB
  FALLBACK 桃園市  (taoyuan)        routes=312   real=0     fallback=312  size=142.0 KB
  MIXED    台中市  (taichung)       routes=850   real=600   fallback=250  size=2100.5 KB
  MISSING  宜蘭縣  (yilancounty)    — 檔案不存在
"""

import json
import sys
import argparse
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "public" / "data"

CITIES = [
    ("taipei",           "台北市"),
    ("newtaipei",        "新北市"),
    ("keelung",          "基隆市"),
    ("taoyuan",          "桃園市"),
    ("hsinchu",          "新竹市"),
    ("hsinchucounty",    "新竹縣"),
    ("yilancounty",      "宜蘭縣"),
    ("taichung",         "台中市"),
    ("miaolicounty",     "苗栗縣"),
    ("changhuacounty",   "彰化縣"),
    ("nantoucounty",     "南投縣"),
    ("yunlincounty",     "雲林縣"),
    ("tainan",           "台南市"),
    ("kaohsiung",        "高雄市"),
    ("chiayi",           "嘉義市"),
    ("chiayicounty",     "嘉義縣"),
    ("pingtungcounty",   "屏東縣"),
    ("hualiencounty",    "花蓮縣"),
    ("taitungcounty",    "台東縣"),
    ("penghucounty",     "澎湖縣"),
    ("kinmencounty",     "金門縣"),
    ("lienchiangcounty", "連江縣"),
]

# TDX Name → key 對照
TDX_TO_KEY = {
    "Taipei": "taipei", "NewTaipei": "newtaipei", "Keelung": "keelung",
    "Taoyuan": "taoyuan", "Hsinchu": "hsinchu", "HsinchuCounty": "hsinchucounty",
    "YilanCounty": "yilancounty", "Taichung": "taichung", "MiaoliCounty": "miaolicounty",
    "ChanghuaCounty": "changhuacounty", "NantouCounty": "nantoucounty",
    "YunlinCounty": "yunlincounty", "Tainan": "tainan", "Kaohsiung": "kaohsiung",
    "Chiayi": "chiayi", "ChiayiCounty": "chiayicounty", "PingtungCounty": "pingtungcounty",
    "HualienCounty": "hualiencounty", "TaitungCounty": "taitungcounty",
    "PenghuCounty": "penghucounty", "KinmenCounty": "kinmencounty",
    "LienchiangCounty": "lienchiangcounty",
}


def check_city(key: str) -> dict:
    """
    回傳 {
        exists: bool,
        quality: "real" | "fallback" | "mixed" | "missing",
        route_count: int,
        real_routes: int,
        fallback_routes: int,
        sample_fallback: list[str],
        size_kb: float,
    }
    """
    path = OUTPUT_DIR / f"{key}_shapes.json"
    if not path.exists():
        return {"exists": False, "quality": "missing", "route_count": 0,
                "real_routes": 0, "fallback_routes": 0, "sample_fallback": [], "size_kb": 0}

    with open(path, encoding="utf-8") as f:
        shapes = json.load(f)

    real = 0
    fallback = 0
    sample_fallback: list[str] = []

    for name, feat in shapes.items():
        coords_list = feat.get("geometry", {}).get("coordinates", [])
        # MultiLineString: list of segments; each segment = list of [lon, lat]
        has_real_segment = any(len(seg) > 2 for seg in coords_list)
        if has_real_segment:
            real += 1
        else:
            fallback += 1
            if len(sample_fallback) < 5:
                sample_fallback.append(name)

    total = real + fallback
    if total == 0:
        quality = "missing"
    elif fallback == 0:
        quality = "real"
    elif real == 0:
        quality = "fallback"
    elif fallback / total >= 0.4:
        quality = "mixed"
    else:
        quality = "real"   # 少量 fallback 可接受

    return {
        "exists": True,
        "quality": quality,
        "route_count": total,
        "real_routes": real,
        "fallback_routes": fallback,
        "sample_fallback": sample_fallback,
        "size_kb": round(path.stat().st_size / 1024, 1),
    }


def quality_icon(q: str) -> str:
    return {"real": "OK REAL    ", "fallback": "!! FALLBACK", "mixed": "~~ MIXED   ", "missing": "   MISSING "}[q]


def main():
    parser = argparse.ArgumentParser(description="診斷各縣市路線幾何品質")
    parser.add_argument("cities", nargs="*", help="指定縣市（TDX 名稱，不指定則全部檢查）")
    parser.add_argument("--fix-list", action="store_true", help="只輸出需要重抓的縣市（TDX 名稱）")
    parser.add_argument("--report",   default="shapes_report.txt", help="輸出報告檔路徑")
    args = parser.parse_args()

    # 決定要檢查的縣市
    if args.cities:
        check_cities = []
        for tdx_name in args.cities:
            key = TDX_TO_KEY.get(tdx_name) or tdx_name.lower()
            display = next((d for k, d in CITIES if k == key), tdx_name)
            check_cities.append((key, display))
    else:
        check_cities = list(CITIES)

    results: list[tuple[str, str, dict]] = []
    for key, display in check_cities:
        info = check_city(key)
        results.append((key, display, info))

    # 需要重跑的縣市
    need_fix = [
        key for key, _, info in results
        if info["quality"] in ("fallback", "mixed", "missing")
    ]

    if args.fix_list:
        # 只輸出 TDX 名稱（供批次腳本使用）
        key_to_tdx = {v: k for k, v in TDX_TO_KEY.items()}
        for key in need_fix:
            print(key_to_tdx.get(key, key))
        return

    # 詳細報告
    lines = []
    lines.append("=" * 80)
    lines.append("  臺灣轉公車 — 路線幾何品質報告")
    lines.append("=" * 80)
    lines.append("")
    lines.append(f"{'狀態':<14}{'縣市':<8}{'key':<20}{'路線數':>7}  {'真實':>6}  {'fallback':>8}  {'大小':>9}")
    lines.append("-" * 80)

    for key, display, info in results:
        icon = quality_icon(info["quality"])
        if info["quality"] == "missing":
            lines.append(f"{icon}  {display:<6}  {key:<20}  — 檔案不存在")
        else:
            lines.append(
                f"{icon}  {display:<6}  {key:<20}"
                f"  {info['route_count']:>6}   {info['real_routes']:>6}   {info['fallback_routes']:>8}"
                f"   {info['size_kb']:>7.1f} KB"
            )
            if info["sample_fallback"]:
                lines.append(f"               樣本 fallback 路線：{', '.join(info['sample_fallback'])}")

    lines.append("")
    lines.append("=" * 80)
    if need_fix:
        key_to_tdx = {v: k for k, v in TDX_TO_KEY.items()}
        fix_tdx = [key_to_tdx.get(k, k) for k in need_fix]
        lines.append(f"需要重新抓取的縣市（{len(need_fix)} 個）：")
        lines.append("  " + "  ".join(fix_tdx))
        lines.append("")
        lines.append("重新抓取指令（PowerShell）：")
        lines.append(f"  .\\scripts\\fetch_all_cities.ps1 --force {' '.join(fix_tdx)}")
        lines.append("")
        lines.append("或只重建 shapes（若 graph.json 仍正確）：")
        for tdx in fix_tdx:
            lines.append(f"  python scripts/generate_shapes.py --city {tdx}")
    else:
        lines.append("所有縣市路線幾何均為真實 TDX 資料，無需重新抓取。")

    lines.append("=" * 80)

    report_text = "\n".join(lines)
    import sys
    sys.stdout.buffer.write((report_text + "\n").encode("utf-8", errors="replace"))

    report_path = Path(args.report)
    report_path.write_text(report_text, encoding="utf-8")
    sys.stdout.buffer.write(f"\nReport saved: {report_path.resolve()}\n".encode("ascii", errors="replace"))


if __name__ == "__main__":
    main()
