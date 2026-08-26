package com.workcrew.appblocker

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * One-screen setup: grant the two special permissions, pick the watched app
 * (YouTube by default), the reminder interval, the hard limit, and where to be
 * sent when time is up, then start the blocker service.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        findViewById<EditText>(R.id.edit_remind).setText(prefs.remindEveryMinutes.toString())
        findViewById<EditText>(R.id.edit_limit).setText(prefs.limitMinutes.toString())

        findViewById<Button>(R.id.btn_usage_access).setOnClickListener {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }
        findViewById<Button>(R.id.btn_overlay).setOnClickListener {
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName"),
                )
            )
        }
        findViewById<Button>(R.id.btn_watched_app).setOnClickListener {
            pickApp(includeHome = false) { pkg, label ->
                if (pkg != null && label != null) {
                    prefs.watchedPackage = pkg
                    prefs.watchedLabel = label
                }
                render()
            }
        }
        findViewById<Button>(R.id.btn_redirect_app).setOnClickListener {
            pickApp(includeHome = true) { pkg, label ->
                prefs.redirectPackage = pkg
                prefs.redirectLabel = label
                render()
            }
        }
        findViewById<Button>(R.id.btn_start).setOnClickListener { startBlocker() }
        findViewById<Button>(R.id.btn_stop).setOnClickListener {
            stopService(Intent(this, BlockerService::class.java))
            renderSoon()
        }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1
            )
        }
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        findViewById<TextView>(R.id.txt_service_status).text = getString(
            if (BlockerService.isRunning) R.string.status_running else R.string.status_stopped
        )
        findViewById<TextView>(R.id.txt_usage_access).text = getString(
            if (hasUsageAccess()) R.string.granted else R.string.not_granted
        )
        findViewById<TextView>(R.id.txt_overlay).text = getString(
            if (Settings.canDrawOverlays(this)) R.string.granted else R.string.not_granted
        )
        findViewById<TextView>(R.id.txt_watched_app).text = prefs.watchedLabel
        findViewById<TextView>(R.id.txt_redirect_app).text =
            prefs.redirectLabel ?: getString(R.string.home_screen)
    }

    // The service flips isRunning asynchronously; re-render after it settles.
    private fun renderSoon() {
        render()
        window.decorView.postDelayed({ if (!isDestroyed) render() }, 500)
    }

    private fun startBlocker() {
        prefs.remindEveryMinutes = fieldMinutes(R.id.edit_remind, prefs.remindEveryMinutes)
        prefs.limitMinutes = fieldMinutes(R.id.edit_limit, prefs.limitMinutes)
        if (!hasUsageAccess()) {
            Toast.makeText(this, R.string.need_usage_access, Toast.LENGTH_LONG).show()
            return
        }
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, R.string.need_overlay, Toast.LENGTH_LONG).show()
            return
        }
        ContextCompat.startForegroundService(this, Intent(this, BlockerService::class.java))
        renderSoon()
    }

    private fun fieldMinutes(id: Int, fallback: Int): Int {
        val value = findViewById<EditText>(id).text.toString().toIntOrNull() ?: fallback
        return value.coerceIn(Prefs.MIN_MINUTES, Prefs.MAX_MINUTES)
    }

    private fun hasUsageAccess(): Boolean {
        val appOps = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun pickApp(includeHome: Boolean, onPicked: (String?, String?) -> Unit) {
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcherIntent, 0)
            .asSequence()
            .filter { it.activityInfo.packageName != packageName }
            .map { it.activityInfo.packageName to it.loadLabel(packageManager).toString() }
            .distinctBy { it.first }
            .sortedBy { it.second.lowercase() }
            .toList()

        val labels = buildList {
            if (includeHome) add(getString(R.string.home_screen))
            addAll(apps.map { it.second })
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.pick_app)
            .setItems(labels.toTypedArray()) { _, which ->
                if (includeHome && which == 0) {
                    onPicked(null, null)
                } else {
                    val app = apps[which - if (includeHome) 1 else 0]
                    onPicked(app.first, app.second)
                }
            }
            .show()
    }
}
