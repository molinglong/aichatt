# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# JNI 按方法名字符串调用 MainActivity:前台服务/更新下载 wake lock。
# 当前 release 构建 R8 关闭,这里先把 keep 钉住,避免以后开启 minify 后
# 「点发送不弹通知 / 下载被中断」且没有任何编译期报错。
-keepclassmembers class com.aichatt.app.MainActivity {
    public void startGenerationNotification();
    public void stopGenerationNotification();
    public void acquireDownloadWakeLock();
    public void releaseDownloadWakeLock();
}