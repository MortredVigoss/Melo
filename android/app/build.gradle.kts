import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.melo.android"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.melo.android"
        minSdk = 28
        targetSdk = 36
        versionCode = 14
        versionName = "0.6.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    testOptions { unitTests.isReturnDefaultValues = true }
    sourceSets.getByName("test").resources.srcDir("../../shared/protocol")
    sourceSets.getByName("androidTest").assets.srcDir("../../shared/agent/fixtures")
    packaging.resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
}

abstract class PrepareSharedAssets : DefaultTask() {
    @get:InputDirectory abstract val sceneInput: DirectoryProperty
    @get:InputFile abstract val schemaInput: RegularFileProperty
    @get:InputDirectory abstract val coreInput: DirectoryProperty
    @get:InputDirectory abstract val coreSources: DirectoryProperty
    @get:OutputDirectory abstract val outputDirectory: DirectoryProperty
    @TaskAction fun prepare() {
        val manifest = coreInput.file("manifest.json").get().asFile.readText()
        val entries = Regex("\"(shared/agent/[^\"]+)\"\\s*:\\s*\"([a-f0-9]{64})\"").findAll(manifest).toList()
        require(entries.isNotEmpty()) { "Missing Agent Core source manifest" }
        for (entry in entries) {
            val source = coreSources.file(entry.groupValues[1].removePrefix("shared/agent/")).get().asFile.canonicalFile
            require(source.toPath().startsWith(coreSources.get().asFile.canonicalFile.toPath())) { "Invalid Core source path" }
            val hash = MessageDigest.getInstance("SHA-256").digest(source.readBytes()).joinToString("") { "%02x".format(it) }
            require(hash == entry.groupValues[2]) { "Agent Core bundle is stale; run npm run build:agent-core" }
        }
        sceneInput.get().asFile.copyRecursively(outputDirectory.dir("scene").get().asFile, overwrite = true)
        val protocol = outputDirectory.dir("protocol").get().asFile.apply { mkdirs() }
        schemaInput.get().asFile.copyTo(protocol.resolve("sync.schema.json"), overwrite = true)
        coreInput.get().asFile.copyRecursively(outputDirectory.dir("agent-core").get().asFile, overwrite = true)
    }
}
val sharedAssets = tasks.register<PrepareSharedAssets>("prepareSharedAssets") {
    sceneInput.set(layout.projectDirectory.dir("../../ios/Melo/Scene"))
    schemaInput.set(layout.projectDirectory.file("../../shared/protocol/sync.schema.json"))
    coreInput.set(layout.projectDirectory.dir("../../shared/agent/dist"))
    coreSources.set(layout.projectDirectory.dir("../../shared/agent"))
    outputDirectory.set(layout.buildDirectory.dir("generated/shared-assets"))
}
androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(sharedAssets) { it.outputDirectory }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.javascriptengine:javascriptengine:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.11.0")
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
}
