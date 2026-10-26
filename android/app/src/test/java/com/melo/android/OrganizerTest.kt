package com.melo.android

import com.melo.android.organizer.*
import org.junit.Test
import org.junit.Assert.*
import java.time.*

class OrganizerTest {
    private val source = CalendarSource("fixture", "ics", "Fixture")
    private val zone = ZoneId.of("Australia/Sydney")
    private fun time(text: String) = Instant.parse(text).toEpochMilli()
    private fun calendar(body: String) = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Melo Fixture//EN\r\n" + body.trimIndent().replace("\n", "\r\n") + "\r\nEND:VCALENDAR\r\n"

    @Test fun icsDailyRecurrenceExclusionAndOverrideAreApplied() {
        val text = calendar("""
            BEGIN:VEVENT
            UID:repeat-fixture
            DTSTART;TZID=Australia/Sydney:20261026T090000
            DTEND;TZID=Australia/Sydney:20261026T100000
            RRULE:FREQ=DAILY;COUNT=4
            EXDATE;TZID=Australia/Sydney:20261027T090000
            SUMMARY:Base
            END:VEVENT
            BEGIN:VEVENT
            UID:repeat-fixture
            RECURRENCE-ID;TZID=Australia/Sydney:20261028T090000
            DTSTART;TZID=Australia/Sydney:20261028T110000
            DTEND;TZID=Australia/Sydney:20261028T120000
            SUMMARY:Moved
            END:VEVENT
        """)
        val rows = IcsParser.parse(text, source, time("2026-10-25T00:00:00Z"), time("2026-10-31T00:00:00Z"), zone)
        assertEquals(3, rows.size); assertEquals(1, rows.count { it.title == "Moved" })
        assertEquals(11, Instant.ofEpochMilli(rows.first { it.title == "Moved" }.startAt).atZone(zone).hour)
        assertFalse(rows.any { Instant.ofEpochMilli(it.startAt).atZone(zone).dayOfMonth == 27 })
    }
    @Test fun icsCancelledOccurrenceDoesNotLeaveOriginalSlot() {
        val rows = IcsParser.parse(calendar("""
            BEGIN:VEVENT
            UID:cancel-fixture
            DTSTART:20261026T090000Z
            DTEND:20261026T100000Z
            RRULE:FREQ=DAILY;COUNT=2
            SUMMARY:Base
            END:VEVENT
            BEGIN:VEVENT
            UID:cancel-fixture
            RECURRENCE-ID:20261027T090000Z
            STATUS:CANCELLED
            END:VEVENT
        """), source, time("2026-10-25T00:00:00Z"), time("2026-10-30T00:00:00Z"), zone)
        assertEquals(1, rows.size)
    }
    @Test fun allDayUsesLocalDateAndExclusiveEndAcrossDst() {
        val rows = IcsParser.parse(calendar("""
            BEGIN:VEVENT
            UID:all-day
            DTSTART;VALUE=DATE:20261004
            DTEND;VALUE=DATE:20261005
            SUMMARY:All day
            END:VEVENT
        """), source, time("2026-10-03T00:00:00Z"), time("2026-10-06T00:00:00Z"), zone)
        assertEquals(1, rows.size); assertTrue(rows[0].allDay)
        assertEquals(LocalDate.of(2026,10,4), Instant.ofEpochMilli(rows[0].startAt).atZone(zone).toLocalDate())
        assertEquals(23 * 3600000L, rows[0].endAt - rows[0].startAt)
    }
    @Test fun malformedAndTooFrequentIcsAreNotSilentlyAccepted() {
        for (body in listOf("bad ics", calendar("""
            BEGIN:VEVENT
            UID:dense
            DTSTART:20000101T000000Z
            RRULE:FREQ=SECONDLY
            SUMMARY:Dense
            END:VEVENT
        """))) assertTrue(runCatching { IcsParser.parse(body, source, 0, time("2026-11-01T00:00:00Z"), zone) }.isFailure)
    }
    @Test fun localMonthlyRecurrenceAnchorsToOriginalDayAfterFebruary() {
        val start = LocalDate.of(2027,1,31).atTime(9,0).atZone(zone).toInstant().toEpochMilli()
        val rows = EventOccurrences.local(CalendarEvent("m", "Monthly", startAt=start, endAt=start+3600000, timeZone=zone.id, repeat="monthly"), start, time("2027-04-01T00:00:00Z"))
        assertEquals(listOf(31,28,31), rows.map { Instant.ofEpochMilli(it.startAt).atZone(zone).dayOfMonth })
    }
    @Test fun allDayLocalRepeatsKeepDateBoundaries() {
        val start=LocalDate.of(2026,10,3).atStartOfDay(zone).toInstant().toEpochMilli()
        val end=LocalDate.of(2026,10,4).atStartOfDay(zone).toInstant().toEpochMilli()
        val rows=EventOccurrences.local(CalendarEvent("m", "Daily", startAt=start, endAt=end, timeZone=zone.id, allDay=true, repeat="daily"),start,time("2026-10-06T00:00:00Z"))
        assertEquals(23*3600000L,rows[1].endAt-rows[1].startAt)
    }
    @Test fun plannerCancelsCompletedTasksAndPreservesStableOccurrenceKeys() {
        val now=time("2026-10-26T00:00:00Z")
        val todo=TodoItem("task","Test",remindAt=now+60000,revision=2)
        val first=ReminderEngine.desired(OrganizerData(core=OrganizerCore(todos=listOf(todo))),now).single()
        assertEquals("todo:task",first.key); assertEquals(2,first.revision)
        assertTrue(ReminderEngine.desired(OrganizerData(core=OrganizerCore(todos=listOf(todo.copy(completed=true)))),now).isEmpty())
    }
    @Test fun externalRemindersAreOptInAndDisablingSourceCancelsThem() {
        val now=time("2026-10-26T00:00:00Z")
        val event=CalendarOccurrence("row","event","fixture","External",now+1200000,now+4800000)
        val data=OrganizerData(sources=listOf(source),external=listOf(event))
        assertTrue(ReminderEngine.desired(data,now).isEmpty())
        val enabled=data.copy(sources=listOf(source.copy(reminders=true)))
        assertEquals(now+600000,ReminderEngine.desired(enabled,now).single().fireAt)
        assertTrue(ReminderEngine.desired(enabled.copy(sources=listOf(source.copy(reminders=true,enabled=false))),now).isEmpty())
    }
    @Test fun conditionalIcsRefreshPreservesEtagAndDistinguishesNotModified() {
        okhttp3.mockwebserver.MockWebServer().use { server ->
            server.start(); server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("BEGIN:VCALENDAR\r\nEND:VCALENDAR").setHeader("ETag", "fixture-v1"))
            val first = IcsHttp(true).fetch(server.url("/fixture.ics").toString(), source)
            assertEquals("fixture-v1", first.etag); assertTrue(first.text!!.startsWith("BEGIN:VCALENDAR"))
            server.takeRequest()
            server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(304))
            val cached = IcsHttp(true).fetch(server.url("/fixture.ics").toString(), source.copy(etag = first.etag))
            assertNull(cached.text); assertEquals("fixture-v1", server.takeRequest().getHeader("If-None-Match"))
        }
    }
    @Test fun declaredOversizeIcsResponseIsRejectedBeforeParsing() {
        okhttp3.mockwebserver.MockWebServer().use { server ->
            server.start(); server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("too large").setHeader("Content-Length", "5242881"))
            assertTrue(runCatching { IcsHttp(true).fetch(server.url("/large.ics").toString(), source) }.isFailure)
        }
    }
    @Test fun subscriptionUrlsRejectAuthorityCredentialsAndUnsafeSchemes() {
        assertEquals("https://example.com/token.ics",IcsHttp.normalizedUrl("webcal://example.com/token.ics"))
        for (url in listOf("http://example.com/a", "file:///a", "https://fixture:placeholder@example.com/a", "https://example.com/a#fragment")) assertTrue(runCatching { IcsHttp.normalizedUrl(url) }.isFailure)
    }
}
