#!/usr/bin/env bash
# fetch_all_cities.sh — 批次擷取所有縣市資料
#
# 用法：
#   bash scripts/fetch_all_cities.sh              # 全部城市
#   bash scripts/fetch_all_cities.sh Taipei Tainan # 指定城市
#
# 每個城市依序執行：
#   1. fetch_tdx.py   — 從 TDX API 拉原始資料
#   2. build_graph.py — 建立 graph JSON
#   3. generate_shapes.py — 建立路線幾何 + 班距
#
# 注意：TDX API 有每日流量限制（免費版），建議分批執行
# 注意：桃園（Taoyuan）已有資料，可跳過

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 全台 22 縣市（TDX 名稱）
# 注意：新竹市=Hsinchu（非 HsinchuCity），嘉義市=Chiayi（非 ChiayiCity）
ALL_CITIES=(
  # 北部
  Taipei NewTaipei Keelung Taoyuan Hsinchu HsinchuCounty YilanCounty
  # 中部
  Taichung MiaoliCounty ChanghuaCounty NantouCounty YunlinCounty
  # 南部
  Tainan Kaohsiung Chiayi ChiayiCounty PingtungCounty
  # 東部
  HualienCounty TaitungCounty
  # 外島
  PenghuCounty KinmenCounty LienchiangCounty
)

# 解析參數：--intercity / --force，其餘視為城市名稱
FORCE=false
INTERCITY=false
CITIES=()
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=true ;;
    --intercity|-i) INTERCITY=true ;;
    *) CITIES+=("$arg") ;;
  esac
done

SKIP_CITIES=false
if [ ${#CITIES[@]} -eq 0 ]; then
  if [ "$INTERCITY" = true ]; then
    SKIP_CITIES=true
  else
    CITIES=("${ALL_CITIES[@]}")
  fi
fi

if [ "$SKIP_CITIES" = false ]; then
echo "=== 將處理 ${#CITIES[@]} 個城市 ==="
echo ""

for CITY in "${CITIES[@]}"; do
  echo "━━━ $CITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  CITY_KEY=$(echo "$CITY" | tr '[:upper:]' '[:lower:]')
  GRAPH_FILE="$SCRIPT_DIR/../public/data/${CITY_KEY}.json"

  if [ -f "$GRAPH_FILE" ] && [ "$FORCE" = false ]; then
    echo "  ✓ 已有資料，直接重建 shapes..."
    python "$SCRIPT_DIR/generate_shapes.py" --city "$CITY" && echo "✓ $CITY 完成 (shapes 重建)" || echo "✗ $CITY shapes 失敗"
    echo ""
    sleep 2
    continue
  fi

  python "$SCRIPT_DIR/fetch_tdx.py" --city "$CITY" || { echo "✗ $CITY fetch 失敗，跳過"; echo ""; sleep 5; continue; }
  python "$SCRIPT_DIR/build_graph.py" --city "$CITY" || { echo "✗ $CITY build 失敗，跳過"; echo ""; sleep 2; continue; }
  python "$SCRIPT_DIR/generate_shapes.py" --city "$CITY" || echo "✗ $CITY shapes 失敗"

  echo "✓ $CITY 完成"
  echo ""
  sleep 5
done

echo "=== 縣市資料全部完成！==="
fi # end SKIP_CITIES

# 國道客運
if [ "$INTERCITY" = true ]; then
  echo ""
  echo "━━━ 國道客運（城際公車）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  INTERCITY_FILE="$SCRIPT_DIR/../public/data/intercity_shapes.json"
  if [ -f "$INTERCITY_FILE" ] && [ "$FORCE" = false ]; then
    echo "  ✓ 已有國道客運資料，略過（加 --force 可強制重建）"
  else
    echo "[1/2] 擷取國道客運原始資料..."
    echo "（注意：建議在縣市資料抓完稍候後再抓，避免 rate limit）"
    sleep 30  # 讓 rate limit 有時間恢復
    python "$SCRIPT_DIR/fetch_tdx.py" --intercity && \
    echo "[2/2] 生成國道客運路線幾何..." && \
    python "$SCRIPT_DIR/generate_shapes.py" --intercity && \
    echo "✓ 國道客運完成" || echo "✗ 國道客運失敗"
  fi
fi

echo ""
echo "=== 全部完成！==="
echo "輸出位置：public/data/{city}.json + {city}_shapes.json"
if [ "$INTERCITY" = true ]; then echo "國道客運：public/data/intercity_shapes.json"; fi
