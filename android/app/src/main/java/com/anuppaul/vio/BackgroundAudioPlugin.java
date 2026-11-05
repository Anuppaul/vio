package com.anuppaul.vio;

import android.content.Intent;
import android.os.Build;
import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Minimal Capacitor bridge: commands do not depend on WebView timers. */
@CapacitorPlugin(
    name = "BackgroundAudio",
    permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})}
)
public class BackgroundAudioPlugin extends Plugin {
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            notificationPermissionCallback(call);
        } else {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
        }
    }

    @PermissionCallback
    public void notificationPermissionCallback(PluginCall call) {
        JSObject response = new JSObject();
        response.put("granted", Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED);
        call.resolve(response);
    }

    @PluginMethod
    public void playTanpura(PluginCall call) {
        String pattern = call.getString("pattern", "sa-pa");
        String key = call.getString("key", "C");
        if (!("sa-pa".equals(pattern) || "sa-ma".equals(pattern)) || !validKey(key)) {
            call.reject("Invalid Tanpura key or pattern");
            return;
        }
        Intent intent = command(BackgroundAudioService.ACTION_PLAY)
            .putExtra("mode", "tanpura")
            .putExtra("pattern", pattern)
            .putExtra("key", key)
            .putExtra("volume", call.getData().optDouble("volume", 0.6));
        send(intent, true, call);
    }

    @PluginMethod
    public void playMetronome(PluginCall call) {
        int bpm = call.getData().optInt("bpm", 120);
        int beats = call.getData().optInt("beats", 4);
        int subdivision = call.getData().optInt("subdivision", 1);
        String sound = call.getString("sound", "click");
        if (bpm < 1 || bpm > 300 || beats < 1 || beats > 7 ||
            subdivision < 1 || subdivision > 4 ||
            !("click".equals(sound) || "tabla".equals(sound) || "drum".equals(sound))) {
            call.reject("Invalid Metronome configuration");
            return;
        }
        Intent intent = command(BackgroundAudioService.ACTION_PLAY)
            .putExtra("mode", "metronome")
            .putExtra("bpm", bpm)
            .putExtra("beats", beats)
            .putExtra("subdivision", subdivision)
            .putExtra("sound", sound)
            .putExtra("accent", call.getData().optBoolean("accent", true))
            .putExtra("volume", call.getData().optDouble("volume", 0.9));
        send(intent, true, call);
    }

    @PluginMethod
    public void playEar(PluginCall call) {
        int midi = call.getData().optInt("midi", 69);
        if (midi < 36 || midi > 96) {
            call.reject("Invalid Ear Tuner note");
            return;
        }
        Intent intent = command(BackgroundAudioService.ACTION_PLAY)
            .putExtra("mode", "ear")
            .putExtra("midi", midi)
            .putExtra("tone", call.getString("tone", "natural"))
            .putExtra("loop", call.getData().optBoolean("loop", true))
            .putExtra("volume", call.getData().optDouble("volume", 0.7));
        send(intent, true, call);
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Intent intent = command(BackgroundAudioService.ACTION_VOLUME)
            .putExtra("volume", call.getData().optDouble("volume", 0.6));
        send(intent, false, call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        send(command(BackgroundAudioService.ACTION_STOP), false, call);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(BackgroundAudioService.snapshot());
    }

    private Intent command(String action) {
        return new Intent(getContext(), BackgroundAudioService.class).setAction(action);
    }
    private void send(Intent intent, boolean foregroundStart, PluginCall call) {
        try {
            if (foregroundStart) ContextCompat.startForegroundService(getContext(), intent);
            else getContext().startService(intent);
            JSObject result = new JSObject();
            result.put("dispatched", true);
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Unable to start background audio: " + exception.getMessage(), exception);
        }
    }
    private static boolean validKey(String key) {
        if (key == null) return false;
        for (String name : new String[]{"C","C#","D","D#","E","F","F#","G","G#","A","A#","B"}) {
            if (name.equals(key)) return true;
        }
        return false;
    }
}
