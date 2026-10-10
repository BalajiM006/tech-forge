@echo off
title Mend Storage Node - PC 3
echo ============================================================
echo   MEND STORAGE NODE (PC 3 WORKER)
echo ============================================================
echo Listening on 0.0.0.0:5001 across your Local Area Network.
echo Storing chunks into ./data/pc-3/
echo Press Ctrl+C to terminate.
echo ============================================================
node storage-node.js --id pc-3 --port 5001 --host 0.0.0.0 --zone zone-c
pause
