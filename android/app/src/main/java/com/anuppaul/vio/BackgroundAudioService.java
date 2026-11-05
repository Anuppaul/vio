package com.anuppaul.vio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

/**
 * User-initiated, offline mediaPlayback foreground service.
 * The audio renderer lives outside the Activity/WebView so screen-off and
 * document navigation cannot suspend a running drone or metronome.
 *
 * No permanent screen-on flag and no ongoing JavaScript/Rust render timer.
 */
public class BackgroundAudioService extends Service {
    public static final String ACTION_PLAY = "com.anuppaul.vio.bg.PLAY";
    public static final String ACTION_STOP = "com.anuppaul.vio.bg.STOP";
    public static final String ACTION_PAUSE = "com.anuppaul.vio.bg.PAUSE";
    public static final String ACTION_RESUME = "com.anuppaul.vio.bg.RESUME";
    public static final String ACTION_VOLUME = "com.anuppaul.vio.bg.VOLUME";

    private static final String CHANNEL = "vio_background_playback";
    private static final int NOTIFICATION = 2107;
    private static final int RATE = 48000;
    private static final String[] NOTE_NAMES =
        {"C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"};

    private static volatile String mode = "none";
    private static volatile boolean playing = false;
    private static volatile String pattern = "sa-pa";
    private static volatile String key = "C";
    private static volatile String sound = "click";
    private static volatile String tone = "natural";
    private static volatile int bpm = 120;
    private static volatile int beats = 4;
    private static volatile int subdivision = 1;
    private static volatile int midi = 69;
    private static volatile boolean accent = true;
    private static volatile boolean loop = true;
    private static volatile double volume = 0.6;
    private static volatile String error = "";

