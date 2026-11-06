$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# pythonw.exe runs the worker without opening a console window
$Python = Join-Path $ScriptDir ".venv\Scripts\pythonw.exe"
$Worker = Join-Path $ScriptDir "run_worker.py"

if (-not (Test-Path $Python)) {
    Write-Error "Python venv not found at $Python. Run backend/run_local.ps1 once to create it."
    exit 1
}

# schtasks needs no admin rights; /sc minute /mo 5 repeats every 5 minutes indefinitely
schtasks /create /tn InstagramTranscriberQueueDrainer /tr "`"$Python`" `"$Worker`" --drain" /sc minute /mo 5 /f

Write-Host "Registered scheduled task 'InstagramTranscriberQueueDrainer'."
