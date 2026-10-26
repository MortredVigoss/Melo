package com.melo.android.organizer

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import com.melo.android.data.newId
import net.fortuna.ical4j.data.CalendarBuilder
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.model.Period
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.Date as IcsDate
import net.fortuna.ical4j.model.component.VEvent
import net.fortuna.ical4j.model.property.DateProperty
import okhttp3.*
import java.io.StringReader
import java.time.*
import java.time.temporal.Temporal
import java.util.concurrent.TimeUnit

/** Normalized occurrences at the provider boundary; never write external calendars. */
interface CalendarProvider { fun read(source: CalendarSource, start: Long, end: Long): List<CalendarOccurrence> }
class SystemCalendarProvider(private val context: Context) : CalendarProvider {
    fun allowed() = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
    fun sources(): List<CalendarSource> {
        check(allowed()) { "请先允许读取系统日历。" }
        val rows = mutableListOf<CalendarSource>()
        context.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, arrayOf("_id", "calendar_displayName", "account_name", "calendar_color"), null, null, "calendar_displayName")?.use { c ->
            while (c.moveToNext()) rows += CalendarSource("system:" + c.getLong(0), "system", c.getString(1).orEmpty() + " · " + c.getString(2).orEmpty(), color = c.getLong(3), systemId = c.getLong(0))
        }
        return rows
    }
    override fun read(source: CalendarSource, start: Long, end: Long): List<CalendarOccurrence> {
        check(allowed()) { "系统日历权限已关闭。" }
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, start); ContentUris.appendId(it, end) }.build()
        val rows = mutableListOf<CalendarOccurrence>()
        context.contentResolver.query(uri, arrayOf("event_id", "title", "begin", "end", "allDay", "eventTimezone", "description", "eventLocation"), "calendar_id = ? AND eventStatus != ?", arrayOf(source.systemId.toString(), "2"), "begin ASC")?.use { c ->
            while (c.moveToNext()) {
                check(rows.size < 4000) { "日程超过窗口上限，请缩小订阅范围。" }
                val allDay = c.getInt(4) != 0
                // Provider all-day instances use UTC date boundaries, not device instants.
                fun boundary(ms: Long) = if (allDay) Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() else ms
                val begin = boundary(c.getLong(2)); val finish = boundary(c.getLong(3))
                val signature = listOf(c.getString(1), begin, finish, c.getString(6), c.getString(7)).hashCode()
                rows += CalendarOccurrence("${source.id}:${c.getLong(0)}:$begin", "${source.id}:${c.getLong(0)}", source.id, c.getString(1).orEmpty().ifBlank { "未命名日程" }, begin, finish, allDay, if (allDay) ZoneId.systemDefault().id else c.getString(5).orEmpty().ifBlank { ZoneId.systemDefault().id }, c.getString(6).orEmpty(), c.getString(7).orEmpty(), signature, c.getLong(0))
            }
        }
        return rows
    }
}

object EventOccurrences {
    fun local(event: CalendarEvent, start: Long, end: Long): List<CalendarOccurrence> {
        val zone = ZoneId.of(event.timeZone)
        val seed = Instant.ofEpochMilli(event.startAt).atZone(zone)
        val finishSeed = Instant.ofEpochMilli(event.endAt).atZone(zone)
        val duration = event.endAt - event.startAt
        val rows = mutableListOf<CalendarOccurrence>()
        var index = when (event.repeat) {
            "daily" -> java.time.temporal.ChronoUnit.DAYS.between(seed.toLocalDate(), Instant.ofEpochMilli(start - duration).atZone(zone).toLocalDate()).coerceAtLeast(0)
            "weekly" -> (java.time.temporal.ChronoUnit.DAYS.between(seed.toLocalDate(), Instant.ofEpochMilli(start - duration).atZone(zone).toLocalDate()) / 7).coerceAtLeast(0)
            "monthly" -> java.time.temporal.ChronoUnit.MONTHS.between(java.time.YearMonth.from(seed), java.time.YearMonth.from(Instant.ofEpochMilli(start - duration).atZone(zone))).coerceAtLeast(0)
            else -> 0
        }
        repeat(500) {
            val begin = when (event.repeat) { "daily" -> seed.plusDays(index); "weekly" -> seed.plusWeeks(index); "monthly" -> seed.plusMonths(index); else -> seed }
            val at = begin.toInstant().toEpochMilli()
            if (at >= end || event.repeatUntil?.let { at > it } == true) return rows
            val finish = if (event.allDay) begin.toLocalDate().plusDays(java.time.temporal.ChronoUnit.DAYS.between(seed.toLocalDate(), finishSeed.toLocalDate()).coerceAtLeast(1)).atStartOfDay(zone).toInstant().toEpochMilli() else at + duration
            if (finish > start) rows += CalendarOccurrence("${event.id}:$at", event.id, "melo", event.title, at, finish, event.allDay, event.timeZone, event.notes, event.location, event.revision)
            if (event.repeat == "none") return rows
            index++
        }
        error("重复日程窗口超过上限。")
    }
}

