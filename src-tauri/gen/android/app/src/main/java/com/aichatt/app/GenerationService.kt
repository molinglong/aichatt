package com.aichatt.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * 生成期间的前台服务。
 *
 * 两个作用:
 *  1. 提升进程优先级,并让 WryActivity 在 onPause 时跳过 mWebView.onPause(),
 *     使切到后台后 WebView 的 JS 与网络继续运行 —— 只有这样才能在「完成那一刻」
 *     由前端调系统通知。否则 JS 被冻结,完成通知永远发不出去。
 *  2. 通知栏常驻「正在生成回复…」,完成/停止后由前端调 stop 移除。
 *
 * 15 分钟兜底:服务端后台生成上限是 10 分钟,这里再留 5 分钟余量。
 * 即使 JS 崩溃或进程状态异常,也不会留下一条永远不消失的常驻通知。
 *
 * 启动时机必须在前台(发送消息时):Android 12+ 禁止从后台启动前台服务。
 */
class GenerationService : Service() {
  companion object {
    private const val TAG = "AIChattGen"
    private const val CHANNEL_ID = "aichatt-generation"
    private const val NOTIFICATION_ID = 47002
    private const val TIMEOUT_MS = 15 * 60 * 1000L

    /**
     * WryActivity.onPause 据此决定是否暂停 WebView。
     * 服务生命周期在 UI 线程之外推进,用 @Volatile 保证可见性。
     */
    @Volatile
    var keepWebViewAlive: Boolean = false
      private set

    fun start(context: Context) {
      ContextCompat.startForegroundService(
        context,
        Intent(context, GenerationService::class.java),
      )
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, GenerationService::class.java))
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private val timeout = Runnable { stopSelf() }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    keepWebViewAlive = true
    ensureChannel()

    val contentIntent =
      PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).apply {
          this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val notification =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("aichatt")
        .setContentText("正在生成回复…")
        .setContentIntent(contentIntent)
        .setOngoing(true)
        .setSilent(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()

    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
          0
        },
      )
    } catch (e: Exception) {
      // 通知权限被拒 / 后台启动被系统拒绝:不拖垮聊天,退回「不保活」的旧路径
      // (切后台冻结 + 服务端续跑 + 回前台补拉)。
      Log.w(TAG, "startForeground failed: $e")
      keepWebViewAlive = false
      stopSelf()
      return START_NOT_STICKY
    }

    handler.removeCallbacks(timeout)
    handler.postDelayed(timeout, TIMEOUT_MS)
    Log.d(TAG, "generation foreground started")
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    keepWebViewAlive = false
    handler.removeCallbacks(timeout)
    Log.d(TAG, "generation foreground stopped")
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "后台生成", NotificationManager.IMPORTANCE_LOW).apply {
        description = "生成回复期间显示的进度通知"
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
      },
    )
  }
}
