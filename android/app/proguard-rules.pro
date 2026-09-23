# VIO release shrinking rules.
#
# Keep only the small surfaces that are resolved reflectively or through JNI.
# Everything else remains eligible for R8 shrinking/optimization.

# Capacitor discovers plugin metadata and methods from runtime annotations.
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault

# VIO's custom Capacitor plugin is registered explicitly, but its annotated
# methods are invoked reflectively by Capacitor.
-keep class com.anuppaul.vio.NativePitchPlugin extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod <methods>;
}

# JNI exports use the Java class/method names in their native symbol names.
# Do not obfuscate or remove this bridge.
-keep class com.anuppaul.vio.NativeOboeCapture {
    *;
}

# Android launches MainActivity by manifest class name.
-keep class com.anuppaul.vio.MainActivity {
    public <init>();
    public void onCreate(android.os.Bundle);
}

# Preserve Capacitor plugin annotation metadata on any bundled plugin class
# without broadly disabling shrinking for the Capacitor runtime.
-keep,allowoptimization,allowshrinking @com.getcapacitor.annotation.CapacitorPlugin class * {
    @com.getcapacitor.PluginMethod <methods>;
}