object IcsParser {
    init { System.setProperty("net.fortuna.ical4j.timezone.update.enabled", "false") }
    private fun property(event: VEvent, name: String): String = event.getProperty<Property>(name)?.value.orEmpty()
    private fun stamp(value: IcsDate, zone: ZoneId, allDay: Boolean, floating: Boolean): Long {
        if (allDay) return LocalDate.parse(value.toString().take(8), java.time.format.DateTimeFormatter.BASIC_ISO_DATE).atStartOfDay(zone).toInstant().toEpochMilli()
        if (floating) return java.time.LocalDateTime.parse(value.toString().take(15), java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss")).atZone(zone).toInstant().toEpochMilli()
        return value.time
    }
    fun parse(text: String, source: CalendarSource, start: Long, end: Long, zone: ZoneId = ZoneId.systemDefault()): List<CalendarOccurrence> {
        require(text.length <= 5 * 1024 * 1024) { "ICS 超过 5 MiB。" }
        val calendar = CalendarBuilder().build(StringReader(text))
        val components = calendar.getComponents<VEvent>("VEVENT")
        require(components.size <= 4000) { "ICS 日程数量超过上限。" }
        val groups = components.groupBy { property(it, "UID").also { uid -> require(uid.isNotBlank()) { "ICS 缺少 UID。" } } }
        val rows = mutableListOf<CalendarOccurrence>()
        for ((uid, versions) in groups) {
            val byRecurrence = versions.groupBy { property(it, "RECURRENCE-ID") }.mapValues { (_, candidates) -> candidates.maxWith(compareBy<VEvent> { property(it, "SEQUENCE").toIntOrNull() ?: 0 }.thenBy { property(it, "DTSTAMP") }) }
            val base = byRecurrence[""]
            if (base != null && property(base, "STATUS").equals("CANCELLED", true)) continue
            val overrides = byRecurrence.filterKeys { it.isNotBlank() }.values
            val replaced = overrides.mapNotNull { it.getProperty<DateProperty>("RECURRENCE-ID")?.date?.time }.toSet()
            for (event in listOfNotNull(base) + overrides) {
                if (property(event, "STATUS").equals("CANCELLED", true)) continue
                require(!property(event, "RRULE").contains(Regex("FREQ=(SECONDLY|MINUTELY|HOURLY)", RegexOption.IGNORE_CASE))) { "订阅含每小时或更密集的重复日程，未导入此来源。" }
                val date = event.startDate ?: error("ICS 缺少 DTSTART。")
                val allDay = date.date !is DateTime
                val floating = !allDay && date.timeZone == null && !date.isUtc
                val eventZone = date.timeZone?.id?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: zone
                val periods = event.calculateRecurrenceSet(Period(DateTime(start - 86400000), DateTime(end + 86400000)))
                for (period in periods) {
                    if (event === base && period.start.time in replaced) continue
                    val at = stamp(period.start, eventZone, allDay, floating)
                    val finish = stamp(period.end, eventZone, allDay, floating)
                    if (finish <= start || at >= end) continue
                    check(rows.size < 4000) { "ICS 展开超过 4000 项，未替换上次数据。" }
                    rows += CalendarOccurrence("${source.id}:$uid:$at", "${source.id}:$uid", source.id, property(event, "SUMMARY").ifBlank { "未命名日程" }, at, finish, allDay, eventZone.id, property(event, "DESCRIPTION"), property(event, "LOCATION"), event.toString().hashCode())
                }
            }
        }
        return rows.distinctBy { it.id }.sortedBy { it.startAt }
    }
}

class IcsHttp(private val debug: Boolean = false) {
    private val client = OkHttpClient.Builder().followRedirects(false).callTimeout(25, TimeUnit.SECONDS).dns { host ->
        Dns.SYSTEM.lookup(host).also { addresses -> require(debug && host in setOf("localhost", "127.0.0.1", "10.0.2.2") || addresses.none { it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress || it.isSiteLocalAddress || it.isMulticastAddress || it.address.size == 16 && (it.address[0].toInt() and 0xfe) == 0xfc }) { "订阅地址不能访问本机或私有网络。" } }
    }.build()
    data class Response(val text: String?, val etag: String?, val modified: String?)
    fun fetch(url: String, source: CalendarSource): Response {
        var target = normalizedUrl(url, debug)
        repeat(5) {
            val request = Request.Builder().url(target).header("Accept", "text/calendar").apply { source.etag?.let { header("If-None-Match", it) }; source.modified?.let { header("If-Modified-Since", it) } }.build()
            client.newCall(request).execute().use { response ->
                if (response.code == 304) return Response(null, source.etag, source.modified)
                if (response.code in 300..399) {
                    val location = response.header("Location") ?: error("ICS 重定向缺少地址。")
                    val next = response.request.url.resolve(location) ?: error("ICS 重定向地址无效。")
                    target = normalizedUrl(next.toString(), debug)
                } else {
                    check(response.isSuccessful) { "ICS 服务返回 HTTP ${response.code}。" }
                    val body = response.body ?: error("ICS 返回空内容。")
                    check(body.contentLength() <= 5 * 1024 * 1024) { "ICS 超过 5 MiB。" }
                    val bytes = body.byteStream().use { input -> java.io.ByteArrayOutputStream().also { output -> val buffer = ByteArray(8192); while (true) { val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count); check(output.size() <= 5 * 1024 * 1024) { "ICS 超过 5 MiB。" } } }.toByteArray() }
                    check(bytes.size <= 5 * 1024 * 1024) { "ICS 超过 5 MiB。" }
                    return Response(bytes.toString(Charsets.UTF_8), response.header("ETag"), response.header("Last-Modified"))
                }
            }
        }
        error("ICS 重定向次数过多。")
    }
    companion object {
        fun normalizedUrl(value: String, debug: Boolean = false): String {
            val text = if (value.startsWith("webcal://", true)) "https://" + value.substring(9) else value
            val uri = java.net.URI(text)
            require(uri.host != null && uri.userInfo == null && uri.fragment == null && text.length <= 4000 && (uri.scheme == "https" || debug && uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "10.0.2.2"))) { "请填写完整 HTTPS / webcal 订阅地址。" }
            return text
        }
    }
}
