package com.mantou.agentdeck

import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      splashScreen.setOnExitAnimationListener { splash ->
        splash.postDelayed({ splash.remove() }, 500L)
      }
    }
  }
}
