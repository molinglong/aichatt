package com.aichatt.app

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 无界面授权桥：给同签名的 Plan App 签发一次性 code。
 *
 * 安全边界：
 * - 只接受 startActivityForResult 的调用方，且调用方必须与本 App 同签名；
 * - 只把 code 通过 setResult 返回给调用方，不导出 cookie、不落盘；
 * - code 由服务端用 PLAN_SSO_SECRET 签名，60 秒过期。
 */
class PlanAuthActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private val finished = AtomicBoolean(false)
    private var callerPackage: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val caller = callingPackage
        callerPackage = caller
        Log.w("PlanAuthBridge", "caller=$caller")
        if (caller == null ||
            packageManager.checkSignatures(caller, packageName) != PackageManager.SIGNATURE_MATCH
        ) {
            cancel("caller_invalid:$caller")
            return
        }

        // 冷启动时 WebView Cookie 存储可能还没就绪；创建一次 WebView 触发初始化，短暂重试
        try {
            WebView(this).destroy()
        } catch (_: Exception) {
            // 某些 ROM 上无 WebView 时继续尝试 CookieManager
        }
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        readCookie(0)
    }

    private fun readCookie(attempt: Int) {
        val cookie = try {
            CookieManager.getInstance().getCookie("https://chat.yuban.icu")
        } catch (_: Exception) {
            null
        }
        Log.w("PlanAuthBridge", "cookie attempt=$attempt len=${cookie?.length ?: 0}")
        if (!cookie.isNullOrBlank()) {
            exchange(cookie)
            return
        }
        if (attempt >= 15) {
            cancel("cookie_empty")
            return
        }
        handler.postDelayed({ readCookie(attempt + 1) }, 200)
    }

    private fun exchange(cookie: String) {
        thread(name = "plan-auth") {
            val code = fetchCode(cookie)
            handler.post {
                if (code == null) cancel("exchange_failed")
                else succeed(code)
            }
        }
    }

    private fun fetchCode(cookie: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("https://chat.yuban.icu/api/plan/native-authorize")
                .openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            conn.setRequestProperty("Cookie", cookie)
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "AIChattPlanAuth/1.0")
            val status = conn.responseCode
            Log.w("PlanAuthBridge", "http=$status")
            if (status != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            JSONObject(body).optString("code").takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
                // ignore
            }
        }
    }

    private fun succeed(code: String) {
        if (!finished.compareAndSet(false, true)) return
        // 显式 Intent 回传：不依赖 Activity result 的任务栈规则
        val target = callerPackage
        if (!target.isNullOrBlank()) {
            try {
                startActivity(
                    Intent("icu.yuban.plan.AUTH_RESULT")
                        .setPackage(target)
                        .putExtra("code", code)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) {
                Log.w("PlanAuthBridge", "explicit result failed: $e")
            }
        }
        setResult(RESULT_OK, Intent().putExtra("code", code))
        finish()
    }

    private fun cancel(reason: String) {
        if (!finished.compareAndSet(false, true)) return
        Log.w("PlanAuthBridge", "cancel=$reason")
        Toast.makeText(this, "未能从 aichatt 获取授权", Toast.LENGTH_LONG).show()
        setResult(RESULT_CANCELED, Intent().putExtra("reason", reason))
        finish()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
