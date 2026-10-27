import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.util.zip.ZipInputStream

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
        versionCode = 26
        versionName = "0.10.2"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
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
    @get:InputFile abstract val replyDocumentSource: RegularFileProperty
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
        val replyHash = MessageDigest.getInstance("SHA-256").digest(replyDocumentSource.get().asFile.readBytes()).joinToString("") { "%02x".format(it) }
        require(manifest.contains("\"src/shared/replyDocument.js\": \"$replyHash\"")) { "Shared reply parser bundle is stale; run npm run build:agent-core" }
        sceneInput.get().asFile.copyRecursively(outputDirectory.dir("scene").get().asFile, overwrite = true)
        val protocol = outputDirectory.dir("protocol").get().asFile.apply { mkdirs() }
        schemaInput.get().asFile.copyTo(protocol.resolve("sync.schema.json"), overwrite = true)
        coreInput.get().asFile.copyRecursively(outputDirectory.dir("agent-core").get().asFile, overwrite = true)
    }
}
/**
 * Desktop-pet media (VP9+alpha WebM skins) never enters Git. The committed
 * catalog.json lists every file with its SHA-256 and the GitHub Release bundle
 * that carries them; this task verifies the ignored skins directory and fetches
 * the bundle when files are missing or stale, so CI and fresh clones build the
 * same APK as the machine that ran android/scripts/import-pet-skins.mjs.
 */
abstract class PreparePetAssets : DefaultTask() {
    @get:InputFile abstract val catalog: RegularFileProperty
    @get:Internal abstract val assetsDirectory: DirectoryProperty
    @get:Internal abstract val downloadDirectory: DirectoryProperty
    @get:OutputFile abstract val stamp: RegularFileProperty
    @TaskAction fun prepare() {
        val root = assetsDirectory.get().asFile
        @Suppress("UNCHECKED_CAST") val parsed = groovy.json.JsonSlurper().parse(catalog.get().asFile) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST") val skins = parsed["skins"] as Map<String, Map<String, Any?>>
        val files = skins.values.flatMap { skin -> @Suppress("UNCHECKED_CAST") (skin["clips"] as Map<String, Map<String, Any?>>).values.map { Triple(it["file"] as String, it["sha256"] as String, (it["bytes"] as Number).toLong()) } }
        require(files.isNotEmpty()) { "pet catalog lists no media" }
        fun stale() = files.filter { (file, sha, bytes) -> val target = root.resolve(file); !target.isFile || target.length() != bytes || sha256(target) != sha }.map { it.first }
        var missing = stale()
        if (missing.isNotEmpty()) {
            @Suppress("UNCHECKED_CAST") val bundle = parsed["bundle"] as Map<String, Any?>
            val url = bundle["url"] as? String ?: ""
            require(url.startsWith("https://")) { "${missing.size} pet media file(s) are missing or stale under $root and catalog.json records no bundle URL. Run `node android/scripts/import-pet-skins.mjs import` where the desktop-pet source exists, then `bundle --tag <tag>` and publish the release (android/README.md → 桌宠)." }
            val zip = downloadDirectory.get().asFile.resolve(bundle["file"] as String).apply { parentFile.mkdirs() }
            if (!zip.isFile || sha256(zip) != bundle["sha256"]) {
                logger.lifecycle("Downloading pet media bundle ${bundle["file"]} (${(bundle["bytes"] as Number).toLong() / 1048576} MiB) from $url")
                val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build()
                val response = client.send(HttpRequest.newBuilder(URI(url)).GET().build(), HttpResponse.BodyHandlers.ofFile(zip.toPath()))
                require(response.statusCode() == 200) { "Pet media bundle download failed: HTTP ${response.statusCode()} for $url" }
                require(sha256(zip) == bundle["sha256"]) { "Pet media bundle sha256 mismatch for $url" }
            }
            ZipInputStream(zip.inputStream().buffered()).use { input ->
                while (true) {
                    val entry = input.nextEntry ?: break
                    if (entry.isDirectory || !entry.name.startsWith("skins/")) continue
                    val target = root.resolve(entry.name).canonicalFile
                    require(target.toPath().startsWith(root.canonicalFile.toPath())) { "Unsafe zip entry ${entry.name}" }
                    target.parentFile.mkdirs()
                    target.outputStream().use { input.copyTo(it) }
                }
            }
            missing = stale()
            require(missing.isEmpty()) { "Pet media still differs from catalog.json after fetching the bundle: ${missing.take(5)}" }
        }
        stamp.get().asFile.apply { parentFile.mkdirs(); writeText(files.joinToString("\n") { "${it.first} ${it.second}" } + "\n") }
    }
    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input -> val buffer = ByteArray(1 shl 16); while (true) { val read = input.read(buffer); if (read < 0) break; digest.update(buffer, 0, read) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
val petAssets = tasks.register<PreparePetAssets>("preparePetAssets") {
    catalog.set(layout.projectDirectory.file("src/main/assets/pet/catalog.json"))
    assetsDirectory.set(layout.projectDirectory.dir("src/main/assets/pet"))
    downloadDirectory.set(layout.buildDirectory.dir("pet-assets"))
    stamp.set(layout.buildDirectory.file("pet-assets/verified.txt"))
    outputs.upToDateWhen { false }
}
tasks.named("preBuild") { dependsOn(petAssets) }

val sharedAssets = tasks.register<PrepareSharedAssets>("prepareSharedAssets") {
    sceneInput.set(layout.projectDirectory.dir("../../ios/Melo/Scene"))
    schemaInput.set(layout.projectDirectory.file("../../shared/protocol/sync.schema.json"))
    coreInput.set(layout.projectDirectory.dir("../../shared/agent/dist"))
    coreSources.set(layout.projectDirectory.dir("../../shared/agent"))
    replyDocumentSource.set(layout.projectDirectory.file("../../src/shared/replyDocument.js"))
    outputDirectory.set(layout.buildDirectory.dir("generated/shared-assets"))
}
androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(sharedAssets) { it.outputDirectory }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("org.mnode.ical4j:ical4j:3.2.19")
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-view:1.6.2")
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
