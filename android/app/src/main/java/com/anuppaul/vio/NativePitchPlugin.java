package com.anuppaul.vio;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;

import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(
    name = "NativePitch",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class NativePitchPlugin extends Plugin {
    private static final int ANALYSIS_SIZE = 8192;
    private static final int SHORT_ANALYSIS_SIZE = 4096;
    private static final int FAST_ANALYSIS_SIZE = 2048;
    private static final double TARGET_HOP_SECONDS = 0.0213333333;
    private static final int CHUNK_SIZE = 512;
    private static final int MPM_UPDATE_HOPS = 4;
    private static final int LOW_MPM_UPDATE_HOPS = 2;
    private static final int LONG_LOW_UPDATE_HOPS = 2;
    private static final int LONG_HIGH_UPDATE_HOPS = 3;
    private static final double[] FAST_HANN = createHann(FAST_ANALYSIS_SIZE);
    private static final double[] SHORT_HANN = createHann(SHORT_ANALYSIS_SIZE);
    private static final double[] LONG_HANN = createHann(ANALYSIS_SIZE);
    private static final double MIN_FREQUENCY = 20.0;
    private static final double MAX_FREQUENCY = 5000.0;
    private static final double MIN_SUSTAINED_CONFIDENCE = 0.64;
    private static final double MIN_TRANSIENT_CONFIDENCE = 0.56;
    
    private final Object captureLock = new Object();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private AudioRecord recorder;
    private Thread worker;
    private AcousticEchoCanceler echoCanceler;
    private NoiseSuppressor noiseSuppressor;
    private AutomaticGainControl automaticGainControl;
    private int sampleRate;
    private String audioSourceName = "microphone";
    private boolean usingOboe = false;
    private int nativeFramesPerBurst = 0;
    private int nativeBufferCapacityFrames = 0;
    private int lastOboeStartError = 0;
    private int oboeRecoveryCount = 0;

    private PermissionState microphonePermissionState() {
        PermissionState capacitorState = getPermissionState("microphone");
        if (capacitorState != null) return capacitorState;

        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
            ? PermissionState.GRANTED
            : PermissionState.PROMPT;
    }

    @Override
    @PluginMethod
    @PermissionCallback
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        result.put("microphone", microphonePermissionState().toString());
        call.resolve(result);
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (microphonePermissionState() == PermissionState.GRANTED) {
            checkPermissions(call);
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
    }

    @PermissionCallback
    public void microphonePermissionCallback(PluginCall call) {
        checkPermissions(call);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (microphonePermissionState() != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "startPermissionCallback");
            return;
        }

        startCapture(call);
    }

    @PermissionCallback
    public void startPermissionCallback(PluginCall call) {
        if (microphonePermissionState() != PermissionState.GRANTED) {
            call.reject("Microphone permission is required.");
            return;
        }

        startCapture(call);
    }

    private void startCapture(PluginCall call) {
        synchronized (captureLock) {
            if (running.get()) {
                call.resolve(captureInfo());
                return;
            }

            lastOboeStartError = 0;
            oboeRecoveryCount = 0;
            if (NativeOboeCapture.isAvailable()) {
                configureOboeDefaults();
                int oboeResult = NativeOboeCapture.start();
                int oboeRate = NativeOboeCapture.getSampleRate();
                if (oboeResult == 0 && oboeRate > 0 && NativeOboeCapture.isRunning()) {
                    usingOboe = true;
                    recorder = null;
                    sampleRate = oboeRate;
                    audioSourceName = NativeOboeCapture.getBackendName();
                    nativeFramesPerBurst = NativeOboeCapture.getFramesPerBurst();
                    nativeBufferCapacityFrames = NativeOboeCapture.getBufferCapacityFrames();

                    running.set(true);
                    worker = new Thread(this::captureLoop, "vio-native-pitch-oboe");
                    worker.setDaemon(true);
                    worker.start();
                    call.resolve(captureInfo());
                    return;
                }
                lastOboeStartError = oboeResult != 0
                    ? oboeResult
                    : NativeOboeCapture.getLastErrorCode();
                NativeOboeCapture.stop();
            }

            AudioRecord created = createRecorder();
            if (created == null) {
                call.reject("Unable to initialize native microphone capture.");
                return;
            }

            usingOboe = false;
            nativeFramesPerBurst = 0;
            nativeBufferCapacityFrames = 0;
            recorder = created;
            disablePlatformAudioEffects(created.getAudioSessionId());
            try {
                created.startRecording();
            } catch (Exception error) {
                releaseRecorder(created);
                recorder = null;
                releasePlatformAudioEffects();
                call.reject("Unable to start native microphone capture: " + error.getMessage());
                return;
            }

            if (created.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                releaseRecorder(created);
                recorder = null;
                releasePlatformAudioEffects();
                call.reject("Native microphone did not enter recording state.");
                return;
            }

            running.set(true);
            worker = new Thread(this::captureLoop, "vio-native-pitch-audiorecord");
            worker.setDaemon(true);
            worker.start();
            call.resolve(captureInfo());
        }
    }

    private JSObject captureInfo() {
        synchronized (captureLock) {
            JSObject result = new JSObject();
            result.put("sampleRate", sampleRate);
            result.put("source", audioSourceName);
            result.put("backend", usingOboe ? "oboe" : "audiorecord");
            result.put("framesPerBurst", nativeFramesPerBurst);
            result.put("bufferCapacityFrames", nativeBufferCapacityFrames);
            result.put("droppedFrames", usingOboe ? NativeOboeCapture.getDroppedFrames() : 0L);
            result.put("ringCapacityFrames", usingOboe ? NativeOboeCapture.getRingCapacityFrames() : 0);
            result.put("oboeAvailable", NativeOboeCapture.isAvailable());
            result.put("oboeFallbackErrorCode", usingOboe ? 0 : lastOboeStartError);
            return result;
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopCapture();
        call.resolve();
    }

    @PluginMethod
    public void diagnostics(PluginCall call) {
        call.resolve(captureInfo());
    }

    @PluginMethod
    public void configureInsets(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                Window window = getActivity().getWindow();
                View decor = window.getDecorView();

                // Capacitor 8 pads the decor view on older WebView versions.
                // VIO owns its native app-bar inset instead so the bar background
                // can start at the physical top edge without a blank strip.
                WindowCompat.setDecorFitsSystemWindows(window, false);
                ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
                    Insets bars = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
                    );
                    Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                    boolean keyboardVisible =
                        insets.isVisible(WindowInsetsCompat.Type.ime());
                    view.setPadding(
                        0,
                        0,
                        0,
                        keyboardVisible ? ime.bottom : 0
                    );
                    injectNativeInsets(bars);
                    return insets;
                });
                ViewCompat.requestApplyInsets(decor);
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to configure native system insets.", error);
            }
        });
    }

    private void injectNativeInsets(Insets bars) {
        float density = getActivity().getResources().getDisplayMetrics().density;
        int top = Math.max(0, Math.round(bars.top / density));
        int right = Math.max(0, Math.round(bars.right / density));
        int bottom = Math.max(0, Math.round(bars.bottom / density));
        int left = Math.max(0, Math.round(bars.left / density));

        String script = String.format(
            java.util.Locale.US,
            "document.documentElement.style.setProperty('--vio-native-top','%dpx');"
                + "document.documentElement.style.setProperty('--vio-native-right','%dpx');"
                + "document.documentElement.style.setProperty('--vio-native-bottom','%dpx');"
                + "document.documentElement.style.setProperty('--vio-native-left','%dpx');",
            top,
            right,
            bottom,
            left
        );

        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() ->
                getBridge().getWebView().evaluateJavascript(script, null)
            );
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture();
    }

    private void configureOboeDefaults() {
        try {
            AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (manager == null) return;

            int defaultRate = parsePositiveInt(
                manager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)
            );
            int defaultBurst = parsePositiveInt(
                manager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)
            );
            NativeOboeCapture.configureDefaults(defaultRate, defaultBurst);
        } catch (Exception ignored) {
        }
    }

    private int parsePositiveInt(String value) {
        if (value == null || value.isEmpty()) return 0;
        try {
            int parsed = Integer.parseInt(value);
            return parsed > 0 ? parsed : 0;
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private AudioRecord createRecorder() {
        // Keep the framework-level permission check in the same method as AudioRecord
        // construction so Android lint can prove that the revocable permission is guarded.
        if (getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return null;
        }

        int[] rates = { 48000, 44100, 32000 };
        boolean rawSupported = false;
        try {
            AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            rawSupported = manager != null && "true".equalsIgnoreCase(
                manager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED)
            );
        } catch (Exception ignored) {}

        int[] sources = rawSupported
            ? new int[] { MediaRecorder.AudioSource.UNPROCESSED, MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC }
            : new int[] { MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC };

        for (int source : sources) {
            for (int rate : rates) {
                int minimum = AudioRecord.getMinBufferSize(
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                );
                if (minimum <= 0) continue;

                int bytes = Math.max(minimum, ANALYSIS_SIZE * 2 * 2);
                AudioRecord candidate = null;
                try {
                    AudioFormat format = new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build();
                    candidate = new AudioRecord.Builder()
                        .setAudioSource(source)
                        .setAudioFormat(format)
                        .setBufferSizeInBytes(bytes)
                        .build();
                    if (candidate.getState() == AudioRecord.STATE_INITIALIZED) {
                        sampleRate = rate;
                        audioSourceName = sourceName(source);
                        return candidate;
                    }
                } catch (SecurityException permissionLost) {
                    // Permission can be revoked between the check above and AudioRecord
                    // construction. Abort cleanly instead of risking a native crash.
                    releaseRecorder(candidate);
                    return null;
                } catch (Exception ignored) {
                }
                releaseRecorder(candidate);
            }
        }
        return null;
    }

    private String sourceName(int source) {
        if (source == MediaRecorder.AudioSource.UNPROCESSED) return "unprocessed";
        if (source == MediaRecorder.AudioSource.VOICE_RECOGNITION) return "voice-recognition";
        return "microphone";
    }

    private void disablePlatformAudioEffects(int sessionId) {
        try {
            if (AcousticEchoCanceler.isAvailable()) {
                echoCanceler = AcousticEchoCanceler.create(sessionId);
                if (echoCanceler != null) echoCanceler.setEnabled(false);
            }
        } catch (Exception ignored) {}
        try {
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId);
                if (noiseSuppressor != null) noiseSuppressor.setEnabled(false);
            }
        } catch (Exception ignored) {}
        try {
            if (AutomaticGainControl.isAvailable()) {
                automaticGainControl = AutomaticGainControl.create(sessionId);
                if (automaticGainControl != null) automaticGainControl.setEnabled(false);
            }
        } catch (Exception ignored) {}
    }

    private void releasePlatformAudioEffects() {
        try { if (echoCanceler != null) echoCanceler.release(); } catch (Exception ignored) {}
        try { if (noiseSuppressor != null) noiseSuppressor.release(); } catch (Exception ignored) {}
        try { if (automaticGainControl != null) automaticGainControl.release(); } catch (Exception ignored) {}
        echoCanceler = null;
        noiseSuppressor = null;
        automaticGainControl = null;
    }

    private void captureLoop() {
        final boolean oboeBackend = usingOboe;
        AudioRecord local = recorder;
        if (!oboeBackend && local == null) return;

        short[] chunk = oboeBackend ? null : new short[CHUNK_SIZE];
        float[] oboeChunk = oboeBackend ? new float[CHUNK_SIZE] : null;
        float[] ring = new float[ANALYSIS_SIZE];
        float[] frame = new float[ANALYSIS_SIZE];
        float[] shortFrame = new float[SHORT_ANALYSIS_SIZE];
        float[] fastFrame = new float[FAST_ANALYSIS_SIZE];
        NativeYinDetector sustainedDetector = new NativeYinDetector(sampleRate, ANALYSIS_SIZE);
        NativeYinDetector transientDetector = new NativeYinDetector(sampleRate, SHORT_ANALYSIS_SIZE);
        NativeYinDetector fastDetector = new NativeYinDetector(sampleRate, FAST_ANALYSIS_SIZE);
        NativeMpmDetector mpmDetector = new NativeMpmDetector(sampleRate, SHORT_ANALYSIS_SIZE, 70.0, MAX_FREQUENCY);
        NativeMpmDetector lowMpmDetector = new NativeMpmDetector(
            sampleRate,
            ANALYSIS_SIZE,
            120.0,
            350.0,
            85.0
        );
        PitchResult mpmPitch = null;
        PitchResult lowMpmPitch = null;
        PitchResult sustainedPitch = null;
        int mpmHops = 0;
        int lowMpmHops = 0;
        int sustainedHops = 0;

        int write = 0;
        int filled = 0;
        int sinceAnalysis = 0;
        int analysisHop = Math.max(
            512,
            Math.round((float) (sampleRate * TARGET_HOP_SECONDS) / 128.0f) * 128
        );

        String failureMessage = null;
        while (running.get()) {
            int count;
            if (oboeBackend) {
                count = NativeOboeCapture.read(oboeChunk, oboeChunk.length, 120);
                if (count < 0) {
                    if (running.get()) {
                        failureMessage = "Oboe microphone capture became unavailable ("
                            + NativeOboeCapture.getLastErrorCode() + ").";
                    }
                    break;
                }
                if (count == 0) continue;
            } else {
                try {
                    count = local.read(chunk, 0, chunk.length, AudioRecord.READ_BLOCKING);
                } catch (Exception error) {
                    if (running.get()) failureMessage = "Native microphone read failed.";
                    break;
                }
                if (count <= 0) {
                    if (count == AudioRecord.ERROR_DEAD_OBJECT || count == AudioRecord.ERROR_INVALID_OPERATION) {
                        if (running.get()) failureMessage = "Native microphone capture became unavailable.";
                        break;
                    }
                    continue;
                }
            }

            for (int i = 0; i < count; i++) {
                ring[write] = oboeBackend ? oboeChunk[i] : chunk[i] / 32768.0f;
                write++;
                if (write == ANALYSIS_SIZE) write = 0;
            }
            filled = Math.min(ANALYSIS_SIZE, filled + count);
            sinceAnalysis += count;
            if (filled < FAST_ANALYSIS_SIZE || sinceAnalysis < analysisHop) continue;
            sinceAnalysis %= analysisHop;

            boolean haveFast = copyLatest(ring, write, filled, fastFrame);
            boolean haveShort = copyLatest(ring, write, filled, shortFrame);
            boolean haveLong = copyLatest(ring, write, filled, frame);

            PitchResult fastPitch = haveFast ? fastDetector.detect(fastFrame) : null;
            PitchResult transientPitch = haveShort ? transientDetector.detect(shortFrame) : null;

            if (haveLong) {
                double hintFrequency = fastPitch != null
                    ? fastPitch.frequency
                    : transientPitch != null ? transientPitch.frequency : 0.0;
                int requiredHops = hintFrequency > 350.0
                    ? LONG_HIGH_UPDATE_HOPS
                    : LONG_LOW_UPDATE_HOPS;
                sustainedHops++;
                if (sustainedPitch == null || sustainedHops >= requiredHops) {
                    sustainedHops = 0;
                    sustainedPitch = sustainedDetector.detect(frame);
                }
            }

            if (haveShort) {
                mpmHops++;
                if (mpmHops >= MPM_UPDATE_HOPS) {
                    mpmHops = 0;
                    mpmPitch = mpmDetector.detect(shortFrame);
                }
            }

            if (haveLong) {
                lowMpmHops++;
                if (lowMpmHops >= LOW_MPM_UPDATE_HOPS) {
                    lowMpmHops = 0;
                    lowMpmPitch = lowMpmDetector.detect(frame);
                }
            }

            float[] onsetFrame = haveLong ? frame : (haveShort ? shortFrame : fastFrame);
            int onsetSize = onsetFrame.length;
            int recentSize = Math.min(1024, onsetSize / 2);
            int previousSize = Math.min(2048, onsetSize - recentSize);
            double recentRms = rmsRange(onsetFrame, onsetSize - recentSize, onsetSize);
            double previousRms = rmsRange(
                onsetFrame,
                Math.max(0, onsetSize - recentSize - previousSize),
                onsetSize - recentSize
            );
            boolean onset = recentRms > Math.max(previousRms * 1.18, previousRms + 0.00018);
            double rms = haveLong ? rms(frame) : (haveShort ? rms(shortFrame) : rms(fastFrame));

            PitchResult responsivePitch = transientPitch;
            if (fastPitch != null && fastPitch.confidence >= MIN_TRANSIENT_CONFIDENCE) {
                boolean highPitch = fastPitch.frequency >= 500.0;
                boolean strongerEnough = transientPitch == null || fastPitch.confidence >= transientPitch.confidence * 0.86;
                if ((onset || highPitch) && strongerEnough) {
                    responsivePitch = new PitchResult(fastPitch.frequency, fastPitch.confidence, "transient");
                }
            }

            boolean fastShortAgree =
                fastPitch != null &&
                transientPitch != null &&
                pitchCentsApart(fastPitch.frequency, transientPitch.frequency) <= 45.0;
            PitchResult sustainedForFrame = sustainedPitch;
            if (
                onset &&
                fastShortAgree &&
                responsivePitch != null &&
                sustainedForFrame != null &&
                pitchCentsApart(sustainedForFrame.frequency, responsivePitch.frequency) > 80.0
            ) {
                sustainedForFrame = null;
            }
            PitchResult pitch = chooseHybridPitch(sustainedForFrame, responsivePitch, onset);
            PitchResult mpmForFrame = mpmPitch;
            if (
                onset &&
                fastShortAgree &&
                responsivePitch != null &&
                mpmForFrame != null &&
                pitchCentsApart(mpmForFrame.frequency, responsivePitch.frequency) > 80.0
            ) {
                mpmForFrame = null;
            }
            pitch = mergeMpmConsensus(pitch, mpmForFrame);
            pitch = mergeLowFrequencyConsensus(
                pitch,
                lowMpmPitch,
                sustainedForFrame,
                haveLong ? frame : null
            );
            float[] harmonicFrame =
                pitch != null && pitch.frequency < 350.0 && haveLong
                    ? frame
                    : (haveShort ? shortFrame : fastFrame);
            pitch = validateHarmonicFundamental(pitch, harmonicFrame);
            if (
                pitch != null &&
                pitch.frequency < 80.0 &&
                (
                    sustainedForFrame == null ||
                    pitchCentsApart(sustainedForFrame.frequency, pitch.frequency) > 45.0
                ) &&
                (
                    mpmForFrame == null ||
                    pitchCentsApart(mpmForFrame.frequency, pitch.frequency) > 45.0
                )
            ) {
                pitch = null;
            }
            emitPitch(acceptPitch(pitch), rms);
        }

        if (failureMessage != null) {
            if (oboeBackend && recoverFromOboeFailure()) {
                return;
            }
            if (running.compareAndSet(true, false)) {
                synchronized (captureLock) {
                    if (oboeBackend) {
                        usingOboe = false;
                        NativeOboeCapture.stop();
                    } else if (recorder == local) {
                        recorder = null;
                    }
                }
                if (!oboeBackend) {
                    try { if (local != null) local.stop(); } catch (Exception ignored) {}
                    releaseRecorder(local);
                    releasePlatformAudioEffects();
                }
                emitCaptureError(failureMessage);
            }
        }
    }

    private boolean recoverFromOboeFailure() {
        if (!running.compareAndSet(true, false)) {
            return false;
        }

        synchronized (captureLock) {
            if (!usingOboe) {
                return false;
            }

            usingOboe = false;
            NativeOboeCapture.stop();

            if (oboeRecoveryCount < 1 && NativeOboeCapture.isAvailable()) {
                oboeRecoveryCount++;
                configureOboeDefaults();
                int result = NativeOboeCapture.start();
                int rate = NativeOboeCapture.getSampleRate();
                if (result == 0 && rate > 0 && NativeOboeCapture.isRunning()) {
                    usingOboe = true;
                    sampleRate = rate;
                    audioSourceName = NativeOboeCapture.getBackendName();
                    nativeFramesPerBurst = NativeOboeCapture.getFramesPerBurst();
                    nativeBufferCapacityFrames = NativeOboeCapture.getBufferCapacityFrames();
                    running.set(true);
                    launchCaptureWorkerLocked("vio-native-pitch-oboe-recovered");
                    emitBackendChange();
                    return true;
                }
                lastOboeStartError = result != 0
                    ? result
                    : NativeOboeCapture.getLastErrorCode();
                NativeOboeCapture.stop();
            }

            AudioRecord created = createRecorder();
            if (created == null) {
                running.set(true);
                return false;
            }

            recorder = created;
            nativeFramesPerBurst = 0;
            nativeBufferCapacityFrames = 0;
            disablePlatformAudioEffects(created.getAudioSessionId());
            try {
                created.startRecording();
            } catch (Exception error) {
                releaseRecorder(created);
                recorder = null;
                releasePlatformAudioEffects();
                running.set(true);
                return false;
            }

            if (created.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                releaseRecorder(created);
                recorder = null;
                releasePlatformAudioEffects();
                running.set(true);
                return false;
            }

            usingOboe = false;
            running.set(true);
            launchCaptureWorkerLocked("vio-native-pitch-audiorecord-recovered");
            emitBackendChange();
            return true;
        }
    }

    private void launchCaptureWorkerLocked(String name) {
        worker = new Thread(this::captureLoop, name);
        worker.setDaemon(true);
        worker.start();
    }

    private void emitBackendChange() {
        JSObject info = captureInfo();
        mainHandler.post(() -> {
            if (running.get()) notifyListeners("backend", info);
        });
    }

    private boolean copyLatest(float[] ring, int write, int filled, float[] target) {
        if (filled < target.length) return false;
        int start = write - target.length;
        if (start < 0) start += ring.length;
        int first = Math.min(target.length, ring.length - start);
        System.arraycopy(ring, start, target, 0, first);
        if (first < target.length) {
            System.arraycopy(ring, 0, target, first, target.length - first);
        }
        return true;
    }

    private double rms(float[] frame) {
        return rmsRange(frame, 0, frame.length);
    }

    private double rmsRange(float[] frame, int start, int end) {
        double sum = 0.0;
        int count = 0;
        int safeStart = Math.max(0, start);
        int safeEnd = Math.min(frame.length, end);
        for (int i = safeStart; i < safeEnd; i++) {
            sum += frame[i] * frame[i];
            count++;
        }
        return count == 0 ? 0.0 : Math.sqrt(sum / count);
    }

    private PitchResult chooseHybridPitch(PitchResult sustained, PitchResult transientPitch, boolean onset) {
        boolean sustainedOk = sustained != null && sustained.confidence >= MIN_SUSTAINED_CONFIDENCE;
        boolean transientOk = transientPitch != null && transientPitch.confidence >= MIN_TRANSIENT_CONFIDENCE;

        if (!sustainedOk && !transientOk) return null;
        if (sustainedOk && transientOk) {
            double direct = pitchCentsApart(sustained.frequency, transientPitch.frequency);
            if (direct <= 45.0) {
                PitchResult selected = sustained.confidence >= transientPitch.confidence * 0.82 ? sustained : transientPitch;
                return new PitchResult(selected.frequency, selected.confidence, onset ? "transient" : "sustained");
            }

            double lower = Math.min(sustained.frequency, transientPitch.frequency);
            double higher = Math.max(sustained.frequency, transientPitch.frequency);
            double ratio = higher / lower;
            int harmonic = (int) Math.round(ratio);
            if (harmonic >= 2 && harmonic <= 4) {
                double harmonicError = Math.abs(1200.0 * (Math.log(ratio / harmonic) / Math.log(2.0)));
                if (harmonicError <= 45.0) {
                    PitchResult lowerPitch = sustained.frequency <= transientPitch.frequency ? sustained : transientPitch;
                    PitchResult higherPitch = lowerPitch == sustained ? transientPitch : sustained;
                    double requiredRatio = harmonic == 2 ? 0.62 : 0.74;
                    if (lowerPitch.confidence >= higherPitch.confidence * requiredRatio) {
                        return new PitchResult(lowerPitch.frequency, lowerPitch.confidence, onset ? "transient" : "sustained");
                    }
                }
            }

            if (onset && transientPitch.confidence >= 0.68) {
                return new PitchResult(transientPitch.frequency, transientPitch.confidence, "transient");
            }
            PitchResult selected = sustained.confidence >= transientPitch.confidence ? sustained : transientPitch;
            return new PitchResult(selected.frequency, selected.confidence, selected == transientPitch ? "transient" : "sustained");
        }
        if (transientOk) return new PitchResult(transientPitch.frequency, transientPitch.confidence, "transient");
        return new PitchResult(sustained.frequency, sustained.confidence, "sustained");
    }

    private PitchResult mergeMpmConsensus(PitchResult primary, PitchResult mpm) {
        if (mpm == null || mpm.confidence < 0.58) return primary;
        if (primary == null) {
            return mpm.confidence >= 0.72
                ? new PitchResult(mpm.frequency, mpm.confidence, "sustained")
                : null;
        }

        double direct = pitchCentsApart(primary.frequency, mpm.frequency);
        if (direct <= 35.0) {
            double frequency = Math.sqrt(primary.frequency * mpm.frequency);
            double confidence = Math.min(1.0, Math.max(primary.confidence, mpm.confidence) + 0.08);
            return new PitchResult(frequency, confidence, primary.mode);
        }

        double lower = Math.min(primary.frequency, mpm.frequency);
        double higher = Math.max(primary.frequency, mpm.frequency);
        double ratio = higher / lower;
        int harmonic = (int) Math.round(ratio);
        if (harmonic >= 2 && harmonic <= 4) {
            double harmonicError = Math.abs(1200.0 * (Math.log(ratio / harmonic) / Math.log(2.0)));
            if (harmonicError <= 42.0) {
                PitchResult lowerPitch = primary.frequency <= mpm.frequency ? primary : mpm;
                PitchResult higherPitch = lowerPitch == primary ? mpm : primary;
                if (lowerPitch.confidence >= higherPitch.confidence * 0.78) {
                    return new PitchResult(
                        lowerPitch.frequency,
                        Math.min(1.0, lowerPitch.confidence + 0.04),
                        lowerPitch == primary ? primary.mode : "sustained"
                    );
                }
            }
        }

        return primary;
    }

    private PitchResult mergeLowFrequencyConsensus(
        PitchResult primary,
        PitchResult lowMpm,
        PitchResult sustained,
        float[] longFrame
    ) {
        if (
            lowMpm == null ||
            longFrame == null ||
            lowMpm.frequency < 120.0 ||
            lowMpm.frequency > 350.0
        ) {
            return primary;
        }

        boolean yinAgrees =
            sustained != null &&
            pitchCentsApart(sustained.frequency, lowMpm.frequency) <= 45.0;
        double lowProfile = harmonicProfileScore(longFrame, lowMpm.frequency);

        if (primary == null) {
            if (lowMpm.confidence >= 0.62 && (yinAgrees || lowProfile >= 0.24)) {
                double confidence = lowMpm.confidence;
                if (yinAgrees) confidence += 0.13;
                confidence += Math.min(0.09, lowProfile * 0.18);
                return new PitchResult(
                    lowMpm.frequency,
                    Math.min(1.0, Math.max(0.66, confidence)),
                    "sustained"
                );
            }
            return null;
        }

        double direct = pitchCentsApart(primary.frequency, lowMpm.frequency);
        if (direct <= 38.0) {
            double frequency = Math.sqrt(primary.frequency * lowMpm.frequency);
            double confidence = Math.max(primary.confidence, lowMpm.confidence) + 0.10;
            if (yinAgrees) confidence += 0.08;
            confidence += Math.min(0.06, lowProfile * 0.12);
            return new PitchResult(
                frequency,
                Math.min(1.0, Math.max(0.68, confidence)),
                primary.mode
            );
        }

        double lower = Math.min(primary.frequency, lowMpm.frequency);
        double higher = Math.max(primary.frequency, lowMpm.frequency);
        double ratio = higher / lower;
        int harmonic = (int) Math.round(ratio);

        if (harmonic >= 2 && harmonic <= 4) {
            double harmonicError = Math.abs(
                1200.0 * (Math.log(ratio / harmonic) / Math.log(2.0))
            );
            if (harmonicError <= 45.0) {
                PitchResult lowerPitch =
                    primary.frequency <= lowMpm.frequency ? primary : lowMpm;
                PitchResult higherPitch = lowerPitch == primary ? lowMpm : primary;

                if (lowerPitch == lowMpm) {
                    double higherProfile = harmonicProfileScore(longFrame, higherPitch.frequency);
                    boolean harmonicEvidence =
                        lowProfile >= Math.max(0.18, higherProfile * 0.88);
                    boolean confidenceEvidence =
                        lowMpm.confidence >= higherPitch.confidence * 0.64;

                    if ((yinAgrees || harmonicEvidence) && confidenceEvidence) {
                        double confidence =
                            Math.max(lowMpm.confidence, yinAgrees ? 0.84 : 0.70);
                        confidence += Math.min(0.08, lowProfile * 0.14);
                        return new PitchResult(
                            lowMpm.frequency,
                            Math.min(1.0, confidence),
                            "sustained"
                        );
                    }
                }
            }
        }

        if (
            primary.frequency >= 120.0 &&
            primary.frequency <= 350.0 &&
            lowMpm.confidence >= 0.70
        ) {
            double primaryProfile = harmonicProfileScore(longFrame, primary.frequency);
            if (
                (yinAgrees && lowProfile >= primaryProfile * 0.82) ||
                lowProfile >= primaryProfile + 0.10
            ) {
                double confidence = lowMpm.confidence + (yinAgrees ? 0.12 : 0.04);
                return new PitchResult(
                    lowMpm.frequency,
                    Math.min(1.0, confidence),
                    "sustained"
                );
            }
        }

        return primary;
    }

    private PitchResult validateHarmonicFundamental(PitchResult pitch, float[] frame) {
        if (pitch == null || frame == null || frame.length < 512) return pitch;

        double[] candidates = {
            pitch.frequency,
            pitch.frequency / 2.0,
            pitch.frequency / 3.0,
            pitch.frequency * 2.0
        };

        double primaryScore = harmonicProfileScore(frame, pitch.frequency);
        double bestScore = primaryScore;
        double bestFrequency = pitch.frequency;

        for (int i = 1; i < candidates.length; i++) {
            double candidate = candidates[i];
            if (candidate < MIN_FREQUENCY || candidate > MAX_FREQUENCY) continue;
            double score = harmonicProfileScore(frame, candidate);
            if (score > bestScore) {
                bestScore = score;
                bestFrequency = candidate;
            }
        }

        boolean changed = Math.abs(bestFrequency - pitch.frequency) > 1e-6;
        boolean decisive = bestScore >= primaryScore * 1.22 && bestScore - primaryScore >= 0.055;
        if (changed && decisive) {
            double confidence = Math.min(
                1.0,
                Math.max(pitch.confidence, 0.58 + Math.min(0.34, bestScore * 0.34))
            );
            return new PitchResult(bestFrequency, confidence, pitch.mode);
        }

        return pitch;
    }

    private double harmonicProfileScore(float[] frame, double frequency) {
        if (!(frequency > 0.0) || frame.length < 512) return 0.0;

        double nyquist = sampleRate / 2.0;
        double frameEnergy = 0.0;
        for (float value : frame) frameEnergy += value * value;
        if (frameEnergy <= 1e-12) return 0.0;

        double score = 0.0;
        double totalWeight = 0.0;
        int present = 0;
        int considered = 0;

        for (int harmonic = 1; harmonic <= 8; harmonic++) {
            double target = frequency * harmonic;
            if (target >= nyquist * 0.94) break;

            double resolution = sampleRate / (double) frame.length;
            boolean longLowProfile = frame.length == ANALYSIS_SIZE && frequency < 350.0;
            double delta = longLowProfile
                ? Math.max(resolution * 1.35, target * 0.012)
                : Math.max(resolution * 2.5, target * 0.018);
            double tone = goertzelPower(frame, target);
            double left = target - delta > 1.0 ? goertzelPower(frame, target - delta) : 0.0;
            double right = target + delta < nyquist ? goertzelPower(frame, target + delta) : 0.0;
            double floor = Math.max(1e-12, (left + right) * 0.5);
            double contrast = tone / floor;
            double presence = Math.max(0.0, Math.min(1.0, (contrast - 1.08) / 2.25));
            double normalizedEnergy = Math.min(
                1.0,
                tone / Math.max(1e-12, frameEnergy * frame.length) * 4.0
            );
            double weight = 1.0 / Math.sqrt(harmonic);

            score += weight * (presence * 0.68 + normalizedEnergy * 0.32);
            totalWeight += weight;
            considered++;
            if (presence >= 0.35) present++;
        }

        if (totalWeight <= 0.0 || considered == 0) return 0.0;
        double coverage = present / (double) considered;
        double baseScore = score / totalWeight * 0.82 + coverage * 0.18;
        double humPenalty = mainsHumPenalty(frame, frequency);
        return Math.max(0.0, Math.min(1.0, baseScore - humPenalty));
    }

    private double mainsHumPenalty(float[] frame, double frequency) {
        double penalty = 0.0;
        double[] mainsFrequencies = { 50.0, 60.0 };

        for (double mains : mainsFrequencies) {
            int harmonic = (int) Math.round(frequency / mains);
            if (harmonic < 1 || harmonic > 8) continue;
            double exact = mains * harmonic;
            if (pitchCentsApart(frequency, exact) > 11.0) continue;

            double candidatePower = goertzelPower(frame, frequency);
            double basePower = goertzelPower(frame, mains);
            double secondPower = mains * 2.0 < sampleRate / 2.0
                ? goertzelPower(frame, mains * 2.0)
                : 0.0;
            double baseEvidence = Math.max(basePower, secondPower * 0.72);
            double ratio = baseEvidence / Math.max(candidatePower, 1e-12);
            double current = harmonic == 1
                ? 0.08
                : 0.12 + Math.min(0.12, ratio * 0.08);
            penalty = Math.max(penalty, current);
        }

        return penalty;
    }

    private static double[] createHann(int length) {
        double[] window = new double[length];
        int last = length - 1;
        for (int i = 0; i < length; i++) {
            window[i] = last > 0
                ? 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / last)
                : 1.0;
        }
        return window;
    }

    private double goertzelPower(float[] frame, double frequency) {
        if (!(frequency > 0.0) || frequency >= sampleRate / 2.0) return 0.0;
        double omega = 2.0 * Math.PI * frequency / sampleRate;
        double coefficient = 2.0 * Math.cos(omega);
        double previous = 0.0;
        double previous2 = 0.0;
        double[] window = frame.length == ANALYSIS_SIZE
            ? LONG_HANN
            : (frame.length == SHORT_ANALYSIS_SIZE ? SHORT_HANN : FAST_HANN);

        for (int i = 0; i < frame.length; i++) {
            double value = frame[i] * window[i];
            double current = value + coefficient * previous - previous2;
            previous2 = previous;
            previous = current;
        }

        double power = previous2 * previous2 + previous * previous - coefficient * previous * previous2;
        return Math.max(0.0, power);
    }

    private PitchResult acceptPitch(PitchResult pitch) {
        if (pitch == null) return null;
        double threshold = "transient".equals(pitch.mode)
            ? MIN_TRANSIENT_CONFIDENCE
            : MIN_SUSTAINED_CONFIDENCE;
        return pitch.confidence >= threshold ? pitch : null;
    }

    private static double pitchCentsApart(double a, double b) {
        if (!(a > 0.0) || !(b > 0.0)) return Double.POSITIVE_INFINITY;
        return Math.abs(1200.0 * (Math.log(a / b) / Math.log(2.0)));
    }

    private void emitCaptureError(String message) {
        mainHandler.post(() -> {
            JSObject event = new JSObject();
            event.put("message", message);
            notifyListeners("error", event);
        });
    }

    private void emitPitch(PitchResult pitch, double rms) {
        final double frequency = pitch == null ? 0.0 : pitch.frequency;
        final double confidence = pitch == null ? 0.0 : pitch.confidence;
        final String mode = pitch == null ? "sustained" : pitch.mode;
        mainHandler.post(() -> {
            if (!running.get()) return;
            JSObject event = new JSObject();
            event.put("frequency", frequency);
            event.put("rms", rms);
            event.put("confidence", confidence);
            event.put("mode", mode);
            event.put("sampleRate", sampleRate);
            event.put("source", audioSourceName);
            notifyListeners("pitch", event);
        });
    }

    private void stopCapture() {
        running.set(false);
        AudioRecord local;
        boolean stopOboe;
        synchronized (captureLock) {
            running.set(false);
            local = recorder;
            recorder = null;
            stopOboe = usingOboe;
            usingOboe = false;
        }

        if (stopOboe) {
            NativeOboeCapture.stop();
        }
        if (local != null) {
            try { local.stop(); } catch (Exception ignored) {}
            releaseRecorder(local);
        }

        Thread localWorker = worker;
        worker = null;
        if (localWorker != null && localWorker != Thread.currentThread()) {
            try { localWorker.join(350); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        }

        nativeFramesPerBurst = 0;
        nativeBufferCapacityFrames = 0;
        releasePlatformAudioEffects();
    }

    private void releaseRecorder(AudioRecord audioRecord) {
        if (audioRecord == null) return;
        try { audioRecord.release(); } catch (Exception ignored) {}
    }

    private static final class PitchResult {
        final double frequency;
        final double confidence;
        final String mode;

        PitchResult(double frequency, double confidence) {
            this(frequency, confidence, "sustained");
        }

        PitchResult(double frequency, double confidence, String mode) {
            this.frequency = frequency;
            this.confidence = confidence;
            this.mode = mode;
        }
    }


    private static final class NativeMpmDetector {
        private static final double PEAK_RATIO = 0.90;
        private static final double MINIMUM_CLARITY = 0.55;

        private final int downsample;
        private final double rate;
        private final double minFrequency;
        private final double maxFrequency;
        private final float[] samples;
        private final double[] prefixEnergy;
        private final double[] nsdf;
        private final int minTau;
        private final int maxTau;

        private final double highPassHz;

        NativeMpmDetector(int sampleRate, int inputSize, double minFrequency, double maxFrequency) {
            this(sampleRate, inputSize, minFrequency, maxFrequency, 0.0);
        }

        NativeMpmDetector(
            int sampleRate,
            int inputSize,
            double minFrequency,
            double maxFrequency,
            double highPassHz
        ) {
            this.downsample = sampleRate <= 32000 ? 1 : 2;
            this.rate = sampleRate / (double) downsample;
            this.minFrequency = minFrequency;
            this.maxFrequency = Math.min(maxFrequency, rate * 0.45);
            this.highPassHz = Math.max(0.0, highPassHz);
            int size = inputSize / downsample;
            this.samples = new float[size];
            this.prefixEnergy = new double[size + 1];
            this.minTau = Math.max(2, (int) Math.floor(rate / this.maxFrequency));
            this.maxTau = Math.min(size / 2 - 2, (int) Math.ceil(rate / this.minFrequency));
            this.nsdf = new double[Math.max(4, this.maxTau + 2)];
        }

        PitchResult detect(float[] input) {
            if (maxTau <= minTau || samples.length < 512) return null;

            double mean = 0.0;
            for (int i = 0; i < samples.length; i++) {
                double value = 0.0;
                int base = i * downsample;
                for (int j = 0; j < downsample; j++) value += input[base + j];
                samples[i] = (float) (value / downsample);
            }

            if (highPassHz > 0.0 && samples.length > 1) {
                double rc = 1.0 / (2.0 * Math.PI * highPassHz);
                double dt = 1.0 / rate;
                double alpha = rc / (rc + dt);
                double previousInput = samples[0];
                double previousOutput = 0.0;
                samples[0] = 0.0f;

                for (int i = 1; i < samples.length; i++) {
                    double currentInput = samples[i];
                    double output =
                        alpha * (previousOutput + currentInput - previousInput);
                    samples[i] = (float) output;
                    previousInput = currentInput;
                    previousOutput = output;
                }
            }

            for (int i = 0; i < samples.length; i++) {
                mean += samples[i];
            }
            mean /= samples.length;

            prefixEnergy[0] = 0.0;
            for (int i = 0; i < samples.length; i++) {
                samples[i] -= (float) mean;
                prefixEnergy[i + 1] = prefixEnergy[i] + samples[i] * samples[i];
            }
            if (prefixEnergy[samples.length] <= 1e-10) return null;

            nsdf[0] = 1.0;
            double strongest = 0.0;
            for (int tau = 1; tau <= maxTau; tau++) {
                int limit = samples.length - tau;
                double correlation = 0.0;
                for (int i = 0; i < limit; i++) correlation += samples[i] * samples[i + tau];
                double denominator = prefixEnergy[limit] + (prefixEnergy[samples.length] - prefixEnergy[tau]);
                nsdf[tau] = denominator > 1e-12
                    ? Math.max(-1.0, Math.min(1.0, 2.0 * correlation / denominator))
                    : 0.0;
            }

            for (int tau = minTau + 1; tau < maxTau; tau++) {
                if (
                    nsdf[tau] > 0.0 &&
                    nsdf[tau] >= nsdf[tau - 1] &&
                    nsdf[tau] > nsdf[tau + 1]
                ) strongest = Math.max(strongest, nsdf[tau]);
            }
            if (strongest < MINIMUM_CLARITY) return null;

            double cutoff = Math.max(MINIMUM_CLARITY, strongest * PEAK_RATIO);
            int selected = -1;
            for (int tau = minTau + 1; tau < maxTau; tau++) {
                if (
                    nsdf[tau] >= cutoff &&
                    nsdf[tau] >= nsdf[tau - 1] &&
                    nsdf[tau] > nsdf[tau + 1]
                ) {
                    selected = tau;
                    break;
                }
            }
            if (selected < 0) return null;

            double refined = selected;
            if (selected > 1 && selected < maxTau) {
                double left = nsdf[selected - 1];
                double center = nsdf[selected];
                double right = nsdf[selected + 1];
                double denominator = left - 2.0 * center + right;
                if (Math.abs(denominator) > 1e-12) {
                    double offset = 0.5 * (left - right) / denominator;
                    refined += Math.max(-1.0, Math.min(1.0, offset));
                }
            }

            double frequency = rate / refined;
            if (
                !Double.isFinite(frequency) ||
                frequency < minFrequency ||
                frequency > maxFrequency
            ) return null;
            return new PitchResult(frequency, Math.max(0.0, Math.min(1.0, nsdf[selected])), "sustained");
        }
    }


    private static final class NativeYinDetector {
        private static final double YIN_THRESHOLD = 0.15;
        private static final double WEAK_SIGNAL_THRESHOLD = 0.34;

        private final int downsample;
        private final double downsampledRate;
        private final float[] samples;
        private final double[] difference;
        private final int minTau;
        private final int maxTau;
        private final int compareLength;

        NativeYinDetector(int sampleRate, int inputSize) {
            downsample = sampleRate <= 32000 ? 2 : 4;
            downsampledRate = sampleRate / (double) downsample;
            int size = inputSize / downsample;
            samples = new float[size];
            minTau = Math.max(2, (int) Math.floor(downsampledRate / MAX_FREQUENCY));
            maxTau = Math.min(size / 2 - 2, (int) Math.ceil(downsampledRate / MIN_FREQUENCY));
            difference = new double[maxTau + 1];
            compareLength = Math.max(256, size - maxTau - 1);
        }

        PitchResult detect(float[] input) {
            double mean = 0.0;
            for (int i = 0; i < samples.length; i++) {
                float value = 0.0f;
                int base = i * downsample;
                for (int j = 0; j < downsample; j++) value += input[base + j];
                value /= downsample;
                samples[i] = value;
                mean += value;
            }
            mean /= samples.length;
            double energy = 0.0;
            double peak = 0.0;
            for (int i = 0; i < samples.length; i++) {
                samples[i] -= (float) mean;
                energy += samples[i] * samples[i];
                peak = Math.max(peak, Math.abs(samples[i]));
            }
            if (energy <= 1e-10) return null;

            // Normalize only the detector frame. The captured PCM and UI meter remain raw.
            // Detector-only normalization: enough gain for quiet notes without turning
            // broadband room noise into a strong pseudo-periodic candidate.
            // Android noise suppression, AGC and echo cancellation remain disabled.
            double frameRms = Math.sqrt(energy / samples.length);
            double rmsGain = frameRms > 0.0 ? 0.32 / frameRms : 1.0;
            double peakGain = peak > 0.0 ? 0.97 / peak : 1.0;
            double gain = Math.max(1.0, Math.min(64.0, Math.min(rmsGain, peakGain)));
            if (gain > 1.0) {
                for (int i = 0; i < samples.length; i++) samples[i] *= (float) gain;
            }

            difference[0] = 1.0;
            for (int tau = 1; tau <= maxTau; tau++) {
                double sum = 0.0;
                for (int i = 0; i < compareLength; i++) {
                    double delta = samples[i] - samples[i + tau];
                    sum += delta * delta;
                }
                difference[tau] = sum;
            }

            double runningSum = 0.0;
            for (int tau = 1; tau <= maxTau; tau++) {
                runningSum += difference[tau];
                difference[tau] = runningSum <= 0.0 ? 1.0 : difference[tau] * tau / runningSum;
            }

            int tauEstimate = -1;
            for (int tau = minTau; tau < maxTau; tau++) {
                if (difference[tau] < YIN_THRESHOLD) {
                    while (tau + 1 <= maxTau && difference[tau + 1] < difference[tau]) tau++;
                    tauEstimate = tau;
                    break;
                }
            }
            if (tauEstimate < 0) {
                // Recovery path: accept only a genuine local CMND minimum. This keeps
                // quiet musical notes available without promoting arbitrary room-noise lags.
                double bestValue = WEAK_SIGNAL_THRESHOLD;
                int bestTau = -1;
                for (int tau = Math.max(minTau + 1, 2); tau < maxTau; tau++) {
                    if (
                        difference[tau] <= difference[tau - 1] &&
                        difference[tau] < difference[tau + 1] &&
                        difference[tau] <= bestValue
                    ) {
                        bestValue = difference[tau];
                        bestTau = tau;
                    }
                }
                tauEstimate = bestTau;
            }
            if (tauEstimate < 0) return null;

            double refinedTau = tauEstimate;
            if (tauEstimate > 1 && tauEstimate < maxTau) {
                double left = difference[tauEstimate - 1];
                double center = difference[tauEstimate];
                double right = difference[tauEstimate + 1];
                double denominator = left - 2.0 * center + right;
                if (Math.abs(denominator) > 1e-12) {
                    double offset = 0.5 * (left - right) / denominator;
                    if (offset > 1.0) offset = 1.0;
                    else if (offset < -1.0) offset = -1.0;
                    refinedTau += offset;
                }
            }

            double frequency = downsampledRate / refinedTau;
            if (!Double.isFinite(frequency) || frequency < MIN_FREQUENCY || frequency > MAX_FREQUENCY) return null;
            double confidence = Math.max(0.0, Math.min(1.0, 1.0 - difference[tauEstimate]));
            return new PitchResult(frequency, confidence);
        }
    }
}
