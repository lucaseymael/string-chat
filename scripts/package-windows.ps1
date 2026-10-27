$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $repoRoot 'dist'
$buildRoot = Join-Path $repoRoot '.build'
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versão inválida.' }
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$archive = Join-Path $buildRoot ('StringChat-Package-' + $version + '.zip')
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $distRoot 'StringChat-Desktop'), $archive, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$installer = Join-Path $distRoot ('StringChat-Setup-' + $version + '.exe')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /main:Setup /platform:x64 /optimize+ /codepage:65001 /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ('/win32icon:' + (Join-Path $repoRoot 'icon.ico')) ('/resource:' + $archive + ',StringChat.Package.zip') ('/out:' + $installer) (Join-Path $repoRoot 'native\Installer.cs') (Join-Path $repoRoot 'native\InstallSupport.cs')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar setup.' }
$portable = Join-Path $distRoot 'StringChat-Desktop.zip'
Copy-Item -LiteralPath $archive -Destination $portable -Force
$checksumLines = foreach ($asset in @($installer, $portable)) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($asset)
    try { $digest = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    $digest + '  ' + [System.IO.Path]::GetFileName($asset)
}
[System.IO.File]::WriteAllLines((Join-Path $distRoot 'StringChat-SHA256.txt'), $checksumLines, (New-Object System.Text.UTF8Encoding($false)))
