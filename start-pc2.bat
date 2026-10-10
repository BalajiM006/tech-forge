@echo off
title Mend Storage Node - PC 2
echo ============================================================
echo   MEND STORAGE NODE (PC 2 WORKER)
echo ============================================================
echo Listening on 0.0.0.0:5001 across your Local Area Network.
echo Storing chunks into ./data/pc-2/
echo Press Ctrl+C to terminate.
echo ============================================================
node storage-node.js --id pc-2 --port 5001 --host 0.0.0.0 --zone zone-b
pause
