@echo off
rem Entry point for the Windows Task Scheduler. See docs/SETUP-SERVER.md.
cd /d "%~dp0.."
if not exist logs mkdir logs
npx tsx scripts\run-server.ts >> logs\server.log 2>&1
