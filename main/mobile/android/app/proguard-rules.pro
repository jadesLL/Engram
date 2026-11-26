# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Keep Engram app classes and WebView JS bridge methods
-keep class com.engram.app.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Capacitor runtime & plugin annotations
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
}

# Keep Ktor CIO embedded HTTP server, Kotlin coroutines, OkHttp, Okio, org.json
-keep class io.ktor.** { *; }
-keep class kotlinx.coroutines.** { *; }
-keep class okhttp3.** { *; }
-keep class okio.** { *; }
-keep class org.json.** { *; }

# Suppress optional JVM desktop/server warnings pulled transitively by Ktor/OkHttp/SLF4J
-dontwarn io.ktor.**
-dontwarn kotlinx.coroutines.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.slf4j.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn org.eclipse.jetty.**
-dontwarn io.netty.**
-dontwarn java.lang.instrument.**
-dontwarn java.lang.management.**
-dontwarn javax.naming.**
-dontwarn javax.management.**

-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
