@echo off
echo 🚀 Starting JustSearch Deployment...

:: Check if settings.json exists
if not exist "backend\settings.json" (
    echo 📝 Creating default settings.json...
    copy backend\settings.json.example backend\settings.json
)

:: Check for Docker
docker --version >nul 2>&1
if %errorlevel% equ 0 (
    echo 🐳 Docker found. Building and starting containers...
    docker-compose up -d --build
    if %errorlevel% equ 0 (
        echo.
        echo ✅ Deployment successful!
        echo 🌍 Access JustSearch at: http://localhost:8001
        pause
        exit /b 0
    ) else (
        echo ❌ Docker deployment failed.
        pause
        exit /b 1
    )
)

echo ⚠️ Docker not found. Falling back to local python environment...

:: Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python not found. Please install Docker or Python.
    pause
    exit /b 1
)

echo 🐍 Setting up local environment...
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

echo Activating virtual environment...
call venv\Scripts\activate

echo 📦 Installing dependencies...
pip install -r backend/requirements.txt

:: Run the application using run.bat
if exist "run.bat" (
    call run.bat
) else (
    echo 🚀 Starting server...
    python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
)

pause
