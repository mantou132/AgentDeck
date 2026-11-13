package com.mantou.agentdeck

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.Executors

/** Larger shares are reported to the frontend instead of being copied. */
private const val SHARE_MAX_BYTES = 20L * 1024 * 1024

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private val shareExecutor = Executors.newSingleThreadExecutor()

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      splashScreen.setOnExitAnimationListener { splash ->
        splash.postDelayed({ splash.remove() }, 500L)
      }
    }
    // A restored or recents-launched activity gets the original share intent again.
    if (savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) {
      receiveShare(intent)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    leaveSavedApp(intent)
    receiveShare(intent)
  }

  /**
   * A share or push tap while a saved app shows goes back to AgentDeck, which takes it as it starts; links
   * (`ACTION_VIEW`) are handled in `crates/agentdeck/src/saved_apps.rs`.
   */
  private fun leaveSavedApp(intent: Intent) {
    if (intent.action == Intent.ACTION_VIEW) return
    val webView = webView ?: return
    if (Uri.parse(webView.url ?: return).host?.startsWith("agentdeck-app.") != true) return
    webView.evaluateJavascript("location.assign('/__agentdeck/exit')", null)
  }

  /**
   * Copies shared text and files into `cache/shared` and notifies the frontend, which takes them with
   * `share_take` (`crates/agentdeck/src/share.rs`); on a cold start the frontend checks once it boots.
   */
  private fun receiveShare(intent: Intent) {
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    val uris = sharedUris(intent)
    shareExecutor.execute {
      val dir = File(cacheDir, "shared")
      dir.deleteRecursively()
      dir.mkdirs()
      val entries = JSONArray()
      if (!text.isNullOrBlank()) {
        val file = File(dir, "0")
        file.writeText(text)
        entries.put(JSONObject().put("name", textName(subject)).put("mimeType", "text/plain").put("path", file.name))
      }
      uris.forEachIndexed { index, uri -> entries.put(copyUri(uri, File(dir, "${index + 1}"))) }
      if (entries.length() == 0) return@execute
      // Written last: its presence marks the share as complete.
      File(dir, "manifest.json").writeText(entries.toString())
      runOnUiThread { webView?.evaluateJavascript("dispatchEvent(new Event('agentdeck-share'))", null) }
    }
  }

  @Suppress("DEPRECATION")
  private fun sharedUris(intent: Intent): List<Uri> =
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
    } else {
      listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM))
    }

  private fun textName(subject: String?): String {
    val name = subject?.replace(Regex("[\\\\/:*?\"<>|\\n]"), " ")?.trim()?.take(60)
    return "${if (name.isNullOrEmpty()) "shared" else name}.txt"
  }

  private fun copyUri(uri: Uri, file: File): JSONObject {
    val name = displayName(uri) ?: uri.lastPathSegment ?: "shared"
    val entry = JSONObject().put("name", name).put("mimeType", contentResolver.getType(uri) ?: "")
    return try {
      var size = 0L
      contentResolver.openInputStream(uri)?.use { input ->
        file.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (size <= SHARE_MAX_BYTES) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            size += read
          }
        }
      } ?: throw FileNotFoundException(uri.toString())
      if (size > SHARE_MAX_BYTES) {
        file.delete()
        entry.put("tooLarge", true)
      } else {
        entry.put("path", file.name)
      }
    } catch (e: Exception) {
      // Listed without a path, so the frontend reports it as unreadable.
      file.delete()
      entry
    }
  }

  private fun displayName(uri: Uri): String? =
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    } catch (e: Exception) {
      null
    }
}
