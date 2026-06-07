# Reglas de ofuscación. Por defecto sin minify; se conserva la interfaz JS del WebView.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
