package com.anuppaul.vio;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.net.Uri;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(NativePitchPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getBridge().getWebView().setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                Uri origin = request.getOrigin();
                if (!"https".equals(origin.getScheme()) || !"localhost".equals(origin.getHost())) {
                    request.deny();
                    return;
                }
                for (String resource : request.getResources()) {
                    if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        request.deny();
                        return;
                    }
                }
                // Capacitor requests the Android runtime microphone permission.
                super.onPermissionRequest(request);
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge().getWebView().canGoBack()) getBridge().getWebView().goBack();
                else finish();
            }
        });
    }
}
