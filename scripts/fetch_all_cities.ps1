# fetch_all_cities.ps1 — 批次擷取所有縣市資料（Windows PowerShell）
#
# 用法（在專案根目錄執行）：
#   .\scripts\fetch_all_cities.ps1              # 全部城市
#   .\scripts\fetch_all_cities.ps1 Taipei Tainan # 指定城市
#
# 注意：TDX API 有每日流量限制，建議分批執行
# 注意：桃園（Taoyuan）已有資料，可從 $Cities 移除

param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$InputParams
)

# 解析參數
$Force = $false
$Intercity = $false
$Cities = @()
foreach ($p in $InputParams) {
    if ($p -eq "--force" -or $p -eq "-f") {
        $Force = $true
    } elseif ($p -eq "--intercity" -or $p -eq "-i") {
        $Intercity = $true
    } else {
        $Cities += $p
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$AllCities = @(
    # 北部
    "Taipei", "NewTaipei", "Keelung", "Taoyuan",
    "Hsinchu", "HsinchuCounty", "YilanCounty",
    # 中部
    "Taichung", "MiaoliCounty", "ChanghuaCounty", "NantouCounty", "YunlinCounty",
    # 南部
    "Tainan", "Kaohsiung", "Chiayi", "ChiayiCounty", "PingtungCounty",
    # 東部
    "HualienCounty", "TaitungCounty",
    # 外島
    "PenghuCounty", "KinmenCounty", "LienchiangCounty"
)

$SkipCities = ($Cities.Count -eq 0 -and $Intercity)
if ($Cities.Count -eq 0 -and -not $Intercity) {
    $Cities = $AllCities
}

if (-not $SkipCities) {
$modeStr = if ($Force) { "強制重建（--force）" } else { "增量更新（若已有資料則跳過）" }
Write-Host "=== 將處理 $($Cities.Count) 個城市 | 模式：$modeStr ===" -ForegroundColor Cyan
Write-Host ""

foreach ($City in $Cities) {
    Write-Host "━━━ $City ━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow

    $CityKey = $City.ToLower()
    $GraphFile = Join-Path $ScriptDir "..\public\data\$CityKey.json"

    # 若已有資料且未傳 --force，跳過 fetch + build（避免覆蓋舊資料）
    $hasData = Test-Path $GraphFile
    if ($hasData -and -not $Force) {
        Write-Host "  ✓ 已有資料，跳過 fetch/build，直接重建 shapes..." -ForegroundColor DarkGray
        Write-Host "[3/3] 重建路線幾何..."
        python "$ScriptDir\generate_shapes.py" --city $City
        Write-Host "✓ $City 完成 (shapes 重建)" -ForegroundColor Green
        Write-Host ""
        Start-Sleep -Seconds 2
        continue
    }

    if ($hasData -and $Force) {
        Write-Host "  ⚠ --force 模式：將覆蓋舊資料" -ForegroundColor Yellow
    }

    Write-Host "[1/3] 擷取 TDX 原始資料..."
    python "$ScriptDir\fetch_tdx.py" --city $City
    if ($LASTEXITCODE -ne 0) { Write-Error "$City fetch 失敗"; continue }

    Write-Host "[2/3] 建立路網圖..."
    python "$ScriptDir\build_graph.py" --city $City
    if ($LASTEXITCODE -ne 0) { Write-Error "$City build_graph 失敗"; continue }

    Write-Host "[3/3] 建立路線幾何..."
    python "$ScriptDir\generate_shapes.py" --city $City
    if ($LASTEXITCODE -ne 0) { Write-Error "$City generate_shapes 失敗"; continue }

    Write-Host "✓ $City 完成" -ForegroundColor Green
    Write-Host ""

    # 暫停 5 秒避免 TDX rate limit
    Start-Sleep -Seconds 5
}

Write-Host "=== 縣市資料全部完成！===" -ForegroundColor Cyan
} # end if (-not $SkipCities)

# 國道客運（城際公車）
if ($Intercity) {
    Write-Host ""
    Write-Host "━━━ 國道客運（城際公車）━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
    $IntercityFile = Join-Path $ScriptDir "..\public\data\intercity_shapes.json"
    $hasIntercity = Test-Path $IntercityFile
    if ($hasIntercity -and -not $Force) {
        Write-Host "  ✓ 已有國道客運資料，略過（加 --force 可強制重建）" -ForegroundColor DarkGray
    } else {
        Write-Host "[1/2] 擷取國道客運原始資料..."
        Write-Host "  (等待 30 秒讓 TDX rate limit 恢復...)" -ForegroundColor DarkGray
        Start-Sleep -Seconds 30
        python "$ScriptDir\fetch_tdx.py" --intercity
        if ($LASTEXITCODE -ne 0) { Write-Error "國道客運 fetch 失敗" }
        else {
            Write-Host "[2/2] 生成國道客運路線幾何..."
            python "$ScriptDir\generate_shapes.py" --intercity
            if ($LASTEXITCODE -ne 0) { Write-Error "國道客運 generate_shapes 失敗" }
            else { Write-Host "✓ 國道客運完成" -ForegroundColor Green }
        }
    }
}

Write-Host ""
Write-Host "=== 全部完成！===" -ForegroundColor Cyan
Write-Host "輸出位置：public/data/{city}.json + {city}_shapes.json"
if ($Intercity) { Write-Host "國道客運：public/data/intercity_shapes.json" }
