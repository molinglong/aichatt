# android-publish.ps1 - verify/package the APK + update manifest, upload only with -Upload.
#
# Default is a release build signed with the out-of-repo key material
# (D:\aichatt-secrets\keystore.properties). -Debug keeps the old debug path.
# Release publishing is gated on: apksigner verify, expected certificate SHA-256,
# 16KB native-lib alignment, versionName/versionCode matching the build stamp.
#
# -Apk <path> publishes a pre-signed artifact (e.g. the one-off debug->release
# key-rotation APK) and skips the build. -SkipBuild reuses the last Gradle output.
#
# Upload requires nginx location /apk/ -> /opt/aichatt-apk/ on the VPS.
param(
    [switch]$Upload,
    [switch]$SkipBuild,
    [switch]$Debug,
    [string]$Apk = '',
    [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$repo      = Split-Path -Parent $PSScriptRoot
$mirror    = 'D:\aichatt-android'
$ssh       = 'C:\Windows\System32\OpenSSH\ssh.exe'
$scp       = 'C:\Windows\System32\OpenSSH\scp.exe'
$remoteDir = '/opt/aichatt-apk'
$apkBase   = 'https://chat.yuban.icu/apk'
$variant   = if ($Debug) { 'debug' } else { 'release' }
$buildTools = 'D:\AndroidSDK\build-tools\36.0.0'

function Invoke-NativeText([string]$exe, [string[]]$argv) {
    $out = Join-Path $env:TEMP ("aichatt-out-{0}.log" -f [guid]::NewGuid().ToString('N'))
    $err = Join-Path $env:TEMP ("aichatt-err-{0}.log" -f [guid]::NewGuid().ToString('N'))
    # .bat files need cmd.exe; Start-Process redirects both streams reliably,
    # while PowerShell 5.1's 2>&1 silently drops native stderr.
    $argLine = ($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', ('"{0}" {1}' -f $exe, $argLine)) `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $text = [System.IO.File]::ReadAllText($out) + [System.IO.File]::ReadAllText($err)
    Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Code = $p.ExitCode; Text = $text }
}

# 1. Build (stamps a new hourly version); skip when a prebuilt APK is supplied.
if (-not $SkipBuild -and -not $Apk) {
    & (Join-Path $PSScriptRoot 'android-build.ps1') -Debug:$Debug
    if ($LASTEXITCODE -ne 0) { throw "android-build failed with code $LASTEXITCODE" }
}

# 2. Locate the APK and the build-stamped version.
if ($Apk) {
    if (-not (Test-Path -LiteralPath $Apk)) { throw "APK not found: $Apk" }
    # NB: do NOT name this $apk. Variable names are case-insensitive, so it would be the
    # same [string]-constrained parameter variable, and assigning a FileInfo to it would
    # silently coerce to a path string (making .FullName empty downstream).
    $apkFile = Get-Item -LiteralPath $Apk
} else {
    $apkFile = Get-ChildItem -Path (Join-Path $mirror 'src-tauri\gen\android\app') -Recurse -Filter "*-$variant.apk" |
        Where-Object { $_.Name -notlike '*-unsigned.apk' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $apkFile) { throw "no $variant APK in the mirror build outputs" }
}
$conf = Get-Content (Join-Path $mirror 'src-tauri\tauri.android.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $conf.version
if (-not $version) { throw 'mirror tauri.android.conf.json has no version stamp (build script not run?)' }

# 3. Signature / alignment / version gates. Never upload a mis-signed or stale APK.
$apksigner = Join-Path $buildTools 'apksigner.bat'
$sig = Invoke-NativeText $apksigner @('verify', '-v', '--print-certs', $apkFile.FullName)
if ($sig.Code -ne 0) { Write-Output $sig.Text; throw "APK signature verification failed (code $($sig.Code))" }
$digests = [regex]::Matches($sig.Text, 'certificate SHA-256 digest:\s*([0-9a-fA-F:]+)') |
    ForEach-Object { ($_.Groups[1].Value -replace '[^0-9A-Fa-f]', '').ToUpper() }
$v2ok = $sig.Text -match 'Verified using v2 scheme \(APK Signature Scheme v2\): true'
$v3ok = $sig.Text -match 'Verified using v3 scheme \(APK Signature Scheme v3\): true'
Write-Output ("signature: v2={0} v3={1} signers={2}" -f $v2ok, $v3ok, $digests.Count)

if ($variant -eq 'release') {
    if (-not $v2ok -or -not $v3ok) { throw 'release APK must carry both v2 and v3 signatures' }
    $secrets = if ($env:AICHATT_KEYSTORE_PROPERTIES) { $env:AICHATT_KEYSTORE_PROPERTIES } else { 'D:\aichatt-secrets\keystore.properties' }
    if (-not (Test-Path $secrets)) { throw "signing properties not found: $secrets" }
    $expected = (Get-Content $secrets | Where-Object { $_ -match '^certSha256=' } | Select-Object -First 1)
    $expected = ($expected -replace '^certSha256=', '' -replace '[^0-9A-Fa-f]', '').ToUpper()
    if (-not $expected) { throw 'signing properties have no certSha256' }
    if ($digests -notcontains $expected) {
        throw "certificate mismatch: expected $expected, APK has $($digests -join ', ')"
    }
    Write-Output "release cert sha256: $expected"

    $aapt2 = Join-Path $buildTools 'aapt2.exe'
    $badging = Invoke-NativeText $aapt2 @('dump', 'badging', $apkFile.FullName)
    if ($badging.Code -ne 0) { Write-Output $badging.Text; throw 'aapt2 dump badging failed' }
    $pkgLine = ($badging.Text -split "`r?`n" | Where-Object { $_ -match '^package:' } | Select-Object -First 1)
    if ($pkgLine -notmatch "versionName='([^']+)'") { throw 'cannot read APK versionName' }
    $apkVersion = $Matches[1]
    if ($apkVersion -ne $version) { throw "version stamp mismatch: APK=$apkVersion, manifest=$version" }
    if ($pkgLine -notmatch "versionCode='(\d+)'") { throw 'cannot read APK versionCode' }
    $apkCode = [long]$Matches[1]
    $parts = $version.Split('.')
    $expectedCode = [long]$parts[0] * 1000000 + [long]$parts[1] * 1000 + [long]$parts[2]
    if ($apkCode -ne $expectedCode) { throw "versionCode mismatch: APK=$apkCode, expected=$expectedCode" }
    Write-Output "version: $apkVersion (versionCode $apkCode)"

    $zipalign = Join-Path $buildTools 'zipalign.exe'
    $align = Invoke-NativeText $zipalign @('-c', '-P', '16', '4', $apkFile.FullName)
    if ($align.Code -ne 0) { throw "16KB alignment check failed: $($align.Text)" }
    Write-Output 'alignment: 16KB native libs OK'
}

# 4. Package locally under dist\android\.
$dist = Join-Path $repo 'dist\android'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$apkName = "aichatt-$version.apk"
$apkOut = Join-Path $dist $apkName
Copy-Item $apkFile.FullName $apkOut -Force
$localSize = (Get-Item $apkOut).Length

# latest.json (UTF-8 no BOM; the Rust updater also tolerates a BOM, but do not add one).
$manifest = [ordered]@{
    version = $version
    url     = "$apkBase/$apkName"
    notes   = $Notes
    size    = $localSize
}
$manifestPath = Join-Path $dist 'latest.json'
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("packed: {0} ({1} MB)" -f $apkOut, [math]::Round($localSize / 1MB, 1))
Write-Output "manifest: $manifestPath"

# 5. Upload only with the explicit -Upload switch.
if ($Upload) {
    if (-not (Test-Path $ssh)) { throw "OpenSSH not found: $ssh" }
    & $ssh -o BatchMode=yes root@yuban.icu "mkdir -p $remoteDir"
    if ($LASTEXITCODE -ne 0) { throw 'ssh mkdir failed' }
    # APK first, manifest second: clients never see a manifest for a half-uploaded APK.
    & $scp -o BatchMode=yes $apkOut $manifestPath "root@yuban.icu:$remoteDir/"
    if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

    $remoteSize = ((& $ssh -o BatchMode=yes root@yuban.icu "stat -c %s $remoteDir/$apkName") -join '').Trim()
    if ($remoteSize -ne [string]$localSize) { throw "remote APK size mismatch: local=$localSize remote=$remoteSize" }
    $remoteManifestSize = ((& $ssh -o BatchMode=yes root@yuban.icu "stat -c %s $remoteDir/latest.json") -join '').Trim()
    if ($remoteManifestSize -ne [string](Get-Item $manifestPath).Length) { throw 'remote latest.json size mismatch' }
    Write-Output "uploaded: $apkName + latest.json -> root@yuban.icu:$remoteDir/"
    Write-Output "verified remote sizes: apk=$remoteSize manifest=$remoteManifestSize bytes"
    Write-Output "check: $apkBase/latest.json"
} else {
    Write-Output 'no -Upload: packaged locally only, VPS untouched.'
}
