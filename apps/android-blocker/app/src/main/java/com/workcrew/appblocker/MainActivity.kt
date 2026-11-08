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
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.text.format.DateFormat
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * One-screen setup: grant the special permissions, then build a list of
 * limited apps. Each app gets its own editor — hours, allowance, reminder
 * cadence, lockout, where to be sent, and how long Stop has to wait — so
 * YouTube and Instagram can be governed completely differently.
 *
 * While the service runs the list is locked and Stop only takes effect after
 * the longest of the apps' cancel waits — that friction is the point of the
 * app.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private var lastRunningState: Boolean? = null

    /** What the app list was last built from, so the once-a-second re-render can skip it. */
    private var renderedRules: Pair<List<AppLimit>, Boolean>? = null

    private val ticker = object : Runnable {
        override fun run() {
            // With the screen open, the countdown reaching zero should start
            // blocking there and then rather than waiting for the alarm. Only
            // once it is actually due: every other tick would just re-arm the
            // alarm a second later than it already is.
            val resumeAt = prefs.resumeAtMs
            if (!BlockerService.isRunning && resumeAt > 0L &&
                AutoResume.remainingMs(resumeAt, System.currentTimeMillis()) <= 0L
            ) {
                BlockerLauncher.ensureRunning(this@MainActivity)
            }
            render()
            handler.postDelayed(this, 1_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        findViewById<EditText>(R.id.edit_auto_resume)
            .setText(prefs.autoResumeMinutes.toString())

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
        findViewById<Button>(R.id.btn_battery).setOnClickListener { requestBatteryExemption() }
        findViewById<Button>(R.id.btn_add_app).setOnClickListener { addApp() }
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
        // If something killed the service while the blocker was meant to be on,
        // opening the app puts it back — no tapping Start again.
        BlockerLauncher.ensureRunning(this)
        // The Stop countdown ticks down on screen, so refresh once a second.
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }

    private fun render() {
        val running = BlockerService.isRunning
        val limits = prefs.limits
        if (lastRunningState != running) {
            lastRunningState = running
            setInputsEnabled(!running)
        }

        val resumeInMs = AutoResume.remainingMs(prefs.resumeAtMs, System.currentTimeMillis())
        findViewById<TextView>(R.id.txt_service_status).text = when {
            running -> getString(R.string.status_running)
            resumeInMs > 0L -> getString(R.string.status_stopped_resuming, countdown(resumeInMs))
            else -> getString(R.string.status_stopped)
        }
        findViewById<TextView>(R.id.txt_auto_resume_note).text = when {
            resumeInMs > 0L -> getString(R.string.auto_resume_pending, countdown(resumeInMs))
            prefs.autoResumeMinutes > AutoResume.OFF -> getString(R.string.auto_resume_note)
            else -> getString(R.string.auto_resume_note_off)
        }
        findViewById<TextView>(R.id.txt_settings_hint).visibility =
            if (running) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.txt_usage_access).text = getString(
            if (hasUsageAccess()) R.string.granted else R.string.not_granted
        )
        findViewById<TextView>(R.id.txt_overlay).text = getString(
            if (Settings.canDrawOverlays(this)) R.string.granted else R.string.not_granted
        )
        findViewById<TextView>(R.id.txt_battery).text = getString(
            if (ignoringBatteryOptimizations()) R.string.battery_unrestricted
            else R.string.battery_restricted
        )

        renderRules(limits, running)
        renderStopSection(limits, running)
    }

    /**
     * Rebuilds the list of limited apps. Only when something about it actually
     * changed: the Stop countdown re-renders every second, and throwing the
     * rows away that often would fight whatever the user is tapping.
     */
    private fun renderRules(limits: List<AppLimit>, running: Boolean) {
        if (renderedRules == limits to running) return
        renderedRules = limits to running
        val container = findViewById<LinearLayout>(R.id.rules_container)
        container.removeAllViews()
        findViewById<TextView>(R.id.txt_no_rules).visibility =
            if (limits.isEmpty()) View.VISIBLE else View.GONE

        limits.forEach { limit ->
            val row = layoutInflater.inflate(R.layout.item_rule, container, false)
            row.findViewById<TextView>(R.id.txt_rule_label).text = limit.label
            row.findViewById<TextView>(R.id.txt_rule_summary).text = summaryOf(limit)
            row.findViewById<Button>(R.id.btn_rule_edit).apply {
                isEnabled = !running
                setOnClickListener { editRule(limit) }
            }
            row.findViewById<Button>(R.id.btn_rule_remove).apply {
                isEnabled = !running
                setOnClickListener { confirmRemove(limit) }
            }
            container.addView(row)
        }
    }

    private fun summaryOf(limit: AppLimit): String = getString(
        R.string.rule_summary,
        limit.limitMinutes,
        if (limit.allDay) {
            getString(R.string.rule_window_all_day)
        } else {
            getString(
                R.string.rule_window_range,
                Schedule.format(limit.activeStartMinutes),
                Schedule.format(limit.activeEndMinutes),
            )
        },
        limit.remindEveryMinutes,
        limit.lockoutMinutes,
        limit.redirectLabel ?: getString(R.string.home_screen),
        limit.cancelWaitMinutes,
    )

    private fun renderStopSection(limits: List<AppLimit>, running: Boolean) {
        val wait = cancelWaitMinutes(limits)
        findViewById<TextView>(R.id.txt_stop_note).text =
            if (wait > 0) getString(R.string.stop_note_wait, wait)
            else getString(R.string.stop_note_immediate)

        findViewById<Button>(R.id.btn_start).text = getString(
            if (!running && prefs.resumeAtMs > 0L) R.string.start_now
            else R.string.start_blocking
        )

        val stop = findViewById<Button>(R.id.btn_stop)
        stop.isEnabled = running
        val pendingAt = prefs.stopAllowedAtMs
        stop.text = when {
            !running -> getString(R.string.stop_blocking)
            pendingAt > 0L -> getString(
                R.string.stop_cancel, countdown(pendingAt - System.currentTimeMillis())
            )
            wait > 0 -> getString(R.string.stop_after_wait, wait)
            else -> getString(R.string.stop_blocking)
        }
    }

    /**
     * Stopping the blocker stops every limit at once, so it has to wait out the
     * strictest app — otherwise a lenient app's short wait would be a back door
     * to cancelling a strict one early.
     */
    private fun cancelWaitMinutes(limits: List<AppLimit>): Int =
        limits.maxOfOrNull { it.cancelWaitMinutes } ?: 0

    private fun setInputsEnabled(enabled: Boolean) {
        listOf(R.id.btn_add_app, R.id.btn_start, R.id.edit_auto_resume).forEach {
            findViewById<View>(it).isEnabled = enabled
        }
    }

    private fun addApp() {
        pickApp(includeHome = false) { pkg, label ->
            if (pkg == null || label == null) return@pickApp
            val existing = prefs.limitFor(pkg)
            if (existing != null) {
                Toast.makeText(
                    this, getString(R.string.already_limited, existing.label), Toast.LENGTH_LONG
                ).show()
                editRule(existing)
                return@pickApp
            }
            editRule(AppLimit.of(packageName = pkg, label = label))
        }
    }

    /**
     * The per-app editor. Edits are collected into [draft] and only written on
     * Save, so backing out of the dialog leaves the stored rules untouched.
     */
    private fun editRule(limit: AppLimit) {
        var draft = limit
        val view = layoutInflater.inflate(R.layout.dialog_rule, null)
        val limitField = view.findViewById<EditText>(R.id.edit_rule_limit)
        val remindField = view.findViewById<EditText>(R.id.edit_rule_remind)
        val lockoutField = view.findViewById<EditText>(R.id.edit_rule_lockout)
        val cancelField = view.findViewById<EditText>(R.id.edit_rule_cancel_wait)
        val startButton = view.findViewById<Button>(R.id.btn_rule_start)
        val endButton = view.findViewById<Button>(R.id.btn_rule_end)
        val redirectButton = view.findViewById<Button>(R.id.btn_rule_redirect)

        limitField.setText(draft.limitMinutes.toString())
        remindField.setText(draft.remindEveryMinutes.toString())
        lockoutField.setText(draft.lockoutMinutes.toString())
        cancelField.setText(draft.cancelWaitMinutes.toString())

        // The hour and redirect pickers are dialogs of their own, so the parts
        // of this one they change are redrawn when they come back.
        fun refresh() {
            startButton.text = Schedule.format(draft.activeStartMinutes)
            endButton.text = Schedule.format(draft.activeEndMinutes)
            view.findViewById<TextView>(R.id.txt_rule_redirect).text =
                draft.redirectLabel ?: getString(R.string.home_screen)
            view.findViewById<TextView>(R.id.txt_rule_window_note).text = getString(
                if (draft.allDay) R.string.active_hours_all_day else R.string.active_hours_note
            )
        }
        refresh()

        startButton.setOnClickListener {
            pickTime(draft.activeStartMinutes) {
                draft = draft.copy(activeStartMinutes = it)
                refresh()
            }
        }
        endButton.setOnClickListener {
            pickTime(draft.activeEndMinutes) {
                draft = draft.copy(activeEndMinutes = it)
                refresh()
            }
        }
        redirectButton.setOnClickListener {
            pickApp(includeHome = true) { pkg, label ->
                draft = draft.copy(redirectPackage = pkg, redirectLabel = label)
                refresh()
            }
        }

        AlertDialog.Builder(this)
            .setTitle(draft.label)
            .setView(view)
            .setPositiveButton(R.string.save) { _, _ ->
                // AppLimit.of is what clamps the typed values, so a blank or
                // silly entry can never become a zero-length timer.
                saveRule(
                    AppLimit.of(
                        packageName = draft.packageName,
                        label = draft.label,
                        remindEveryMinutes = minutesIn(remindField, draft.remindEveryMinutes),
                        limitMinutes = minutesIn(limitField, draft.limitMinutes),
                        lockoutMinutes = minutesIn(lockoutField, draft.lockoutMinutes),
                        activeStartMinutes = draft.activeStartMinutes,
                        activeEndMinutes = draft.activeEndMinutes,
                        redirectPackage = draft.redirectPackage,
                        redirectLabel = draft.redirectLabel,
                        cancelWaitMinutes = minutesIn(
                            cancelField, draft.cancelWaitMinutes, minimum = 0
                        ),
                    )
                )
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun saveRule(limit: AppLimit) {
        val existing = prefs.limits
        val index = existing.indexOfFirst { it.packageName == limit.packageName }
        prefs.limits = if (index >= 0) {
            existing.toMutableList().also { it[index] = limit }
        } else {
            existing + limit
        }
        render()
    }

    private fun confirmRemove(limit: AppLimit) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.remove_rule_title, limit.label))
            .setMessage(R.string.remove_rule_message)
            .setPositiveButton(R.string.remove) { _, _ ->
                // Clearing the rules also drops this app's saved progress.
                prefs.limits = prefs.limits.filterNot { it.packageName == limit.packageName }
                render()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun startBlocker() {
        prefs.autoResumeMinutes = minutesIn(
            findViewById(R.id.edit_auto_resume), prefs.autoResumeMinutes, minimum = AutoResume.OFF
        )
        if (prefs.limits.isEmpty()) {
            Toast.makeText(this, R.string.need_a_rule, Toast.LENGTH_LONG).show()
            return
        }
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
        val waitMinutes = cancelWaitMinutes(prefs.limits)
        if (waitMinutes <= 0) {
            // Clears the intent to block first, or the watchdog restarts it,
            // and arms the automatic return if one is set.
            BlockerLauncher.recordStop(this, System.currentTimeMillis())
            stopService(Intent(this, BlockerService::class.java))
            announceResume()
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

    /** Confirms a return that is now counting down, so a stop is never silent. */
    private fun announceResume() {
        val remaining = AutoResume.remainingMs(prefs.resumeAtMs, System.currentTimeMillis())
        if (remaining <= 0L) return
        Toast.makeText(
            this,
            getString(R.string.auto_resume_pending, countdown(remaining)),
            Toast.LENGTH_LONG,
        ).show()
    }

    // The service flips isRunning asynchronously; re-render after it settles.
    private fun renderSoon() {
        render()
        window.decorView.postDelayed({ if (!isDestroyed) render() }, 500)
    }

    private fun minutesIn(field: EditText, fallback: Int, minimum: Int = AppLimit.MIN_MINUTES): Int {
        val value = field.text.toString().toIntOrNull() ?: fallback
        return value.coerceIn(minimum, AppLimit.MAX_MINUTES)
    }

    /** m:ss, or h:mm:ss once there is an hour or more left to read. */
    private fun countdown(remainingMs: Long): String {
        val totalSeconds = (remainingMs.coerceAtLeast(0L) + 999L) / 1000L
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
        else String.format(Locale.US, "%d:%02d", minutes, seconds)
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

    private fun ignoringBatteryOptimizations(): Boolean {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        return power.isIgnoringBatteryOptimizations(packageName)
    }

    /**
     * Battery optimisation is what lets a phone sleep the app overnight and
     * leave the blocker off the next morning, so offer the one-tap exemption
     * and fall back to the settings list if the dialog isn't available.
     */
    private fun requestBatteryExemption() {
        val direct = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName"),
        )
        try {
            startActivity(direct)
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (e2: Exception) {
                Toast.makeText(this, R.string.battery_settings_missing, Toast.LENGTH_LONG).show()
            }
        }
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
