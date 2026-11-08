package com.workcrew.appblocker

/**
 * Turns the list of per-app rules into one string for SharedPreferences and
 * back. Hand-rolled rather than JSON so it stays plain Kotlin and can be unit
 * tested on the JVM without the Android framework's `org.json` stubs.
 *
 * One record per line, fields separated by tabs. Decoding is deliberately
 * forgiving — a record read back from storage is never trusted:
 *
 *  - missing trailing fields fall back to defaults, so rules written by an
 *    older version keep working when a field is added here;
 *  - extra fields are ignored, so rules written by a newer version degrade
 *    instead of disappearing;
 *  - an unparseable number falls back to its default, and every number is
 *    clamped by [AppLimit.of];
 *  - a record with no package name, or a second record for a package already
 *    seen, is dropped — two sets of rules for one app would race.
 */
object LimitCodec {

    fun encode(limits: List<AppLimit>): String = limits.joinToString(RECORD_SEPARATOR) { limit ->
        listOf(
            limit.packageName,
            limit.label,
            limit.remindEveryMinutes.toString(),
            limit.limitMinutes.toString(),
            limit.lockoutMinutes.toString(),
            limit.activeStartMinutes.toString(),
            limit.activeEndMinutes.toString(),
            limit.redirectPackage.orEmpty(),
            limit.redirectLabel.orEmpty(),
            limit.cancelWaitMinutes.toString(),
        ).joinToString(FIELD_SEPARATOR) { escape(it) }
    }

    fun decode(stored: String?): List<AppLimit> {
        if (stored.isNullOrEmpty()) return emptyList()
        val decoded = mutableListOf<AppLimit>()
        val seen = mutableSetOf<String>()
        for (record in stored.split(RECORD_SEPARATOR)) {
            if (record.isBlank()) continue
            val fields = record.split(FIELD_SEPARATOR).map { unescape(it) }
            val packageName = fields.getOrNull(0)?.takeIf { it.isNotBlank() } ?: continue
            if (!seen.add(packageName)) continue
            decoded += AppLimit.of(
                packageName = packageName,
                label = fields.text(1) ?: packageName,
                remindEveryMinutes = fields.number(2, AppLimit.DEFAULT_REMIND_MINUTES),
                limitMinutes = fields.number(3, AppLimit.DEFAULT_LIMIT_MINUTES),
                lockoutMinutes = fields.number(4, AppLimit.DEFAULT_LOCKOUT_MINUTES),
                activeStartMinutes = fields.number(5, AppLimit.DEFAULT_ACTIVE_START_MINUTES),
                activeEndMinutes = fields.number(6, AppLimit.DEFAULT_ACTIVE_END_MINUTES),
                redirectPackage = fields.text(7),
                redirectLabel = fields.text(8),
                cancelWaitMinutes = fields.number(9, AppLimit.DEFAULT_CANCEL_WAIT_MINUTES),
            )
        }
        return decoded
    }

    private fun List<String>.text(index: Int): String? =
        getOrNull(index)?.takeIf { it.isNotBlank() }

    private fun List<String>.number(index: Int, fallback: Int): Int =
        getOrNull(index)?.trim()?.toIntOrNull() ?: fallback

    // App labels come from the package manager and can hold anything, including
    // the separators, so they are escaped rather than assumed to be safe.
    private fun escape(value: String): String = value
        .replace("\\", "\\\\")
        .replace(FIELD_SEPARATOR, "\\t")
        .replace(RECORD_SEPARATOR, "\\n")

    private fun unescape(value: String): String {
        if (!value.contains('\\')) return value
        val out = StringBuilder(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c != '\\' || i == value.length - 1) {
                out.append(c)
                i++
                continue
            }
            when (val next = value[i + 1]) {
                't' -> out.append('\t')
                'n' -> out.append('\n')
                '\\' -> out.append('\\')
                // Not an escape we wrote; keep both characters verbatim.
                else -> out.append(c).append(next)
            }
            i += 2
        }
        return out.toString()
    }

    private const val RECORD_SEPARATOR = "\n"
    private const val FIELD_SEPARATOR = "\t"
}
