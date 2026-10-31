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
   * 生成期间的前台服务开关(由 Rust 命令按方法名字符串经 JNI 调用)。
   * 服务在时 WryActivity.onPause 不暂停 WebView:切后台 JS/SSE 继续跑,
   * 完成那一刻前端才能调系统通知。必须在 App 仍在前台时调用(发送消息时)。
   */
  fun startGenerationNotification() {
    try {
      GenerationService.start(this)
    } catch (e: Exception) {
      Log.w("AIChattGen", "start generation service failed: $e")
    }
  }

  fun stopGenerationNotification() {
    try {
      GenerationService.stop(this)
    } catch (e: Exception) {
      Log.w("AIChattGen", "stop generation service failed: $e")
    }
  }

  /**
   * APK 升级后首次启动清一次 WebView HTTP 缓存。缓存位于 app_webview/,
   * 系统「清除缓存」按钮和 install -r 升级都碰不到它;曾把部署前的旧 HTML
   * 锁死(杀进程/清缓存后依旧旧界面)。splash 的 ?cb= 参数是第一道保险,
   * 这里是兜底:仅 versionCode 变化时清一次,平时启动不走全量重拉。
   */
  private fun clearStaleWebCache(webView: WebView) {
    try {
      val ctx = webView.context
      val prefs = ctx.getSharedPreferences("aichatt_shell", Context.MODE_PRIVATE)
      val current = try {
        @Suppress("DEPRECATION")
        if (android.os.Build.VERSION.SDK_INT >= 28) {
          ctx.packageManager.getPackageInfo(ctx.packageName, 0).longVersionCode
        } else {
          ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionCode.toLong()
        }
      } catch (e: Exception) {
        Log.w("AIChattWebCache", "read versionCode failed: $e")
        return
      }
      if (prefs.getLong("webcache_cleared_ver", -1L) == current) return
      webView.clearCache(true)
      prefs.edit().putLong("webcache_cleared_ver", current).apply()
      Log.d("AIChattWebCache", "webview cache cleared for versionCode=$current")
    } catch (e: Exception) {
      Log.w("AIChattWebCache", "clear cache failed: $e")
    }
  }

  /**
   * WebView 的长按菜单是系统的 floating ActionMode（TYPE_FLOATING）。
   * 系统在 Activity.onWindowStartingActionMode 返回 null 后会自己创建浮动菜单，
   * 拿不到建好的回调；但菜单启动一定经过 View 的 parent 链。这里给 WebView 套一层
   * 只负责拦截的透明父容器，在 callback 进入系统之前换掉它。
   */
  override fun onWebViewCreate(webView: WebView) {
    clearStaleWebCache(webView)
    // release 包默认关 WebView 调试;CDP 排障(资源指纹/渲染取证)需要它。
    // 仅本机 adb(usb/无线调试授权后)可达,不暴露网络面。
    WebView.setWebContentsDebuggingEnabled(true)
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

      val wrapper = MenuFilterLayout(webView.context, webView)
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
private class MenuFilterLayout(
  context: Context,
  private val webView: WebView,
) : FrameLayout(context) {
  init {
    Log.d("AIChattMenu", "MenuFilterLayout created")
  }

  override fun startActionModeForChild(
    originalView: View,
    callback: ActionMode.Callback,
    type: Int,
  ): ActionMode? =
    super.startActionModeForChild(originalView, MenuFilterCallback(callback, webView), type)

  @Suppress("DEPRECATION")
  override fun startActionModeForChild(
    originalView: View,
    callback: ActionMode.Callback,
  ): ActionMode? = super.startActionModeForChild(originalView, MenuFilterCallback(callback, webView))
}

/**
 * 只裁浏览器/系统附加的条目，不接管菜单本身：
 * - 输入框（菜单里有「粘贴」）：保留剪贴板/撤销等编辑项，压掉分享/翻译/朗读/网页搜索；
 * - 只读文本选区（有复制或全选）：复制/全选 + 应用动作（引用回复/收藏/存为错题/编辑/重新生成），
 *   应用动作按长按位置所属消息的 data-* 标记动态显隐；
 * - 图片、链接等其他菜单（既无粘贴也无复制/全选）：原样放行，避免误伤。
 *
 * 应用动作不改 WebView 自身的菜单行为：点击后通过 evaluateJavascript 派发
 * `aichatt:longpress-action` 事件，由 MessageBubble 里现成的 handler 执行。
 */
private class MenuFilterCallback(
  private val delegate: ActionMode.Callback?,
  private val webView: WebView,
) : ActionMode.Callback2() {
  private data class MenuContext(
    val canEdit: Boolean,
    val canRegenerate: Boolean,
    val canStudy: Boolean,
    val canFavorite: Boolean,
  )

  /** 只在本轮 ActionMode 首次裁剪时查询消息上下文（invalidate 会再次进 prepare）。 */
  private var contextQueried = false
  private var menuContext: MenuContext? = null

  override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
    val created = delegate?.onCreateActionMode(mode, menu) ?: false
    trim(mode, menu)
    Log.d("AIChattMenu", "onCreate items=${dump(menu)}")
    return created
  }

  override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
    val prepared = delegate?.onPrepareActionMode(mode, menu) ?: false
    trim(mode, menu)
    Log.d("AIChattMenu", "onPrepare items=${dump(menu)}")
    return prepared
  }

  override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
    val action = when (item.itemId) {
      ID_QUOTE -> "quote"
      ID_STUDY -> "study"
      ID_FAVORITE -> "favorite"
      ID_EDIT -> "edit"
      ID_REGENERATE -> "regenerate"
      else -> null
    }
    if (action != null) {
      dispatchAction(action, mode)
      return true
    }
    return delegate?.onActionItemClicked(mode, item) ?: false
  }

  override fun onDestroyActionMode(mode: ActionMode) {
    delegate?.onDestroyActionMode(mode)
  }

  override fun onGetContentRect(mode: ActionMode?, view: View?, outRect: android.graphics.Rect?) {
    val d = delegate
    if (d is ActionMode.Callback2) d.onGetContentRect(mode, view, outRect)
    else super.onGetContentRect(mode, view, outRect)
  }

  private fun trim(mode: ActionMode, menu: Menu) {
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
        hasTextSelectionCore -> isCopyOrSelectAll(item) || isAppAction(item)
        else -> true
      }
      if (!keep) item.isVisible = false
    }

    if (!hasEditing && hasTextSelectionCore) {
      ensureAppActions(menu)
      applyAppActionVisibility(menu)
      if (!contextQueried) {
        contextQueried = true
        queryMenuContext { context ->
          menuContext = context
          applyAppActionVisibility(menu)
          try {
            mode.invalidate()
          } catch (e: Exception) {
            Log.w("AIChattMenu", "invalidate failed: $e")
          }
        }
      }
    }
  }

  private fun ensureAppActions(menu: Menu) {
    if (menu.findItem(ID_QUOTE) != null) return
    addAction(menu, ID_QUOTE, 1000, "引用回复")
    addAction(menu, ID_FAVORITE, 1001, "收藏")
    addAction(menu, ID_STUDY, 1002, "存为错题")
    addAction(menu, ID_EDIT, 1003, "编辑")
    addAction(menu, ID_REGENERATE, 1004, "重新生成")
  }

  private fun addAction(menu: Menu, id: Int, order: Int, title: String) {
    val item = menu.add(Menu.NONE, id, order, title)
    item.setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
    item.isVisible = false
  }

  /** 上下文未知（还没查回来 / 选区不在消息里）时四项全隐，避免在不该出现的地方露出来。 */
  private fun applyAppActionVisibility(menu: Menu) {
    val context = menuContext
    menu.findItem(ID_QUOTE)?.isVisible = context != null
    menu.findItem(ID_FAVORITE)?.isVisible = context?.canFavorite == true
    menu.findItem(ID_STUDY)?.isVisible = context?.canStudy == true
    menu.findItem(ID_EDIT)?.isVisible = context?.canEdit == true
    menu.findItem(ID_REGENERATE)?.isVisible = context?.canRegenerate == true
  }

  /**
   * 选区锚点向上找 [data-message-id] 容器，读前端预先标注的能力标记。
   * 必须异步：菜单创建是同步的，而 WebView 里的选区状态只能经 JS 读取。
   */
  private fun queryMenuContext(onResult: (MenuContext?) -> Unit) {
    webView.evaluateJavascript(MENU_CONTEXT_JS) { result ->
      val context = try {
        if (result.isNullOrBlank() || result == "null") {
          null
        } else {
          val obj = org.json.JSONObject(result)
          MenuContext(
            canEdit = obj.optBoolean("canEdit", false),
            canRegenerate = obj.optBoolean("canRegenerate", false),
            canStudy = obj.optBoolean("canStudy", false),
            canFavorite = obj.optBoolean("canFavorite", false),
          )
        }
      } catch (e: Exception) {
        Log.w("AIChattMenu", "parse menu context failed: $e")
        null
      }
      onResult(context)
    }
  }

  /**
   * 把动作交回前端。finish 放在 JS 回调里：ActionMode 一关选区就没了，
   * 先让 JS 读完 selection 再收菜单，否则「引用回复」拿不到用户选中的那段。
   */
  private fun dispatchAction(action: String, mode: ActionMode) {
    val js = DISPATCH_JS.replace("__ACTION__", action)
    webView.evaluateJavascript(js) {
      try {
        mode.finish()
      } catch (e: Exception) {
        Log.w("AIChattMenu", "finish failed: $e")
      }
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

  private fun isAppAction(item: MenuItem): Boolean =
    item.itemId == ID_QUOTE || item.itemId == ID_STUDY || item.itemId == ID_FAVORITE ||
      item.itemId == ID_EDIT || item.itemId == ID_REGENERATE

  private fun isBlocked(item: MenuItem): Boolean {
    val title = titleOf(item)
    return BLOCKED.any { title.contains(it) }
  }

  companion object {
    private const val ID_QUOTE = 0x00A1C001
    private const val ID_STUDY = 0x00A1C002
    private const val ID_EDIT = 0x00A1C003
    private const val ID_REGENERATE = 0x00A1C004
    private const val ID_FAVORITE = 0x00A1C005

    private val COPY_TITLES = setOf("复制", "複製", "copy")
    private val SELECT_ALL_TITLES = setOf("全选", "全選", "select all")
    private val BLOCKED = listOf(
      "分享", "share",
      "翻译", "翻譯", "translate",
      "朗读", "朗讀", "read aloud", "listen to this page",
      "网页搜索", "網頁搜尋", "搜索网页", "搜尋網頁", "web search",
      "搜索", "搜尋",
    )

    /** 选区锚点 → 消息容器能力标记（前端在 MessageBubble 外层 data-* 上标注） */
    private val MENU_CONTEXT_JS = """
      (function () {
        try {
          var sel = window.getSelection();
          var node = sel && sel.anchorNode;
          var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
          var wrap = el && el.closest ? el.closest('[data-message-id]') : null;
          if (!wrap) return null;
          return {
            canEdit: wrap.getAttribute('data-can-edit') === '1',
            canRegenerate: wrap.getAttribute('data-can-regenerate') === '1',
            canStudy: wrap.getAttribute('data-can-study') === '1',
            canFavorite: wrap.getAttribute('data-can-favorite') === '1'
          };
        } catch (e) {
          return null;
        }
      })();
    """.trimIndent()

    /** __ACTION__ 由 dispatchAction 替换；selection 夹到 2000 字，够引用且不撑爆输入框文案。 */
    private val DISPATCH_JS = """
      (function () {
        try {
          var sel = window.getSelection();
          var node = sel && sel.anchorNode;
          var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
          var wrap = el && el.closest ? el.closest('[data-message-id]') : null;
          window.dispatchEvent(new CustomEvent('aichatt:longpress-action', {
            detail: {
              action: '__ACTION__',
              messageId: wrap ? wrap.getAttribute('data-message-id') : null,
              selection: sel ? String(sel).slice(0, 2000) : ''
            }
          }));
        } catch (e) {}
      })();
    """.trimIndent()
  }
}
