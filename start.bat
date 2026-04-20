@echo off
cd /d %~dp0
echo Starting Transit-Isochrone dev server...
echo Open browser at: http://localhost:3000
echo Press Ctrl+C to stop.
echo.
npm run dev
pause
