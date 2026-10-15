package com.melo.android

import com.melo.android.data.text
import com.melo.android.device.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AppCatalogTest {
    private val manyApps = (1..265).map { LaunchableApp("fixture.app$it", "Fixture ${it.toString().padStart(3, '0')}") }
    private fun rows(page: JsonObject) = page["apps"]!!.jsonArray.map { it.jsonObject }

    @Test fun all265AppsCanBeTraversedWithoutDuplicatesOrSilentTruncation() {
        val catalog = AppCatalog(manyApps)
        val found = mutableListOf<String>()
        var offset = 0
        do {
            val page = catalog.page(offset = offset)
            assertEquals(265, page["total_apps"]!!.jsonPrimitive.int)
            assertEquals(265, page["matched_apps"]!!.jsonPrimitive.int)
            found += rows(page).map { it.text("package_name") }
            val next = page["next_offset"]?.jsonPrimitive?.intOrNull
            if (next == null) { assertFalse(page["has_more"]!!.jsonPrimitive.boolean); break }
            assertTrue(next > offset); offset = next
        } while (true)
        assertEquals(manyApps.map { it.packageName }.toSet(), found.toSet())
        assertEquals(265, found.size)
        assertTrue(rows(catalog.page(offset = 1000)).isEmpty())
    }
    @Test fun searchFindsAppBeyondFirstPageWithoutReadingEarlierPages() {
        val catalog = AppCatalog(manyApps + LaunchableApp("fixture.hearthstone", "炉石传说"))
        assertFalse(rows(catalog.page()).any { it.text("name") == "炉石传说" })
        for (query in listOf("炉石", "hearthstone")) {
            val page = catalog.page(query)
            assertEquals(266, page["total_apps"]!!.jsonPrimitive.int)
            assertEquals("fixture.hearthstone", rows(page).single().text("package_name"))
        }
    }
    @Test fun spellingAndChineseTyposReturnSuggestionsButNeverExactLaunchTargets() {
        val catalog = AppCatalog(listOf(LaunchableApp("fixture.en", "Hearthstone"), LaunchableApp("fixture.cn", "炉石传说")))
        for ((query, pkg) in listOf("Hearhtstone" to "fixture.en", "炉食传说" to "fixture.cn")) {
            val page = catalog.page(query)
            assertEquals(pkg, rows(page).single().text("package_name"))
            assertEquals("similar_name", rows(page).single().text("match"))
            assertTrue(catalog.exactName(query).isEmpty())
        }
        val error = catalog.openFailure("", "炉食传说", false)
        assertFalse(error.ok); assertEquals("app_not_found", error.data.text("code"))
        assertEquals("fixture.cn", rows(error.data).single().text("package_name"))
    }
    @Test fun normalizedLabelsAliasesAndDuplicateLauncherActivitiesAreHandled() {
        val catalog = AppCatalog(listOf(
            LaunchableApp("fixture.same", "ＨＥＡＲＴＨ Stone", listOf("炉石传说")),
            LaunchableApp("fixture.same", "Hearthstone shortcut"),
            LaunchableApp("fixture.second", "炉石传说")
        ))
        assertEquals("fixture.same", catalog.exactName("hearth-stone").single().packageName)
        assertEquals(2, catalog.exactName("炉石传说").size)
        assertEquals("fixture.same", catalog.exactName("Hearthstone shortcut").single().packageName)
        assertEquals(2, rows(catalog.page()).size)
        assertEquals("app_ambiguous", catalog.openFailure("", "炉石传说", true).data.text("code"))
    }
    @Test fun noMatchReportsItsLimitedProfileScopeAndZeroResults() {
        val page = AppCatalog(manyApps).page("UnknownGame")
        assertEquals(0, page["matched_apps"]!!.jsonPrimitive.int)
        assertTrue(rows(page).isEmpty()); assertFalse(page["has_more"]!!.jsonPrimitive.boolean)
        assertTrue(page.text("search_scope").contains("current Android profile"))
        assertTrue(page.text("scope_note").contains("does not prove"))
    }
    @Test fun invalidOrUnboundedQueriesAndPagesAreRejected() {
        val catalog = AppCatalog(manyApps)
        for (limit in listOf(-1, 0, 201, Int.MAX_VALUE)) assertTrue(runCatching { catalog.page(limit = limit) }.isFailure)
        assertTrue(runCatching { catalog.page(offset = -1) }.isFailure)
        assertTrue(runCatching { catalog.page(query = "x".repeat(161)) }.isFailure)
        assertTrue(runCatching { catalog.page(query = "***") }.isFailure)
    }
}
