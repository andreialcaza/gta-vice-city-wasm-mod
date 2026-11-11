@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

echo.
echo ==============================================
echo  Open on this PC:  http://localhost:5173/gta-vice-city-wasm/
echo  Open on phone:    use the "Network:" address shown below
echo                    (add /gta-vice-city-wasm/ if it is missing)
echo ==============================================
echo.

start "" http://localhost:5173/gta-vice-city-wasm/
call npm run dev -- --host
pause