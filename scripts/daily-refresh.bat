@echo off
REM ============================================================
REM CSSkinMonitor daily refresh chain (Windows Task Scheduler 9:00)
REM 1) hot-tier crawl (writes daily snapshot cache/price-history.json)
REM 2) trade-up radar scan (cache/alch-scan.json)
REM 3) offline rebuild app/data.js (engine + snapshot + radar)
REM 4) sync desktop data.js (exe external data, reload on restart)
REM log: cache\daily-refresh.log (append)
REM NOTE: keep this file ASCII-only (cmd parses bat in local codepage)
REM ============================================================
setlocal
set "PROJ=C:\Users\chenzhao\WorkBuddy\2026-08-29-11-04-52\cs-skin-monitor"
set "DESK=C:\Users\chenzhao\Desktop"
set "LOG=%PROJ%\cache\daily-refresh.log"

cd /d "%PROJ%"
echo [%date% %time%] ====== daily refresh start ====== >> "%LOG%"

echo [%date% %time%] hot-tier crawl... >> "%LOG%"
node crawler.js >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] crawl failed (network/rate-limit?), skipping today snapshot >> "%LOG%"
)

echo [%date% %time%] trade-up radar scan... >> "%LOG%"
node scan-tradeup.js >> "%LOG%" 2>&1

echo [%date% %time%] rebuild data.js... >> "%LOG%"
node crawler.js --regen >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] regen failed >> "%LOG%"
  exit /b 1
)

echo [%date% %time%] sync desktop data.js... >> "%LOG%"
copy /y "%PROJ%\app\data.js" "%DESK%\data.js" >> "%LOG%" 2>&1

echo [%date% %time%] ====== daily refresh done ====== >> "%LOG%"
endlocal
