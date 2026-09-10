package com.workcrew.appblocker

import android.content.Context
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView

/**
 * Full-screen "display over other apps" window used to interrupt whatever the
 * user is watching. Only one overlay is shown at a time; showing a new one
 * replaces the old. Auto-dismisses so a missed tap can never leave the screen
 * covered forever.
 */
class OverlayReminder(private val context: Context) {

    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val handler = Handler(Looper.getMainLooper())
    private var view: View? = null

    fun show(
        title: String,
        message: String,
        primaryLabel: String,
        onPrimary: () -> Unit = {},
        secondaryLabel: String? = null,
        onSecondary: () -> Unit = {},
        autoDismissMs: Long,
    ) {
        if (!Settings.canDrawOverlays(context)) return
        dismiss()

        val themed = ContextThemeWrapper(context, R.style.Theme_AppBlocker)
        val v = LayoutInflater.from(themed).inflate(R.layout.overlay_reminder, null)
        v.findViewById<TextView>(R.id.overlay_title).text = title
        v.findViewById<TextView>(R.id.overlay_message).text = message

        val primary = v.findViewById<Button>(R.id.overlay_primary)
        primary.text = primaryLabel
        primary.setOnClickListener {
            dismiss()
            onPrimary()
        }

        val secondary = v.findViewById<Button>(R.id.overlay_secondary)
        if (secondaryLabel == null) {
            secondary.visibility = View.GONE
        } else {
            secondary.text = secondaryLabel
            secondary.setOnClickListener {
                dismiss()
                onSecondary()
            }
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        )
        try {
            windowManager.addView(v, params)
        } catch (e: Exception) {
            // Permission revoked mid-run or the window token is gone; skip this
            // interruption rather than crash the service.
            return
        }
        view = v
        if (autoDismissMs > 0) handler.postDelayed({ dismiss() }, autoDismissMs)
    }

    fun dismiss() {
        handler.removeCallbacksAndMessages(null)
        view?.let {
            try {
                windowManager.removeView(it)
            } catch (_: Exception) {
                // Already removed; nothing to do.
            }
        }
        view = null
    }
}
