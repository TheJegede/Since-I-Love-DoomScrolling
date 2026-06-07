# Silent Local Background Worker on Windows — Implementation Plan

This plan describes how to configure the queue worker (`run_worker.py`) to run silently in the background on Windows whenever you log into your laptop. This allows reels shared from your iPhone shortcut to be processed automatically in the background without needing a terminal window open on your screen.

---

## Architecture & How It Works

Windows Task Scheduler can run scripts at logon, but launching a Python script directly opens a black command prompt window that stays open on your desktop.

To run the worker completely invisibly:
1. We create a tiny Visual Basic Script (`.vbs`) launcher.
2. The VBScript calls the virtual environment Python interpreter to run `run_worker.py` with the window style parameter set to `0` (hidden).
3. We configure Windows Task Scheduler to run this VBScript launcher automatically at user logon.

---

## Proposed Changes

### 1. Create the VBScript Launcher
We will create a script named `backend/run_worker_silent.vbs` in the project:

```vbs
Set WshShell = CreateObject("WScript.Shell")
' Get the directory of this script to resolve paths dynamically
strScriptPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(Wscript.ScriptPosition)
' Construct command targeting virtual environment python and worker script
cmd = """" & strScriptPath & "\.venv\Scripts\python.exe"" """ & strScriptPath & "\run_worker.py"""
' Run the command hidden (0) and asynchronously (false)
WshShell.Run cmd, 0, false
```

### 2. Add Helper Scripts to Stop the Worker
Since the worker runs invisibly, we need an easy way to stop it when needed (e.g., if you are updating code or rotating keys). We will create `backend/stop_worker.bat`:

```cmd
@echo off
echo Stopping background reels queue worker processes...
taskkill /f /im python.exe /fi "WINDOWTITLE eq run_worker.py" 2>nul
taskkill /f /im python.exe /fi "COMMANDLINE eq *run_worker.py*" 2>nul
wmic process where "commandline like '%%run_worker.py%%'" delete 2>nul
echo Done.
```

---

## Setup Steps (To Be Executed Later)

### Task 1: Create local launcher files
1. Create `backend/run_worker_silent.vbs` containing the VBScript launcher.
2. Create `backend/stop_worker.bat` to allow stopping the background process.

### Task 2: Configure Windows Task Scheduler
We can automate the task registration via PowerShell. Run a terminal command as administrator:

```powershell
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"C:\Users\jeged\Downloads\Transcriber\backend\run_worker_silent.vbs`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "InstagramTranscriberWorker" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Runs the Instagram Transcriber queue worker silently in the background at logon." -Force
```

*(Note: We will adjust the path dynamically to match the user's workspace path `C:\Users\jeged\Downloads\Transcriber\backend\run_worker_silent.vbs`).*

---

## Verification Plan
1. Run `stop_worker.bat` to clear any existing processes.
2. Double-click `run_worker_silent.vbs`.
3. Open Windows **Task Manager** → Details tab. Confirm `python.exe` is running, but no console/command window is visible.
4. Enqueue a pending reel via the iPhone share sheet. Confirm the database row is picked up and processed (status updates to `done`).
5. Check `backend_server.log` or similar process outputs to verify successful processing.
