# android-sign-lineage.ps1 - re-sign an APK with the debug->release key lineage.
#
# Why: the first release-signed build (0.2.2026102123) carried a signing lineage so
# installs that still authenticate with the old debug key (Android <= 12, and any
# device that has not yet taken the transition build) can update in place. Gradle
# alone signs with the release key only, so run this on its output whenever that
# compatibility matters.
#
# Input can be the Gradle-signed aichatt-release.apk; apksigner replaces existing
# signatures. Output is aligned and signed with both keys:
#   - release key for SDK 33+ (APK Signature Scheme v3.1)
#   - debug key for SDK 24..32 (v2), tied together by --lineage
#
# Usage: powershell -File scripts\android-sign-lineage.ps1 -Apk <input.apk> [-Out <output.apk>]
# Signing material stays outside the repo: D:\aichatt-secrets (override with
# AICHATT_KEYSTORE_PROPERTIES / AICHATT_LINEAGE / AICHATT_DEBUG_KEYSTORE).
param(
    [Parameter(Mandatory = $true)]
    [string]$Apk,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

$buildTools  = 'D:\AndroidSDK\build-tools\36.0.0'
$apksigner   = Join-Path $buildTools 'apksigner.bat'
$zipalign    = Join-Path $buildTools 'zipalign.exe'
$secrets     = if ($env:AICHATT_KEYSTORE_PROPERTIES) { $env:AICHATT_KEYSTORE_PROPERTIES } else { 'D:\aichatt-secrets\keystore.properties' }
$lineage     = if ($env:AICHATT_LINEAGE) { $env:AICHATT_LINEAGE } else { 'D:\aichatt-secrets\lineage-debug-to-release.bin' }
$debugKs     = if ($env:AICHATT_DEBUG_KEYSTORE) { $env:AICHATT_DEBUG_KEYSTORE } else { Join-Path $env:USERPROFILE '.android\debug.keystore' }
$debugPw     = if ($env:AICHATT_DEBUG_KEYSTORE_PASSWORD) { $env:AICHATT_DEBUG_KEYSTORE_PASSWORD } else { 'android' }

function Invoke-NativeText([string]$exe, [string[]]$argv) {
    $outLog = Join-Path $env:TEMP ("aichatt-out-{0}.log" -f [guid]::NewGuid().ToString('N'))
    $errLog = Join-Path $env:TEMP ("aichatt-err-{0}.log" -f [guid]::NewGuid().ToString('N'))
    $argLine = ($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', ('"{0}" {1}' -f $exe, $argLine)) `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $text = [System.IO.File]::ReadAllText($outLog) + [System.IO.File]::ReadAllText($errLog)
    Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Code = $p.ExitCode; Text = $text }
}

foreach ($f in @($Apk, $secrets, $lineage, $debugKs, $apksigner, $zipalign)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "missing required file: $f" }
}
if (-not $Out) {
    $Out = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Apk)) `
        ((Get-Item -LiteralPath $Apk).BaseName + '-lineage.apk')
}

$props = @{}
Get-Content -LiteralPath $secrets | ForEach-Object {
    if ($_ -match '^([^#=]+)=(.*)$') { $props[$Matches[1].Trim()] = $Matches[2].Trim() }
}
$storeFile = $props['storeFile']
$storePw   = $props['storePassword']
$keyAlias  = $props['keyAlias']
$keyPw     = if ($props['keyPassword']) { $props['keyPassword'] } else { $storePw }
$certSha   = if ($props['certSha256']) { ($props['certSha256'] -replace '[^0-9A-Fa-f]', '').ToUpper() } else { '' }
if (-not $storeFile -or -not $storePw -or -not $keyAlias) { throw "incomplete signing properties: $secrets" }
if (-not $certSha) { throw "signing properties have no certSha256: $secrets" }

$tmp = Join-Path $env:TEMP ("aichatt-sign-{0}" -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$relPwFile   = Join-Path $tmp 'release.pw'
$debugPwFile = Join-Path $tmp 'debug.pw'
[System.IO.File]::WriteAllText($relPwFile, $storePw)
[System.IO.File]::WriteAllText($debugPwFile, $debugPw)
$noKeyPw = $keyPw -eq $storePw

try {
    # Align first: apksigner keeps alignment but does not add it.
    $aligned = Join-Path $tmp 'aligned.apk'
    $align = Invoke-NativeText $zipalign @('-f', '-P', '16', '4', (Resolve-Path -LiteralPath $Apk), $aligned)
    if ($align.Code -ne 0) { Write-Output $align.Text; throw "zipalign failed with code $($align.Code)" }

    $signArgs = @(
        'sign',
        '--ks', $storeFile, '--ks-type', 'PKCS12',
        '--ks-pass', ('file:' + $relPwFile),
        '--ks-key-alias', $keyAlias
    )
    if (-not $noKeyPw) { $signArgs += @('--key-pass', ('file:' + $relPwFile)) }
    $signArgs += @(
        '--next-signer',
        '--ks', $debugKs, '--ks-type', 'JKS',
        '--ks-pass', ('file:' + $debugPwFile),
        '--ks-key-alias', 'androiddebugkey',
        '--lineage', $lineage,
        '--rotation-min-sdk-version', '33',
        '--v1-signing-enabled', 'false',
        '--v2-signing-enabled', 'true',
        '--v3-signing-enabled', 'true',
        '--v4-signing-enabled', 'false',
        '--out', $Out,
        $aligned
    )
    $signed = Invoke-NativeText $apksigner $signArgs
    if ($signed.Code -ne 0) { Write-Output $signed.Text; throw "apksigner sign failed with code $($signed.Code)" }

    $verify = Invoke-NativeText $apksigner @('verify', '-v', '--print-certs', $Out)
    if ($verify.Code -ne 0) { Write-Output $verify.Text; throw "apksigner verify failed with code $($verify.Code)" }
    $v2 = $verify.Text -match 'Verified using v2 scheme \(APK Signature Scheme v2\): true'
    $v3 = $verify.Text -match 'Verified using v3 scheme \(APK Signature Scheme v3\): true'
    $v31 = $verify.Text -match 'Verified using v3\.1 scheme \(APK Signature Scheme v3\.1\): true'
    $digests = [regex]::Matches($verify.Text, 'certificate SHA-256 digest:\s*([0-9a-fA-F:]+)') |
        ForEach-Object { ($_.Groups[1].Value -replace '[^0-9A-Fa-f]', '').ToUpper() }
    if (-not ($v2 -and $v3 -and $v31)) { throw "lineage APK missing schemes: v2=$v2 v3=$v3 v3.1=$v31" }
    if ($digests -notcontains $certSha) { throw "release cert not among signers: $($digests -join ', ')" }
    if ($digests.Count -lt 2) { throw "expected debug + release signers, got $($digests.Count)" }

    $alignCheck = Invoke-NativeText $zipalign @('-c', '-P', '16', '4', $Out)
    if ($alignCheck.Code -ne 0) { throw "16KB alignment check failed: $($alignCheck.Text)" }

    Write-Output ("signed: {0} ({1} MB)" -f $Out, [math]::Round((Get-Item -LiteralPath $Out).Length / 1MB, 1))
    Write-Output ("schemes: v2={0} v3={1} v3.1={2}; signers={3}" -f $v2, $v3, $v31, $digests.Count)
    Write-Output "release cert sha256: $certSha"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
