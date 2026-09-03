package com.workcrew.appblocker

import android.app.AppOpsManager
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.Settings
import android.text.format.DateFormat
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * One-screen setup: grant the two special permissions, pick the watched app
 * (YouTube by default), the active hours, the reminder interval, the hard
 * limit, the lockout, and where to be sent when time is up, then start the
 * blocker service.
 *
 * While the service runs the settings are locked and Stop only takes effect
 * after the configured wait — that friction is the point of the app.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private var lastRunningState: Boolean? = null

    private val ticker = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        populateFields()

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
        findViewById<Button>(R.id.btn_time_start).setOnClickListener {
            pickTime(prefs.activeStartMinutes) { prefs.activeStartMinutes = it; render() }
        }
        findViewById<Button>(R.id.btn_time_end).setOnClickListener {
            pickTime(prefs.activeEndMinutes) { prefs.activeEndMinutes = it; render() }
        }
        findViewById<Button>(R.id.btn_start).setOnClickListener { startBlocker() }
        findViewById<Button>(R.id.btn_stop).setOnClickListener { onStopPressed() }

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
        // The Stop countdown ticks down on screen, so refresh once a second.
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }

    private fun populateFields() {
        findViewById<EditText>(R.id.edit_remind).setText(prefs.remindEveryMinutes.toString())
        findViewById<EditText>(R.id.edit_limit).setText(prefs.limitMinutes.toString())
        findViewById<EditText>(R.id.edit_lockout).setText(prefs.lockoutMinutes.toString())
        findViewById<EditText>(R.id.edit_stop_delay).setText(prefs.stopDelayMinutes.toString())
    }

    private fun render() {
        val running = BlockerService.isRunning
        if (lastRunningState != running) {
            lastRunningState = running
            // Show what is actually in force once the service takes over.
            if (running) populateFields()
            setInputsEnabled(!running)
        }

        findViewById<TextView>(R.id.txt_service_status).text = getString(
            if (running) R.string.status_running else R.string.status_stopped
        )
        findViewById<TextView>(R.id.txt_settings_hint).visibility =
            if (running) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.txt_usage_access).text = getString(
            if (hasUsageAccess()) R.string.granted else R.string.not_granted
        )
        findViewById<TextView>(R.id.txt_overlay).text = getString(
            if (Settings.canDrawOverlays(this)) R.string.granted else R.string.not_granted
        )
        findViewById<TextView>(R.id.txt_watched_app).text = prefs.watchedLabel
        findViewById<TextView>(R.id.txt_redirect_app).text =
            prefs.redirectLabel ?: getString(R.string.home_screen)
        findViewById<Button>(R.id.btn_time_start).text = Schedule.format(prefs.activeStartMinutes)
        findViewById<Button>(R.id.btn_time_end).text = Schedule.format(prefs.activeEndMinutes)
        findViewById<TextView>(R.id.txt_active_hours_note).text =
            if (prefs.activeStartMinutes == prefs.activeEndMinutes) {
                getString(R.string.active_hours_all_day)
            } else {
                getString(R.string.active_hours_note)
            }

        renderStopButton(running)
    }

    private fun renderStopButton(running: Boolean) {
        val stop = findViewById<Button>(R.id.btn_stop)
        stop.isEnabled = running
        val pendingAt = prefs.stopAllowedAtMs
        stop.text = when {
            !running -> getString(R.string.stop_blocking)
            pendingAt > 0L -> getString(
                R.string.stop_cancel, countdown(pendingAt - System.currentTimeMillis())
            )
            prefs.stopDelayMinutes > 0 -> getString(R.string.stop_after_wait, prefs.stopDelayMinutes)
            else -> getString(R.string.stop_blocking)
        }
    }

    private fun setInputsEnabled(enabled: Boolean) {
        listOf(
            R.id.edit_remind, R.id.edit_limit, R.id.edit_lockout, R.id.edit_stop_delay,
            R.id.btn_watched_app, R.id.btn_redirect_app, R.id.btn_time_start, R.id.btn_time_end,
            R.id.btn_start,
        ).forEach { findViewById<View>(it).isEnabled = enabled }
    }

    private fun startBlocker() {
        prefs.remindEveryMinutes = fieldMinutes(R.id.edit_remind, prefs.remindEveryMinutes)
        prefs.limitMinutes = fieldMinutes(R.id.edit_limit, prefs.limitMinutes)
        prefs.lockoutMinutes = fieldMinutes(R.id.edit_lockout, prefs.lockoutMinutes)
        prefs.stopDelayMinutes =
            fieldMinutes(R.id.edit_stop_delay, prefs.stopDelayMinutes, minimum = 0)
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

    private fun onStopPressed() {
        if (!BlockerService.isRunning) return
        if (prefs.stopAllowedAtMs > 0L) {
            // Second press while a stop is pending calls it off.
            prefs.stopAllowedAtMs = 0L
            Toast.makeText(this, R.string.stop_cancelled, Toast.LENGTH_SHORT).show()
            render()
            return
        }
        val waitMinutes = prefs.stopDelayMinutes
        if (waitMinutes <= 0) {
            stopService(Intent(this, BlockerService::class.java))
            renderSoon()
            return
        }
        // The service, not this screen, performs the stop when the wait is up,
        // so closing the app doesn't shortcut it.
        prefs.stopAllowedAtMs = System.currentTimeMillis() + waitMinutes * 60_000L
        Toast.makeText(this, getString(R.string.stop_scheduled, waitMinutes), Toast.LENGTH_LONG)
            .show()
        render()
    }

    // The service flips isRunning asynchronously; re-render after it settles.
    private fun renderSoon() {
        render()
        window.decorView.postDelayed({ if (!isDestroyed) render() }, 500)
    }

    private fun fieldMinutes(id: Int, fallback: Int, minimum: Int = Prefs.MIN_MINUTES): Int {
        val value = findViewById<EditText>(id).text.toString().toIntOrNull() ?: fallback
        return value.coerceIn(minimum, Prefs.MAX_MINUTES)
    }

    private fun countdown(remainingMs: Long): String {
        val totalSeconds = (remainingMs.coerceAtLeast(0L) + 999L) / 1000L
        return String.format(Locale.US, "%d:%02d", totalSeconds / 60, totalSeconds % 60)
    }

    private fun pickTime(currentMinutes: Int, onPicked: (Int) -> Unit) {
        TimePickerDialog(
            this,
            { _, hour, minute -> onPicked(hour * 60 + minute) },
            currentMinutes / 60,
            currentMinutes % 60,
            DateFormat.is24HourFormat(this),
        ).show()
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
