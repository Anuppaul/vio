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
    private static final int ANALYSIS_SIZE = 32768;
    private static final int HOP_SIZE = 4096;
    private static final int CHUNK_SIZE = 1024;
    private static final double MIN_FREQUENCY = 30.0;
    private static final double MAX_FREQUENCY = 3300.0;

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
        NativeYinDetector detector = new NativeYinDetector(sampleRate, ANALYSIS_SIZE);

        int write = 0;
        int filled = 0;
        int sinceAnalysis = 0;

        while (running.get()) {
            int count;
            try {
                count = local.read(chunk, 0, chunk.length, AudioRecord.READ_BLOCKING);
            } catch (Exception error) {
                break;
            }
            if (count <= 0) {
                if (count == AudioRecord.ERROR_DEAD_OBJECT || count == AudioRecord.ERROR_INVALID_OPERATION) break;
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
            PitchResult pitch = detector.detect(frame);
            emitPitch(pitch, rms);
        }
    }

    private double rms(float[] frame) {
        double sum = 0.0;
        for (float sample : frame) sum += sample * sample;
        return Math.sqrt(sum / frame.length);
    }

    private void emitPitch(PitchResult pitch, double rms) {
        final double frequency = pitch == null ? 0.0 : pitch.frequency;
        final double confidence = pitch == null ? 0.0 : pitch.confidence;
        mainHandler.post(() -> {
            if (!running.get()) return;
            JSObject event = new JSObject();
            event.put("frequency", frequency);
            event.put("rms", rms);
            event.put("confidence", confidence);
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

        PitchResult(double frequency, double confidence) {
            this.frequency = frequency;
            this.confidence = confidence;
        }
    }

    private static final class NativeYinDetector {
        private static final int DOWNSAMPLE = 4;
        private static final double YIN_THRESHOLD = 0.25;
        private static final double WEAK_SIGNAL_THRESHOLD = 0.65;

        private final double downsampledRate;
        private final float[] samples;
        private final double[] difference;
        private final int minTau;
        private final int maxTau;
        private final int compareLength;

        NativeYinDetector(int sampleRate, int inputSize) {
            downsampledRate = sampleRate / (double) DOWNSAMPLE;
            int size = inputSize / DOWNSAMPLE;
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
                int base = i * DOWNSAMPLE;
                for (int j = 0; j < DOWNSAMPLE; j++) value += input[base + j];
                value /= DOWNSAMPLE;
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
            // Far-field mode uses more analysis gain for quiet sustained notes; it still
            // does not enable noise suppression, AGC, echo cancellation or pitch smoothing.
            double frameRms = Math.sqrt(energy / samples.length);
            double rmsGain = frameRms > 0.0 ? 0.30 / frameRms : 1.0;
            double peakGain = peak > 0.0 ? 0.92 / peak : 1.0;
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
                // Far-field recovery: search all genuine local minima and choose the
                // strongest periodic candidate. Broadband room noise normally has no
                // sufficiently deep, stable local minimum in the playable range.
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
