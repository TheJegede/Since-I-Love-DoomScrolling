$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath = Join-Path $ScriptDir "run_worker_silent.vbs"

if (-not (Test-Path $VbsPath)) {
    Write-Error "VBScript launcher not found at $VbsPath. Please create it first."
    exit 1
}

# Register the task using schtasks to avoid administrative privilege requirements
# /sc hourly /mo 1 repeats the task every hour indefinitely
$Cmd = "schtasks /create /tn InstagramTranscriberQueueDrainer /tr `'wscript.exe `"$VbsPath`"`' /sc hourly /mo 1 /f"
Invoke-Expression $Cmd

Write-Host "Successfully registered scheduled task 'InstagramTranscriberQueueDrainer' using schtasks."
