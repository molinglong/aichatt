# Android APK build for aichatt (remote-shell Tauri).
#
# Two environment walls this script works around, both Windows-specific:
#  1) ld.lld cannot read non-ASCII paths and rustc canonicalizes the workspace, so a
#     junction/short-name does not help: src-tauri is mirrored to an ASCII directory
#     and the build actually runs there. The repo stays the single source of truth.
#  2) The Tauri CLI *symlinks* libaichatt_lib.so into jniLibs, which Windows refuses
#     unless the machine has Developer Mode / SeCreateSymbolicLinkPrivilege. Instead
#     of touching system settings we copy the .so in as a plain file and drive Gradle
#     with its rustBuild* tasks excluded (they would call the CLI and hit the same wall).
#
# Usage: powershell -File scripts\android-build.ps1 [-Abi aarch64|armv7|i686|x86_64] [-Debug] [-Stamp yyyyMMddHH]
# Default is a release build signed with the key material kept outside the repo
# (D:\aichatt-secrets\keystore.properties). Pass -Debug for the fast dev variant.
# -Stamp overrides the hourly version stamp when republishing within the same hour.
param(
    [ValidateSet('aarch64', 'armv7', 'i686', 'x86_64')]
    [string]$Abi = 'aarch64',
    [switch]$Debug,
    [string]$Stamp = ''
)
$ErrorActionPreference = 'Stop'

$repo       = Split-Path -Parent $PSScriptRoot
$src        = Join-Path $repo 'src-tauri'
$mirrorRoot = 'D:\aichatt-android'
$dest       = Join-Path $mirrorRoot 'src-tauri'
$cli        = Join-Path $mirrorRoot 'node_modules\@tauri-apps\cli\tauri.js'
$variant    = if ($Debug) { 'debug' } else { 'release' }
$log        = Join-Path $mirrorRoot "build-$variant.log"
$gradleLog  = Join-Path $mirrorRoot "gradle-$variant.log"
$abi        = $Abi

$tripleMap = @{ aarch64 = 'aarch64-linux-android'; armv7 = 'armv7-linux-androideabi';
                i686 = 'i686-linux-android'; x86_64 = 'x86_64-linux-android' }
$jniMap    = @{ aarch64 = 'arm64-v8a'; armv7 = 'armeabi-v7a'; i686 = 'x8'; x86_64 = 'x86_64' }
$archMap   = @{ aarch64 = 'Arm64'; armv7 = 'Arm'; i686 = 'X8'; x86_64 = 'X86_64' }

$env:ANDROID_HOME     = 'D:\AndroidSDK'
$env:NDK_HOME         = 'D:\AndroidSDK\ndk\27.0.12077973'
$env:ANDROID_NDK_HOME = $env:NDK_HOME
$env:JAVA_HOME        = 'D:\JDK'

New-Item -ItemType Directory -Force -Path $mirrorRoot | Out-Null
Write-Output "mirror: $src -> $dest"
robocopy $src $dest /MIR /XD target build .gradle .kotlin /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy src-tauri failed with code $LASTEXITCODE" }

