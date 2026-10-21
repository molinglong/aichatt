package com.aichatt.app

import android.content.Context
import android.os.Bundle
import android.os.PowerManager
import android.util.Log
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var updateWakeLock: PowerManager.WakeLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * 更新包下载期间持 PARTIAL_WAKE_LOCK:Rust 下载线程在切后台/息屏时继续跑。
   * 由 updater.rs 经 JNI 按方法名字符串调用,改名要同步两处(R8 开启后还需 keep)。
   */
  fun acquireDownloadWakeLock() {
    if (updateWakeLock?.isHeld == true) return
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      updateWakeLock =
        pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aichatt:update-download").apply {
          setReferenceCounted(false)
          // 1 小时上限兜底;正常结束由 releaseDownloadWakeLock 立即释放
          acquire(60 * 60 * 1000L)
        }
      Log.d("AIChattUpdate", "wake lock acquired")
    } catch (e: Exception) {
      Log.w("AIChattUpdate", "acquire wake lock failed: $e")
    }
  }

  fun releaseDownloadWakeLock() {
    try {
      updateWakeLock?.let { if (it.isHeld) it.release() }
    } catch (e: Exception) {
      Log.w("AIChattUpdate", "release wake lock failed: $e")
    }
    updateWakeLock = null
    Log.d("AIChattUpdate", "wake lock released")
  }

  /**
   * WebView 的长按菜单是系统的 floating ActionMode（TYPE_FLOATING）。
   * 系统在 Activity.onWindowStartingActionMode 返回 null 后会自己创建浮动菜单，
   * 拿不到建好的回调；但菜单启动一定经过 View 的 parent 链。这里给 WebView 套一层
   * 只负责拦截的透明父容器，在 callback 进入系统之前换掉它。
   */
  override fun onWebViewCreate(webView: WebView) {
    // 这个回调触发时 wry 还没 setContentView，parent 为空；post 到挂载之后再套壳。
    webView.post {
      Log.d("AIChattMenu", "wrap parent=${webView.parent}")
      val parent = webView.parent as? ViewGroup ?: run {
        Log.d("AIChattMenu", "no ViewGroup parent, skip wrapper")
        return@post
      }
      val index = parent.indexOfChild(webView)
      val params = webView.layoutParams
      parent.removeView(webView)

      val wrapper = MenuFilterLayout(webView.context)
      wrapper.addView(
        webView,
        ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
      parent.addView(wrapper, index, params)
      Log.d("AIChattMenu", "wrapper attached=${wrapper.parent} child=${webView.parent}")
    }
  }
}

/** 透明容器：只重写 action mode 的入口，不参与布局。 */
private class MenuFilterLayout(context: Context) : FrameLayout(context) {
  init {
    Log.d("AIChattMenu", "MenuFilterLayout created")
  }

  override fun startActionModeForChild(
    originalView: View,
    callback: ActionMode.Callback,
    type: Int,
  ): ActionMode? = super.startActionModeForChild(originalView, MenuFilterCallback(callback), type)

  @Suppress("DEPRECATION")
  override fun startActionModeForChild(
    originalView: View,
    callback: ActionMode.Callback,
  ): ActionMode? = super.startActionModeForChild(originalView, MenuFilterCallback(callback))
}

/**
 * 只裁浏览器/系统附加的条目，不接管菜单本身：
 * - 输入框（菜单里有「粘贴」）：保留剪贴板/撤销等编辑项，压掉分享/翻译/朗读/网页搜索；
 * - 只读文本选区（有复制或全选）：只留复制/全选；
 * - 图片、链接等其他菜单（既无粘贴也无复制/全选）：原样放行，避免误伤。
 */
private class MenuFilterCallback(
  private val delegate: ActionMode.Callback?,
) : ActionMode.Callback2() {
  override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
    val created = delegate?.onCreateActionMode(mode, menu) ?: false
    trim(menu)
    Log.d("AIChattMenu", "onCreate items=${dump(menu)}")
    return created
  }

  override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
    val prepared = delegate?.onPrepareActionMode(mode, menu) ?: false
    trim(menu)
    Log.d("AIChattMenu", "onPrepare items=${dump(menu)}")
    return prepared
  }

  override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean =
    delegate?.onActionItemClicked(mode, item) ?: false

  override fun onDestroyActionMode(mode: ActionMode) {
    delegate?.onDestroyActionMode(mode)
  }

  override fun onGetContentRect(mode: ActionMode?, view: View?, outRect: android.graphics.Rect?) {
    val d = delegate
    if (d is ActionMode.Callback2) d.onGetContentRect(mode, view, outRect)
    else super.onGetContentRect(mode, view, outRect)
  }

  private fun trim(menu: Menu) {
    val items = (0 until menu.size()).map { menu.getItem(it) }
    // 输入框菜单一定带粘贴/剪切；只读消息选区没有。用这个区分，避免把输入框的粘贴误删。
    val hasEditing = items.any { isPaste(it) || isCut(it) }
    val hasTextSelectionCore = items.any { isCopyOrSelectAll(it) }
    Log.d(
      "AIChattMenu",
      "hasEditing=$hasEditing textSelection=$hasTextSelectionCore items=${dump(menu)}",
    )

    for (item in items) {
      val keep = when {
        hasEditing -> !isBlocked(item)
        hasTextSelectionCore -> isCopyOrSelectAll(item)
        else -> true
      }
      if (!keep) item.isVisible = false
    }
  }

  private fun dump(menu: Menu): String =
    (0 until menu.size()).joinToString(" | ") {
      val item = menu.getItem(it)
      (item.title?.toString() ?: "<icon>") + if (item.isVisible) "" else "(hidden)"
    }

  private fun titleOf(item: MenuItem): String =
    item.title?.toString()?.trim()?.lowercase() ?: ""

  private fun isPaste(item: MenuItem): Boolean {
    val title = titleOf(item)
    return item.itemId == android.R.id.paste ||
      title.contains("粘贴") || title.contains("貼上") || title.contains("paste")
  }

  private fun isCut(item: MenuItem): Boolean {
    val title = titleOf(item)
    return item.itemId == android.R.id.cut ||
      title.contains("剪切") || title.contains("剪下") || title.contains("cut")
  }

  private fun isCopyOrSelectAll(item: MenuItem): Boolean {
    if (item.itemId == android.R.id.copy || item.itemId == android.R.id.selectAll) return true
    val title = titleOf(item)
    return title in COPY_TITLES || title in SELECT_ALL_TITLES
  }

  private fun isBlocked(item: MenuItem): Boolean {
    val title = titleOf(item)
    return BLOCKED.any { title.contains(it) }
  }

  companion object {
    private val COPY_TITLES = setOf("复制", "複製", "copy")
    private val SELECT_ALL_TITLES = setOf("全选", "全選", "select all")
    private val BLOCKED = listOf(
      "分享", "share",
      "翻译", "翻譯", "translate",
      "朗读", "朗讀", "read aloud", "listen to this page",
      "网页搜索", "網頁搜尋", "搜索网页", "搜尋網頁", "web search",
      "搜索", "搜尋",
    )
  }
}
