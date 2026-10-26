<#
.SYNOPSIS
    Builds the plugin, command set and Node server for one Revit version and
    installs the add-in into %AppData%\Autodesk\Revit\Addins\<version>.

.DESCRIPTION
    - Refuses to copy while Revit is running (DLLs would be locked).
    - Writes commandRegistry.json with every command from command.json enabled,
      so the Settings dialog does not have to be used after a fresh install.
    - Existing files in the add-in folder are overwritten; nothing else is removed.

.EXAMPLE
    ./scripts/deploy-local.ps1 -RevitVersion 2027 -RevitInstallDir "E:\automatic-architect\revit\Revit 2027" -DotnetRoot "E:\automatic-architect\tools\dotnet"
#>
param(
    [string]$RevitVersion = "2027",
    [string]$RevitInstallDir = "C:\Program Files\Autodesk\Revit $RevitVersion",
    [string]$DotnetRoot = "",
    [switch]$SkipServer
)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$short = $RevitVersion.Substring(2)
$config = "Release R$short"

if ($DotnetRoot) {
    $env:DOTNET_ROOT = $DotnetRoot
    $env:PATH = "$DotnetRoot;$env:PATH"
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"

Write-Host "== Building plugin ($config)"
dotnet build "$repo\plugin\RevitMCPPlugin.csproj" -c $config -p:RevitInstallDir="$RevitInstallDir" -nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Plugin build failed" }

Write-Host "== Building command set ($config)"
dotnet build "$repo\commandset\RevitMCPCommandSet.csproj" -c $config -nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Command set build failed" }

if (-not $SkipServer) {
    Write-Host "== Building Node server"
    Push-Location "$repo\server"
    try {
        if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund }
        npm run build --silent
        if ($LASTEXITCODE -ne 0) { throw "Server build failed" }
    } finally { Pop-Location }
}

if (Get-Process -Name Revit -ErrorAction SilentlyContinue) {
    throw "Revit is running. Close Revit before deploying the add-in."
}

$package = "$repo\plugin\bin\AddIn $RevitVersion $config"
$target = "$env:APPDATA\Autodesk\Revit\Addins\$RevitVersion"
Write-Host "== Copying $package -> $target"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item "$package\*" $target -Recurse -Force

# Enable every command from command.json
$commandSet = Get-Content "$repo\command.json" -Raw | ConvertFrom-Json
$registry = @{
    commands = @($commandSet.commands | ForEach-Object {
        @{
            commandName            = $_.commandName
            assemblyPath           = "RevitMCPCommandSet\{VERSION}\RevitMCPCommandSet.dll"
            enabled                = $true
            supportedRevitVersions = @($RevitVersion)
            developer              = $commandSet.developer
            description            = $_.description
        }
    })
}
$registryPath = "$target\revit_mcp_plugin\Commands\commandRegistry.json"
$registry | ConvertTo-Json -Depth 6 | Set-Content $registryPath -Encoding utf8
Write-Host "== Enabled $($registry.commands.Count) commands in $registryPath"
Write-Host "Done. Start Revit and choose 'Always Load' when asked about the add-in."