# 插件安卓模块接线（2026-10-28 启动闪退根因）：
# tauri.settings.gradle / app/tauri.build.gradle.kts 是 CLI 自动生成物，但本机
# CLI 在 .so 符号链接处失败，永远走不到重新生成那一步；仓库里那份停在上次
# android init。漏接一个插件 = Rust 注册了它、APK 里没有对应类，启动时
# WryActivity.getAppClass 抛 ClassNotFoundException → SIGABRT 闪退（haptics 即此案）。
# /MIR 之后按 Cargo.toml 依赖 + cargo registry 里的 android 目录幂等补齐。
$androidDir = Join-Path $dest 'gen\android'
$settingsGradle = Join-Path $androidDir 'tauri.settings.gradle'
$pluginBuildGradle = Join-Path $androidDir 'app\tauri.build.gradle.kts'
if ((Test-Path $settingsGradle) -and (Test-Path $pluginBuildGradle)) {
    $cargoToml = Get-Content (Join-Path $dest 'Cargo.toml') -Raw
    $pluginNames = [regex]::Matches($cargoToml, '(?m)^\s*(tauri-plugin-[a-z0-9-]+)\s*=') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
    $registryRoots = Get-ChildItem (Join-Path $env:USERPROFILE '.cargo\registry\src') -Directory -ErrorAction SilentlyContinue
    $settingsText = Get-Content $settingsGradle -Raw
    $buildText = Get-Content $pluginBuildGradle -Raw
    $settingsChanged = $false
    $buildChanged = $false
    foreach ($name in $pluginNames) {
        $androidProject = $null
        foreach ($root in $registryRoots) {
            $cand = Get-ChildItem $root.FullName -Directory -Filter "$name-*" -ErrorAction SilentlyContinue |
                Where-Object { Test-Path (Join-Path $_.FullName 'android') } |
                Sort-Object LastWriteTime | Select-Object -Last 1
            if ($cand) { $androidProject = Join-Path $cand.FullName 'android'; break }
        }
        if (-not $androidProject) { continue }
        if ($settingsText -notmatch [regex]::Escape("include ':$name'")) {
            $escaped = $androidProject -replace '\\', '\\\\'
            $settingsText = $settingsText.TrimEnd() + "`r`ninclude ':$name'`r`nproject(':$name').projectDir = new File(`"$escaped`")`r`n"
            $settingsChanged = $true
            Write-Output "wired gradle project: $name"
        }
        if ($buildText -notmatch [regex]::Escape("project(`":$name`")")) {
            $buildText = $buildText -replace '(?s)(dependencies\s*\{\r?\n)', ('$1  implementation(project(":' + $name + '"))' + "`n")
            $buildChanged = $true
            Write-Output "wired app dependency: $name"
        }
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if ($settingsChanged) { [System.IO.File]::WriteAllText($settingsGradle, $settingsText, $utf8NoBom) }
    if ($buildChanged) { [System.IO.File]::WriteAllText($pluginBuildGradle, $buildText, $utf8NoBom) }
}

# /MIR 会删掉镜像 target；保留根镜像里已编译好的 .so，
# 让 CLI 的符号链接失败后仍能走 Gradle 直编回退（不重编 Rust）。
$seedSo = Join-Path $mirrorRoot 'target\aarch64-linux-android\release\libaichatt_lib.so'
$destSo = Join-Path $dest 'target\aarch64-linux-android\release\libaichatt_lib.so'
if ((Test-Path $seedSo) -and -not (Test-Path $destSo)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $destSo) | Out-Null
    Copy-Item $seedSo $destSo -Force
    Write-Output "seeded native lib from mirror root"
}

