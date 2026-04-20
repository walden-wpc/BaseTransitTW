@echo off
chcp 65001 >nul
cd /d %~dp0
echo ================================
echo  桃園公車路網資料更新工具
echo ================================
echo.

:: 檢查 Python 是否存在
python --version >nul 2>&1
if errorlevel 1 (
    echo [錯誤] 找不到 Python，請先安裝 Python 3.8+
    pause
    exit /b 1
)

:: 檢查 .env 是否設定
findstr /i "your_client_id_here" scripts\.env >nul 2>&1
if not errorlevel 1 (
    echo [錯誤] 請先在 scripts\.env 填入真實的 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET
    pause
    exit /b 1
)

:: 安裝依賴
echo [1/4] 確認 Python 套件...
pip install -r scripts\requirements.txt -q
if errorlevel 1 (
    echo [錯誤] 套件安裝失敗
    pause
    exit /b 1
)
echo       OK
echo.

:: Step 1: 抓取原始資料
echo [2/4] 從 TDX 抓取桃園公車資料...
python scripts\fetch_tdx.py --city Taoyuan
if errorlevel 1 (
    echo [錯誤] fetch_tdx.py 執行失敗
    pause
    exit /b 1
)
echo.

:: Step 2: 建構路網圖
echo [3/4] 建構路網圖 (graph.json)...
python scripts\build_graph.py --city Taoyuan
if errorlevel 1 (
    echo [錯誤] build_graph.py 執行失敗
    pause
    exit /b 1
)
echo.

:: Step 3: 生成路線幾何
echo [4/4] 生成路線幾何 (shapes.json)...
python scripts\generate_shapes.py --city Taoyuan
if errorlevel 1 (
    echo [錯誤] generate_shapes.py 執行失敗
    pause
    exit /b 1
)
echo.

echo ================================
echo  完成！資料已更新至 public/data/
echo  請執行 start.bat 啟動前端
echo ================================
pause