    public static JSObject snapshot() {
        JSObject value = new JSObject();
        value.put("mode", mode);
        value.put("playing", playing);
        value.put("pattern", pattern);
        value.put("key", key);
        value.put("sound", sound);
        value.put("tone", tone);
        value.put("bpm", bpm);
        value.put("beats", beats);
        value.put("subdivision", subdivision);
        value.put("midi", midi);
        value.put("accent", accent);
        value.put("loop", loop);
        value.put("volume", volume);
        value.put("error", error);
        return value;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private MediaSession mediaSession;
    private MediaPlayer mediaPlayer;
    private PcmPlayback pcmPlayback;
    private PowerManager.WakeLock wakeLock;
    private boolean pausedByFocus = false;

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        handler.post(() -> {
            if (change == AudioManager.AUDIOFOCUS_LOSS) {
                stopEverything();
                stopSelf();
            } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
                       change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                pausedByFocus = playing;
                pausePlayback();
            } else if (change == AudioManager.AUDIOFOCUS_GAIN && pausedByFocus) {
                pausedByFocus = false;
                resumePlayback();
            }
        });
    };

    @Override
    public void onCreate() {
        super.onCreate();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        // A new service instance has no live player. Clear old version's
        // extracted MP3s so APK updates cannot reuse stale sound samples.
        File cacheDir = new File(getCacheDir(), "vio-offline-media");
        File[] oldFiles = cacheDir.listFiles();
        if (oldFiles != null) for (File file : oldFiles) if (file.isFile()) file.delete();
        createChannel();
        mediaSession = new MediaSession(this, "vio-practice-audio");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { handler.post(() -> resumePlayback()); }
            @Override public void onPause() { handler.post(() -> pausePlayback()); }
            @Override public void onStop() { handler.post(() -> { stopEverything(); stopSelf(); }); }
        });
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopEverything();
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopEverything();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            pausePlayback();
            return START_NOT_STICKY;
        }
        if (ACTION_RESUME.equals(action)) {
            resumePlayback();
            return START_NOT_STICKY;
        }
        if (ACTION_VOLUME.equals(action)) {
            if ("none".equals(mode)) { stopSelf(); return START_NOT_STICKY; }
            volume = bounded(intent.getDoubleExtra("volume", volume), 0, 1);
            if (mediaPlayer != null) mediaPlayer.setVolume((float)volume, (float)volume);
            if (pcmPlayback != null) pcmPlayback.playbackVolume = volume;
            updateNotification();
            return START_NOT_STICKY;
        }
        if (!ACTION_PLAY.equals(action)) { stopSelf(); return START_NOT_STICKY; }

        // Promote immediately: Android requires this within a few seconds of
        // ContextCompat.startForegroundService, before decoding any asset.
        setForeground(buildNotification());
        stopRenderers();
        error = "";
        String selected = intent.getStringExtra("mode");
        try {
            if (!requestFocus()) throw new IllegalStateException("Audio focus unavailable");
            volume = bounded(intent.getDoubleExtra("volume", 0.6), 0, 1);
            if ("tanpura".equals(selected)) {
                pattern = intent.getStringExtra("pattern");
                key = intent.getStringExtra("key");
                if (!("sa-pa".equals(pattern) || "sa-ma".equals(pattern))) throw new IllegalArgumentException("Bad pattern");
                if (!validKey(key)) throw new IllegalArgumentException("Bad key");
                mode = selected;
                playMedia("tanpura/" + pattern + "_" + key.replace("#", "s") + ".mp3", true);
            } else if ("ear".equals(selected)) {
                mode = selected;
                midi = boundedInt(intent.getIntExtra("midi", 69), 36, 96);
                tone = "beep".equals(intent.getStringExtra("tone")) ? "beep" : "natural";
                loop = intent.getBooleanExtra("loop", true);
                if ("beep".equals(tone)) {
                    startPcm();
                } else {
                    int octave = midi / 12 - 1;
                    String label = NOTE_NAMES[midi % 12] + octave;
                    try { playMedia("ear/" + label + ".mp3", loop); }
                    catch (Exception missingSample) {
                        // A missing note file must not leave behind a partially
                        // initialized MediaPlayer when we switch to oscillator.
                        if (mediaPlayer != null) {
                            try { mediaPlayer.release(); } catch (Exception ignored) {}
                            mediaPlayer = null;
                        }
                        tone = "beep";
                        startPcm();
                    }
                }
            } else if ("metronome".equals(selected)) {
                mode = selected;
                bpm = boundedInt(intent.getIntExtra("bpm", 120), 1, 300);
                beats = boundedInt(intent.getIntExtra("beats", 4), 1, 7);
                subdivision = boundedInt(intent.getIntExtra("subdivision", 1), 1, 4);
                sound = intent.getStringExtra("sound");
                if (!("click".equals(sound) || "tabla".equals(sound) || "drum".equals(sound)))
                    throw new IllegalArgumentException("Bad sound");
                accent = intent.getBooleanExtra("accent", true);
                startPcm();
            } else throw new IllegalArgumentException("Unknown playback mode");
            playing = true;
            pausedByFocus = false;
            updateNotification();
        } catch (Exception failure) {
            error = failure.getMessage() == null ? failure.toString() : failure.getMessage();
            stopEverything();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private static int boundedInt(int value, int lo, int hi) {
        return Math.max(lo, Math.min(hi, value));
    }
    private static double bounded(double value, double lo, double hi) {
        return Double.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : lo;
    }
    private static boolean validKey(String value) {
        if (value == null) return false;
        for (String name : new String[]{"C","C#","D","D#","E","F","F#","G","G#","A","A#","B"})
            if (name.equals(value)) return true;
        return false;
    }
    private boolean requestFocus() {
        if (audioManager == null) return false;
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(focusListener)
                .build();
            return audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
        return audioManager.requestAudioFocus(focusListener,
            AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }
    private void abandonFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
    }

    private void playMedia(String name, boolean repeat) throws Exception {
        // AssetManager.open works whether AAPT compressed the MP3 or not.
        // Only whitelisted built-in paths reach here. No downloads or network.
        File dir = new File(getCacheDir(), "vio-offline-media");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Cannot create media cache");
        File target = new File(dir, name.replace('/', '_'));
        if (!target.exists() || target.length() == 0) {
            try (InputStream src = getAssets().open("public/assets/" + name);
                 FileOutputStream dst = new FileOutputStream(target)) {
                byte[] block = new byte[16 * 1024];
                int read;
                while ((read = src.read(block)) >= 0) if (read > 0) dst.write(block, 0, read);
            }
        }
        mediaPlayer = new MediaPlayer();
        mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
        mediaPlayer.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
        mediaPlayer.setDataSource(target.getAbsolutePath());
        mediaPlayer.setLooping(repeat);
        mediaPlayer.setVolume((float)volume, (float)volume);
        mediaPlayer.setOnCompletionListener(mp -> {
            if (!mp.isLooping()) { stopEverything(); stopSelf(); }
        });
        mediaPlayer.setOnErrorListener((mp, what, extra) -> {
            error = "Decoder error " + what;
            stopEverything();
            stopSelf();
            return true;
        });
        mediaPlayer.prepare();
        mediaPlayer.start();
    }

    private void startPcm() {
        pcmPlayback = new PcmPlayback("metronome".equals(mode), midi, loop, bpm, beats,
            subdivision, sound, accent, volume);
        pcmPlayback.start();
    }
    private void acquireWake() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vio:foregroundPlayback");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }
    private void releaseWake() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void pausePlayback() {
        if (!playing) return;
        playing = false;
        if (mediaPlayer != null) {
            try { mediaPlayer.pause(); } catch (Exception ignored) {}
        }
        if (pcmPlayback != null) {
            pcmPlayback.stop();
            pcmPlayback = null;
            releaseWake();
        }
        updateNotification();
    }
    private void resumePlayback() {
        if ("none".equals(mode) || playing) return;
        if (!requestFocus()) return;
        try {
            if (mediaPlayer != null) mediaPlayer.start();
            else startPcm();
            playing = true;
            updateNotification();
        } catch (Exception badPlayback) {
            error = badPlayback.toString();
            stopEverything();
            stopSelf();
        }
    }
    private void stopRenderers() {
        if (mediaPlayer != null) {
            try { mediaPlayer.setOnCompletionListener(null); mediaPlayer.stop(); } catch (Exception ignored) {}
            try { mediaPlayer.release(); } catch (Exception ignored) {}
            mediaPlayer = null;
        }
        if (pcmPlayback != null) {
            pcmPlayback.stop();
            pcmPlayback = null;
        }
        releaseWake();
        playing = false;
    }
    private void stopEverything() {
        stopRenderers();
        abandonFocus();
        mode = "none";
        playing = false;
        pausedByFocus = false;
        updateMediaSession();
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "VIO practice audio",
            NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Screen-off Tanpura, Ear Tuner and Metronome playback");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }
    private PendingIntent actionIntent(String action, int requestCode) {
        Intent intent = new Intent(this, BackgroundAudioService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification buildNotification() {
        String detail;
        if ("tanpura".equals(mode)) detail = "Tanpura " + pattern + " · " + key;
        else if ("metronome".equals(mode)) detail = "Metronome · " + bpm + " BPM · " + sound;
        else if ("ear".equals(mode)) detail = "Ear Tuner · " + NOTE_NAMES[midi % 12] + (midi / 12 - 1);
        else detail = "Practice audio";
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launch = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("VIO · " + detail)
            .setContentText(playing ? "Playing with the screen off" : "Paused")
            .setContentIntent(launch)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (!"none".equals(mode)) {
            builder.addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play",
                actionIntent(playing ? ACTION_PAUSE : ACTION_RESUME, 1));
        }
        builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop",
            actionIntent(ACTION_STOP, 2));
        return builder.build();
    }
    private void setForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else startForeground(NOTIFICATION, notification);
    }
    private void updateMediaSession() {
        if (mediaSession == null) return;
        int state = "none".equals(mode) ? PlaybackState.STATE_STOPPED :
            (playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED);
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_STOP)
            .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
            .build());
        mediaSession.setMetadata(new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE,
                "tanpura".equals(mode) ? "Tanpura · " + key :
                "metronome".equals(mode) ? "Metronome · " + bpm + " BPM" : "Ear Tuner")
            .putString(MediaMetadata.METADATA_KEY_ARTIST, "VIO").build());
    }
    private void updateNotification() {
        updateMediaSession();
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION, buildNotification());
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // A foreground playback session is user-initiated: swiping the activity
        // from Recents must not silently stop a running practice drone.
        if (!playing) { stopEverything(); stopSelf(); }
        super.onTaskRemoved(rootIntent);
    }
    @Override
    public void onDestroy() {
        stopEverything();
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); mediaSession = null; }
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }

    private static final class Voice {
        final float[] data;
        final float level;
        int position = 0;
        Voice(float[] data, float level) { this.data = data; this.level = level; }
    }

    private class PcmPlayback implements Runnable {
        final boolean metronome;
        final int note, meter, subdivisionCount, tempo;
        final boolean looping, accented;
        final String kit;
        volatile double playbackVolume;
        final Map<String, float[]> sampleCache = new HashMap<>();
        final ArrayList<Voice> voices = new ArrayList<>();
        volatile boolean active = true;
        Thread thread;
        AudioTrack track;
        long frames = 0;
        long steps = 0;
        double nextBeat = 0;

        PcmPlayback(boolean metronome, int note, boolean looping, int bpm, int beats,
                    int subdivision, String kit, boolean accent, double volume) {
            this.metronome = metronome; this.note = note; this.looping = looping;
            this.tempo = bpm; this.meter = beats; this.subdivisionCount = subdivision;
            this.kit = kit; this.accented = accent; this.playbackVolume = volume;
        }
        void start() {
            int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) throw new IllegalStateException("No PCM output device");
            int buffer = Math.max(min, 4096 * 2);
            track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder()
                    .setSampleRate(RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(buffer)
                .build();
            if (track.getState() != AudioTrack.STATE_INITIALIZED) {
                try { track.release(); } catch (Exception ignored) {}
                track = null;
                throw new IllegalStateException("AudioTrack not initialized");
            }
            acquireWake();
            try {
                track.play();
            } catch (RuntimeException failure) {
                try { track.release(); } catch (Exception ignored) {}
                track = null;
                releaseWake();
                throw failure;
            }
            thread = new Thread(this, "vio-screen-off-pcm");
            thread.setDaemon(true);
            thread.start();
        }
        void stop() {
            active = false;
            if (track != null) {
                try { track.pause(); track.flush(); } catch (Exception ignored) {}
                // If initialization failed before worker thread creation, the
                // worker cannot release the AudioTrack in its finally block.
                if (thread == null) {
                    try { track.release(); } catch (Exception ignored) {}
                    track = null;
                }
            }
            if (thread != null) thread.interrupt();
        }
        @Override public void run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
            final short[] chunk = new short[1024];
            final double stepSamples = (double)RATE * 60.0 / (double)(tempo * subdivisionCount);
            final double toneFreq = 440.0 * Math.pow(2.0, (note - 69) / 12.0);
            try {
                while (active) {
                    int count = 0;
                    for (; count < chunk.length; count++) {
                        float sample;
                        if (metronome) {
                            while (frames >= nextBeat) {
                                scheduleBeat();
                                steps++;
                                nextBeat += stepSamples;
                            }
                            sample = mixVoices();
                        } else {
                            long limit = looping ? Long.MAX_VALUE : RATE * 2L;
                            if (frames >= limit) { active = false; break; }
                            double phase = 2.0 * Math.PI * toneFreq * ((double)frames / RATE);
                            double fade = looping ? 1.0 : Math.min(1.0, (limit - frames) / (double)(RATE / 20));
                            sample = (float)(Math.sin(phase) * .20 * fade);
                        }
                        chunk[count] = (short)(Math.max(-1f, Math.min(1f, sample * playbackVolume)) * 32767);
                        frames++;
                    }
                    if (count > 0 && active) {
                        int written = track.write(chunk, 0, count, AudioTrack.WRITE_BLOCKING);
                        if (written <= 0) break;
                    }
                    if (!active) break;
                }
            } catch (Exception ignored) {
                // Audio route changed / unplugged / device revoked output.
            } finally {
                try { track.stop(); } catch (Exception ignored) {}
                try { track.release(); } catch (Exception ignored) {}
                handler.post(() -> {
                    if (pcmPlayback == this && active) {
                        error = "Audio output stopped";
                        stopEverything();
                        stopSelf();
                    } else if (pcmPlayback == this && !metronome && !looping) {
                        stopEverything();
                        stopSelf();
                    }
                });
            }
        }
        private void scheduleBeat() {
            int sub = (int)(steps % subdivisionCount);
            int beat = (int)((steps / subdivisionCount) % meter);
            boolean down = beat == 0 && sub == 0;
            String name;
            float level;
            if ("tabla".equals(kit)) {
                name = sub != 0 ? "tabla-tin" : (down ? "tabla-ge" : (beat % 2 == 0 ? "tabla-tin" : "tabla-na"));
                level = down ? 1.0f : (sub != 0 ? .32f : .85f);
            } else if ("drum".equals(kit)) {
                name = sub != 0 ? "drum-hihat" : (down || beat % 2 == 0 ? "drum-kick" : "drum-snare");
                level = down ? 1f : (sub != 0 ? .35f : .85f);
            } else {
                name = down && accented ? "click-accent" : "click";
                level = sub != 0 ? .22f : (down && accented ? 1f : .82f);
            }
            float[] samples = sampleCache.get(name);
            if (samples == null) {
                samples = readSample(name);
                sampleCache.put(name, samples);
            }
            voices.add(new Voice(samples, level));
        }
        private float mixVoices() {
            float sum = 0;
            for (Iterator<Voice> iter = voices.iterator(); iter.hasNext();) {
                Voice voice = iter.next();
                if (voice.position >= voice.data.length) { iter.remove(); continue; }
                sum += voice.data[voice.position++] * voice.level;
            }
            return Math.max(-1f, Math.min(1f, sum));
        }
        private float[] readSample(String name) {
            try (InputStream input = getAssets().open("public/assets/metronome/" + name + ".wav");
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] block = new byte[4096]; int n;
                while ((n = input.read(block)) > 0) output.write(block, 0, n);
                byte[] wave = output.toByteArray();
                ByteBuffer bb = ByteBuffer.wrap(wave).order(ByteOrder.LITTLE_ENDIAN);
                if (wave.length < 44 || !"RIFF".equals(new String(wave, 0, 4, StandardCharsets.US_ASCII)))
                    return syntheticClick();
                int channels = 0, sampleRate = 0, bits = 0, format = 0, offset = -1, bytes = 0;
                int pos = 12;
                while (pos + 8 <= wave.length) {
                    String nameChunk = new String(wave, pos, 4, StandardCharsets.US_ASCII);
                    long length = ((long)bb.getInt(pos + 4)) & 0xffffffffL;
                    int next = (int)Math.min((long)wave.length, (long)pos + 8L + length);
                    if (next <= pos || next > wave.length) break;
                    if ("fmt ".equals(nameChunk) && length >= 16) {
                        format = bb.getShort(pos + 8) & 0xffff;
                        channels = bb.getShort(pos + 10) & 0xffff;
                        sampleRate = bb.getInt(pos + 12);
                        bits = bb.getShort(pos + 22) & 0xffff;
                    }
                    if ("data".equals(nameChunk)) { offset = pos + 8; bytes = (int)Math.min(length, wave.length - offset); }
                    pos = next + (next < wave.length && (length & 1) != 0 ? 1 : 0);
                }
                if (format != 1 || bits != 16 || channels < 1 || channels > 2 ||
                    sampleRate < 8000 || sampleRate > 192000 || offset < 0 || bytes <= 0)
                    return syntheticClick();
                int count = Math.min(200000, bytes / (channels * 2));
                float[] raw = new float[count];
                for (int i = 0; i < count; i++) {
                    float sum = 0;
                    for (int ch = 0; ch < channels; ch++) {
                        sum += bb.getShort(offset + (i * channels + ch) * 2) / 32768.0f;
                    }
                    raw[i] = sum / channels;
                }
                int length = Math.max(1, (int)Math.round((double)count * RATE / sampleRate));
                float[] resampled = new float[length];
                double ratio = (double)sampleRate / RATE;
                for (int i = 0; i < length; i++) {
                    double at = i * ratio;
                    int j = (int)at;
                    if (j >= raw.length - 1) resampled[i] = raw[raw.length - 1];
                    else resampled[i] = (float)(raw[j] * (1 - (at - j)) + raw[j + 1] * (at - j));
                }
                return resampled;
            } catch (Exception ignored) {
                return syntheticClick();
            }
        }
        private float[] syntheticClick() {
            float[] data = new float[RATE / 25];
            for (int i = 0; i < data.length; i++) {
                double t = (double)i / RATE;
                data[i] = (float)(Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-125 * t) * .5);
            }
            return data;
        }
    }
}
