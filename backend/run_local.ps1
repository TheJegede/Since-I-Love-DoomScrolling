# PowerShell script to run FastAPI backend locally

$ErrorActionPreference = "Stop"

# 1. Check Python installation
try {
    & python --version | Out-Null
} catch {
    Write-Host "Error: Python is not installed or not in system PATH." -ForegroundColor Red
    Exit 1
}

# 2. Check and create virtual environment
$VenvDir = Join-Path $PSScriptRoot ".venv"
if (-not (Test-Path $VenvDir)) {
    Write-Host "Creating virtual environment at $VenvDir..." -ForegroundColor Cyan
    & python -m venv $VenvDir
}

# 3. Activate virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Cyan
$ActivateScript = Join-Path $VenvDir "Scripts\Activate.ps1"
& $ActivateScript

# 4. Install dependencies
Write-Host "Installing dependencies from requirements.txt..." -ForegroundColor Cyan
& pip install --upgrade pip
& pip install -r (Join-Path $PSScriptRoot "requirements.txt")

# 5. Check environment file
$RootEnvFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
$BackendEnvFile = Join-Path $PSScriptRoot ".env"

if (Test-Path $RootEnvFile) {
    Write-Host "Root .env configuration detected." -ForegroundColor Green
} elseif (Test-Path $BackendEnvFile) {
    Write-Host "Backend .env configuration detected." -ForegroundColor Green
} else {
    Write-Host "Warning: .env file not found. Creating template at root: $RootEnvFile..." -ForegroundColor Yellow
    $TemplateContent = @"
GROQ_API_KEY=your_groq_api_key_here
"@
    Set-Content -Path $RootEnvFile -Value $TemplateContent
    Write-Host "Template .env created at project root. Please fill in your Groq API key in the root .env file before running." -ForegroundColor Yellow
}

# 6. Check for cookies file
$CookiesFile = Join-Path $PSScriptRoot "cookies.txt"
if (-not (Test-Path $CookiesFile)) {
    Write-Host "Tip: If you encounter 403 or rate-limiting errors when scraping Instagram Reels," -ForegroundColor Gray
    Write-Host "export your browser cookies as cookies.txt and place it in the backend folder." -ForegroundColor Gray
}

# 7. Start FastAPI server
Write-Host "Starting FastAPI server on http://localhost:8000..." -ForegroundColor Green
& uvicorn main:app --host 0.0.0.0 --port 8000 --reload
