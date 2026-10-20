package com.melo.android.ui

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val MeloGold = Color(0xFFD1B27D)
val MeloBackground = Color(0xFF07090D)
val MeloSurface = Color(0xFF15171C)
val MeloText = Color(0xFFEDE8DF)
val MeloMuted = Color(0xFFB9B0A2)

@Composable fun MeloTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = MeloGold, onPrimary = MeloBackground,
        secondary = Color(0xFF91B3BB), background = MeloBackground, onBackground = MeloText,
        surface = MeloSurface, onSurface = MeloText, surfaceVariant = Color(0xFF24252B),
        onSurfaceVariant = MeloMuted, secondaryContainer = Color(0xFF332B20), onSecondaryContainer = MeloGold,
        outline = Color(0xFF5A5042), error = Color(0xFFEDADB3)), content = content)
}
