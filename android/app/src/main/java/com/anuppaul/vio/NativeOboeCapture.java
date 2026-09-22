package com.anuppaul.vio;

final class NativeOboeCapture {
    private static final boolean LOADED;

    static {
        boolean loaded = false;
        try {
            System.loadLibrary("vio_audio");
            loaded = true;
        } catch (Throwable ignored) {
            loaded = false;
        }
        LOADED = loaded;
    }

    private NativeOboeCapture() {}

    static boolean isAvailable() {
        return LOADED;
    }

    static int start() {
        return LOADED ? nativeStart() : Integer.MIN_VALUE;
    }

    static void stop() {
        if (LOADED) nativeStop();
    }

    static int read(float[] output, int maxFrames, int timeoutMs) {
        if (!LOADED) return -1;
        return nativeRead(output, maxFrames, timeoutMs);
    }

    static boolean isRunning() {
        return LOADED && nativeIsRunning();
    }

    static int getSampleRate() {
        return LOADED ? nativeGetSampleRate() : 0;
    }

    static int getFramesPerBurst() {
        return LOADED ? nativeGetFramesPerBurst() : 0;
    }

    static int getBufferCapacityFrames() {
        return LOADED ? nativeGetBufferCapacityFrames() : 0;
    }

    static long getDroppedFrames() {
        return LOADED ? nativeGetDroppedFrames() : 0L;
    }

    static int getLastErrorCode() {
        return LOADED ? nativeGetLastErrorCode() : Integer.MIN_VALUE;
    }

    static String getBackendName() {
        if (!LOADED) return "oboe-unavailable";
        String value = nativeGetBackendName();
        return value == null || value.isEmpty() ? "oboe" : value;
    }

    private static native int nativeStart();
    private static native void nativeStop();
    private static native int nativeRead(float[] output, int maxFrames, int timeoutMs);
    private static native boolean nativeIsRunning();
    private static native int nativeGetSampleRate();
    private static native int nativeGetFramesPerBurst();
    private static native int nativeGetBufferCapacityFrames();
    private static native long nativeGetDroppedFrames();
    private static native int nativeGetLastErrorCode();
    private static native String nativeGetBackendName();
}
