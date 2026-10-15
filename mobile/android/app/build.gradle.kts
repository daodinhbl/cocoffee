import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing: android/key.properties (git-ignored) names the keystore and its passwords. The keystore
// IS the app's identity on every phone it is installed on: losing it means a new package that cannot update
// the old one. Keep key.properties + the .jks backed up outside this PC. Without the file (CI, a fresh
// clone) release builds fall back to the debug key so `flutter run --release` still works.
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseKey = keystorePropertiesFile.exists()
if (hasReleaseKey) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

android {
    namespace = "com.tasotek.cocoffee_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true   // flutter_local_notifications
    }

    defaultConfig {
        applicationId = "com.tasotek.cocoffee_mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Two channels of the same app. "direct": the APK offered at /download on the shop's server, which updates itself
    // (OTA). "play": the Google Play build; Play forbids an app from installing or updating itself by any other means,
    // so it carries no installer permission, provider or receiver (see src/play/AndroidManifest.xml).
    flavorDimensions += "channel"
    productFlavors {
        create("direct") {
            dimension = "channel"
            manifestPlaceholders["appName"] = "Tasotek FnB"
        }
        create("play") {
            dimension = "channel"
            applicationId = "com.tasotek.pos"      // its own Play listing: the package name cannot change once published
            manifestPlaceholders["appName"] = "POS Tasotek"
        }
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }

    buildTypes {
        release {
            // Native debug symbols (.sym) travel in the bundle's metadata, so Play can symbolicate native crashes.
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
