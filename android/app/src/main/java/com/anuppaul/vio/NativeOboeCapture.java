package com.anuppaul.vio;

final class NativeOboeCapture {
    private static final boolean LOADED;
    private static volatile boolean runtimeAvailable;

    static {
        boolean loaded = false;
        try {
            System.loadLibrary("vio_audio");
            loaded = true;
        } catch (Throwable ignored) {
            loaded = false;
        }
        LOADED = loaded;
        runtimeAvailable = loaded;
    }

    private NativeOboeCapture() {}

    static boolean isAvailable() {
        return LOADED && runtimeAvailable;
    }

    private static void markUnavailable() {
        runtimeAvailable = false;
    }

    static void configureDefaults(int sampleRate, int framesPerBurst) {
        if (!isAvailable()) return;
        try {
            nativeConfigureDefaults(sampleRate, framesPerBurst);
        } catch (Throwable ignored) {
            markUnavailable();
        }
    }

    static int start() {
        if (!isAvailable()) return Integer.MIN_VALUE;
        try {
            return nativeStart();
        } catch (Throwable ignored) {
            markUnavailable();
            return Integer.MIN_VALUE;
        }
    }

    static void stop() {
        if (!isAvailable()) return;
        try {
            nativeStop();
        } catch (Throwable ignored) {
            markUnavailable();
        }
    }

    static int read(float[] output, int maxFrames, int timeoutMs) {
        if (!isAvailable()) return -1;
        try {
            return nativeRead(output, maxFrames, timeoutMs);
        } catch (Throwable ignored) {
            markUnavailable();
            return -1;
        }
    }

    static boolean isRunning() {
        if (!isAvailable()) return false;
        try {
            return nativeIsRunning();
        } catch (Throwable ignored) {
            markUnavailable();
            return false;
        }
    }

    static int getSampleRate() {
        if (!isAvailable()) return 0;
        try {
            return nativeGetSampleRate();
        } catch (Throwable ignored) {
            markUnavailable();
            return 0;
        }
    }

    static int getFramesPerBurst() {
        if (!isAvailable()) return 0;
        try {
            return nativeGetFramesPerBurst();
        } catch (Throwable ignored) {
            markUnavailable();
            return 0;
        }
    }

    static int getBufferCapacityFrames() {
        if (!isAvailable()) return 0;
        try {
            return nativeGetBufferCapacityFrames();
        } catch (Throwable ignored) {
            markUnavailable();
            return 0;
        }
    }

    static long getDroppedFrames() {
        if (!isAvailable()) return 0L;
        try {
            return nativeGetDroppedFrames();
        } catch (Throwable ignored) {
            markUnavailable();
            return 0L;
        }
    }

    static int getLastErrorCode() {
        if (!isAvailable()) return Integer.MIN_VALUE;
        try {
            return nativeGetLastErrorCode();
        } catch (Throwable ignored) {
            markUnavailable();
            return Integer.MIN_VALUE;
        }
    }

    static String getBackendName() {
        if (!isAvailable()) return "oboe-unavailable";
        try {
            String value = nativeGetBackendName();
            return value == null || value.isEmpty() ? "oboe" : value;
        } catch (Throwable ignored) {
            markUnavailable();
            return "oboe-unavailable";
        }
    }

    private static native void nativeConfigureDefaults(int sampleRate, int framesPerBurst);
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