# 生成期保活补丁：WryActivity.kt 在 .gitignore 里（tauri android init 会重置），
# 但生成期间必须跳过 mWebView.onPause()，否则切后台 JS 冻结、完成通知发不出去。
# 这里在镜像上幂等重放；工作区已带补丁时直接跳过。
$wry = Join-Path $dest 'gen\android\app\src\main\java\com\aichatt\app\generated\WryActivity.kt'
if (Test-Path $wry) {
  $wryText = Get-Content $wry -Raw -Encoding UTF8
  if ($wryText -notmatch 'GenerationService\.keepWebViewAlive') {
    $wryPatched = $wryText -replace `
      '(?s)(override fun onPause\(\) \{.*?if \(::mWebView\.isInitialized\) \{\s*)mWebView\.onPause\(\)(\s*\})', `
      '$1if (com.aichatt.app.GenerationService.keepWebViewAlive) { android.util.Log.d("AIChattGen", "skip WebView.onPause (generation foreground)") } else { mWebView.onPause() }$2'
    if ($wryPatched -eq $wryText) {
      throw "WryActivity.onPause 结构与预期不符，生成期保活补丁未应用"
    }
    [System.IO.File]::WriteAllText($wry, $wryPatched, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output 'patched WryActivity.onPause (generation foreground)'
  }
}

# CLI 2.11.4 的模板仍调用 PluginManager.onCreate(this)/onResume(this)，
# 但 Rust 侧 tauri 2.11.5 已改成 onActivityCreate(activity) 与无参生命周期。
# 幂等修正生成文件，避免 Kotlin 编译阶段整批 unresolved。
$tauriActivity = Join-Path $dest 'gen\android\app\src\main\java\com\aichatt\app\generated\TauriActivity.kt'
if (Test-Path $tauriActivity) {
  $ta = Get-Content $tauriActivity -Raw -Encoding UTF8
  $taPatched = $ta.
    Replace('PluginManager.onCreate(this)', 'PluginManager.onActivityCreate(this)').
    Replace('PluginManager.onResume(this)', 'PluginManager.onResume()').
    Replace('PluginManager.onPause(this)', 'PluginManager.onPause()').
    Replace('PluginManager.onStop(this)', 'PluginManager.onStop()')
  if ($taPatched -ne $ta) {
    [System.IO.File]::WriteAllText($tauriActivity, $taPatched, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output 'patched TauriActivity PluginManager API (tauri 2.11.5)'
  }
}
# The CLI is mirrored too, so no path handed to the toolchain ever contains non-ASCII.
robocopy (Join-Path $repo 'node_modules\@tauri-apps') `
  (Join-Path $mirrorRoot 'node_modules\@tauri-apps') /MIR /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy tauri cli failed with code $LASTEXITCODE" }

# Stamp a build-hour version (0.2.yyyyMMddHH) into the MIRROR config only; the repo
# keeps its static 0.2.0. versionCode follows the CLI formula major*1e6+minor*1e3+patch
# and stays monotonic under hourly stamps (< 2^31 until year 2132). tauri.properties is
# written directly so the Gradle fallback path (CLI may die on the symlink wall before
# regenerating it) also sees the stamped values; on the CLI path it gets regenerated
# from tauri.android.conf.json to the same numbers.
$stamp   = if ($Stamp) { $Stamp } else { Get-Date -Format 'yyyyMMddHH' }
if ($stamp -notmatch '^\d{10}$') { throw "-Stamp must be yyyyMMddHH (10 digits), got '$stamp'" }
$version = "0.2.$stamp"
$p       = $version.Split('.')
$vcode   = [string]([long]$p[0] * 1000000 + [long]$p[1] * 1000 + [long]$p[2])
$vconf   = Join-Path $dest 'tauri.android.conf.json'
$vjson   = Get-Content $vconf -Raw -Encoding UTF8 | ConvertFrom-Json
$vjson | Add-Member -NotePropertyName version -NotePropertyValue $version -Force
[System.IO.File]::WriteAllText($vconf, ($vjson | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
$props = Join-Path $dest 'gen\android\app\tauri.properties'
if (Test-Path $props) {
  $propText = @(
    '// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
    "tauri.android.versionName=$version",
    "tauri.android.versionCode=$vcode"
  ) -join "`r`n"
  [System.IO.File]::WriteAllText($props, $propText, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output "version stamp: $version (versionCode $vcode)"

# CLI 实际编译的是【镜像根项目】(见 cargo 日志 "Compiling aichatt ... (D:\aichatt-android)")，
# 而 robocopy 只同步到 src-tauri —— 根目录的 splash/、tauri.conf.json 是历史副本，
# 只改前端资源时根项目仍用旧文件，页面改动静默不生效(2026-10-28 闪屏滚动条修复撞上)。
# 每轮把编译期输入从 src-tauri 同步回根项目；tauri.android.conf.json 已带本轮版本戳。
foreach ($rel in @('src', 'splash', 'capabilities', 'permissions', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'tauri.android.conf.json')) {
    $from = Join-Path $dest $rel
    if (-not (Test-Path $from)) { continue }
    $to = Join-Path $mirrorRoot $rel
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse -Force
}

# frontendDist(splash/*.html)是编译期嵌进 libaichatt_lib.so 的，cargo 不跟踪这些文件；
# touch 源文件也判 fresh(实测)。无条件删掉 crate 的 fingerprint 与产物，保证每轮都重编、
# 资源一定重新嵌入。代价约 1-2 分钟，换来"改页面必定生效"。
$soRoot = Join-Path $mirrorRoot ('target\{0}\{1}\libaichatt_lib.so' -f $tripleMap[$abi], $variant)
$fingerprintDir = Join-Path $mirrorRoot ('target\{0}\{1}\.fingerprint' -f $tripleMap[$abi], $variant)
if (Test-Path $fingerprintDir) {
    Get-ChildItem $fingerprintDir -Directory -Filter 'aichatt-*' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item $soRoot -Force -ErrorAction SilentlyContinue
Write-Output "crate fingerprint invalidated -> frontend assets will be re-embedded"

Push-Location $mirrorRoot
try {
  # cmd owns the redirect: PowerShell 5.1 turns a native command's stderr into an
  # error record while ErrorActionPreference=Stop, which killed the build on its
  # first informational line. tauri.android.conf.json is auto-merged by the CLI.
  $modeFlag = if ($Debug) { '--debug ' } else { '' }
  cmd /c ('node "{0}" android build --apk {1}--target {2} > "{3}" 2>&1' -f $cli, $modeFlag, $abi, $log)

  if ($LASTEXITCODE -ne 0 -and (Get-Content $log -Raw) -match 'symbolic link') {
    Write-Output 'CLI blocked on symlink privilege -> copying .so and running Gradle directly'
    $arch = $archMap[$abi]
    # 必须优先用 CLI 刚编出来的镜像根产物：src-tauri/target 里那份是构建前 seed 的旧拷贝，
    # 用它打包会把刚编译的 Rust/嵌入资源静默丢掉（2026-10-28 实锤）
    $soFresh = Join-Path $mirrorRoot ('target\{0}\{1}\libaichatt_lib.so' -f $tripleMap[$abi], $variant)
    $so = if (Test-Path $soFresh) { $soFresh } else { Join-Path $dest ('target\{0}\{1}\libaichatt_lib.so' -f $tripleMap[$abi], $variant) }
    if (-not (Test-Path $so)) { throw "cargo produced no shared library at $so" }
    $jniDir = Join-Path $dest ('gen\android\app\src\main\jniLibs\{0}' -f $jniMap[$abi])
    New-Item -ItemType Directory -Force -Path $jniDir | Out-Null
    Copy-Item $so $jniDir -Force

    $props = Join-Path $dest 'gen\android\local.properties'
    if (-not (Test-Path $props)) {
      Set-Content -Path $props -Value 'sdk.dir=D:/AndroidSDK' -Encoding ASCII
    }

    Push-Location (Join-Path $dest 'gen\android')
    try {
      $taskSuffix = if ($Debug) { 'Debug' } else { 'Release' }
      cmd /c ('gradlew.bat :app:assemble{0}{1} -x rustBuild{0}{1} -x rustBuildUniversal{1} > "{2}" 2>&1' `
        -f $arch, $taskSuffix, $gradleLog)
      if ($LASTEXITCODE -ne 0) { Get-Content $gradleLog -Tail 40; throw "gradle failed with code $LASTEXITCODE" }
    } finally { Pop-Location }
  } elseif ($LASTEXITCODE -ne 0) {
    Get-Content $log -Tail 40
    throw "tauri android build failed with code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$apk = Get-ChildItem -Path (Join-Path $dest 'gen\android\app') -Recurse -Filter "*-$variant.apk" |
  Where-Object { $_.Name -notlike '*-unsigned.apk' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) { throw "build reported success but no signed $variant apk was produced" }
$out = Join-Path $repo ("aichatt-{0}.apk" -f $variant)
Copy-Item $apk.FullName $out -Force
Write-Output ("APK ({0}): {1}  {2} MB" -f $variant, $out, [math]::Round($apk.Length / 1MB, 1))
