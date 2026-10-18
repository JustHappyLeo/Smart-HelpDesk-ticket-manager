$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$credentialFile = Join-Path $root 'Password'
$logDirectory = Join-Path $root '.helpdesk-logs'
$mysqlServiceName = 'MySQL80'
$port = 3000
$serverProcess = $null

try {
  if (-not (Test-Path -LiteralPath $credentialFile -PathType Leaf)) {
    throw "The ignored Password file was not found at $credentialFile."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\mysql2') -PathType Container)) {
    throw 'Project dependencies are missing. Open a terminal in this folder and run npm install.'
  }
  $nodeVersion = & node --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') {
    throw 'Node.js 20 or newer is required.'
  }
  if ([int]$Matches[1] -lt 20) {
    throw "Node.js 20 or newer is required; found $nodeVersion."
  }

  $databaseSettings = @{}
  foreach ($line in Get-Content -LiteralPath $credentialFile) {
    if ($line -match '^\s*\$env:(DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)\s*=\s*"([^"]*)"\s*$') {
      $databaseSettings[$Matches[1]] = $Matches[2]
    }
  }
  foreach ($name in @('DB_NAME', 'DB_USER', 'DB_PASSWORD')) {
    if (-not $databaseSettings.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($databaseSettings[$name])) {
      throw "Add a quoted `$env:$name = `"value`" setting to the Password file."
    }
  }
  $env:DB_HOST = if ($databaseSettings.ContainsKey('DB_HOST') -and $databaseSettings.DB_HOST) { $databaseSettings.DB_HOST } else { '127.0.0.1' }
  $env:DB_PORT = if ($databaseSettings.ContainsKey('DB_PORT') -and $databaseSettings.DB_PORT) { $databaseSettings.DB_PORT } else { '3306' }
  $env:DB_NAME = $databaseSettings.DB_NAME
  $env:DB_USER = $databaseSettings.DB_USER
  $env:DB_PASSWORD = $databaseSettings.DB_PASSWORD
  $env:PORT = [string]$port

  $mysqlService = Get-Service -Name $mysqlServiceName -ErrorAction SilentlyContinue
  if (-not $mysqlService) {
    throw "MySQL Windows service '$mysqlServiceName' was not found. Update `$mysqlServiceName in Start-HelpDesk.ps1 to match your MySQL service."
  }
  if ($mysqlService.Status -ne 'Running') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Write-Host 'Windows administrator approval is needed to start MySQL.'
      Start-Process -FilePath 'powershell.exe' -Verb RunAs `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
      exit 0
    }
    Write-Host 'Starting MySQL...'
    Start-Service -Name $mysqlServiceName
    (Get-Service -Name $mysqlServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  } else {
    Write-Host 'MySQL is already running.'
  }

  $databaseCheck = "const mysql=require('mysql2/promise');(async()=>{const c=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});await c.query('SELECT 1');await c.end();console.log('Database connection verified.')})().catch(e=>{console.error('Database connection failed:',e.code||'connection error');process.exitCode=1})"
  & node -e $databaseCheck
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not connect to the configured database. Check the DB settings in Password.'
  }

  try {
    $existingResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing
    if ([int]$existingResponse.StatusCode -eq 200 -and $existingResponse.Content -match 'HelpDesk Portal') {
      Write-Host "HelpDesk is already running at http://localhost:$port."
      Start-Process "http://localhost:$port"
      exit 0
    }
    throw "Port $port is already serving another web app. Close it or change `$port in Start-HelpDesk.ps1."
  } catch {
    if ($_.Exception.Message -like 'Port * is already serving*') { throw }
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 200) {
      throw "Port $port is already in use by another web app."
    }
  }

  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $stdoutLog = Join-Path $logDirectory 'server.out.log'
  $stderrLog = Join-Path $logDirectory 'server.error.log'
  Write-Host 'Starting the HelpDesk web server...'
  $serverProcess = Start-Process -FilePath 'node' -ArgumentList @('server.js') `
    -WorkingDirectory $root -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($serverProcess.HasExited) {
      throw "The web server exited during startup. Check $stderrLog for details."
    }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing
      if ([int]$response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) {
    Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue
    throw "The web server did not become ready. Check $stderrLog for details."
  }

  Write-Host "HelpDesk is ready at http://localhost:$port."
  Start-Process "http://localhost:$port"
} catch {
  Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
