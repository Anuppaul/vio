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

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

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
    private static final int HOP_SIZE = 1024;
    private static final int CHUNK_SIZE = 512;
    private static final double MIN_FREQUENCY = 20.0;
    private static final double MAX_FREQUENCY = 5000.0;
    private static final double MIN_SUSTAINED_CONFIDENCE = 0.64;
    private static final double MIN_TRANSIENT_CONFIDENCE = 0.56;
    private static final long DROPOUT_HOLD_NS = 150_000_000L;
    
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
    private PitchResult lastAcceptedPitch;
    private long lastAcceptedPitchAt;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission is required.");
            return;
        }

        synchronized (captureLock) {
            if (running.get() && recorder != null) {
                JSObject current = new JSObject();
                current.put("sampleRate", sampleRate);
                current.put("source", audioSourceName);
                call.resolve(current);
                return;
            }

            AudioRecord created = createRecorder();
            if (created == null) {
                call.reject("Unable to initialize native microphone capture.");
                return;
            }

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
            worker = new Thread(this::captureLoop, "vio-native-pitch");
            worker.setDaemon(true);
            worker.start();

            JSObject result = new JSObject();
            result.put("sampleRate", sampleRate);
            result.put("source", audioSourceName);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopCapture();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture();
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
        AudioRecord local = recorder;
        if (local == null) return;

        short[] chunk = new short[CHUNK_SIZE];
        float[] ring = new float[ANALYSIS_SIZE];
        float[] frame = new float[ANALYSIS_SIZE];
        float[] shortFrame = new float[SHORT_ANALYSIS_SIZE];
        NativeYinDetector sustainedDetector = new NativeYinDetector(sampleRate, ANALYSIS_SIZE);
        NativeYinDetector transientDetector = new NativeYinDetector(sampleRate, SHORT_ANALYSIS_SIZE);


        int write = 0;
        int filled = 0;
        int sinceAnalysis = 0;

        String failureMessage = null;
        while (running.get()) {
            int count;
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

            for (int i = 0; i < count; i++) {
                ring[write] = chunk[i] / 32768.0f;
                write++;
                if (write == ANALYSIS_SIZE) write = 0;
            }
            filled = Math.min(ANALYSIS_SIZE, filled + count);
            sinceAnalysis += count;
            if (filled < ANALYSIS_SIZE || sinceAnalysis < HOP_SIZE) continue;
            sinceAnalysis = 0;

            int tail = ANALYSIS_SIZE - write;
            System.arraycopy(ring, write, frame, 0, tail);
            if (write > 0) System.arraycopy(ring, 0, frame, tail, write);

            double rms = rms(frame);
            System.arraycopy(frame, ANALYSIS_SIZE - SHORT_ANALYSIS_SIZE, shortFrame, 0, SHORT_ANALYSIS_SIZE);

            PitchResult sustainedPitch = sustainedDetector.detect(frame);
            PitchResult transientPitch = transientDetector.detect(shortFrame);

            double recentRms = rmsRange(frame, ANALYSIS_SIZE - 1024, ANALYSIS_SIZE);
            double previousRms = rmsRange(frame, ANALYSIS_SIZE - 3072, ANALYSIS_SIZE - 1024);
            boolean onset = recentRms > Math.max(previousRms * 1.18, previousRms + 0.00018);

            PitchResult pitch = chooseHybridPitch(sustainedPitch, transientPitch, onset);
            emitPitch(acceptPitch(pitch, System.nanoTime()), rms);
        }

        if (failureMessage != null && running.compareAndSet(true, false)) {
            synchronized (captureLock) {
                if (recorder == local) recorder = null;
            }
            try { local.stop(); } catch (Exception ignored) {}
            releaseRecorder(local);
            releasePlatformAudioEffects();
            emitCaptureError(failureMessage);
        }
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

    private PitchResult acceptPitch(PitchResult pitch, long now) {
        if (pitch != null) {
            double threshold = "transient".equals(pitch.mode)
                ? MIN_TRANSIENT_CONFIDENCE
                : MIN_SUSTAINED_CONFIDENCE;
            if (pitch.confidence >= threshold) {
                lastAcceptedPitch = pitch;
                lastAcceptedPitchAt = now;
                return pitch;
            }
        }

        if (lastAcceptedPitch != null && now - lastAcceptedPitchAt <= DROPOUT_HOLD_NS) {
            return new PitchResult(
                lastAcceptedPitch.frequency,
                Math.max(0.0, lastAcceptedPitch.confidence * 0.78),
                lastAcceptedPitch.mode
            );
        }
        lastAcceptedPitch = null;
        lastAcceptedPitchAt = 0L;
        return null;
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
        synchronized (captureLock) {
            local = recorder;
            recorder = null;
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
