package com.caicnc.tool3d;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // In-app camera (www/js/capture): the preview <video> starts from getUserMedia without an extra tap.
        // Camera permission itself is handled by Capacitor's BridgeWebChromeClient.onPermissionRequest
        // (asks for android.permission.CAMERA, then grants the WebView's video-capture request), and
        // <input capture=environment> (native camera app) by its onShowFileChooser + the FileProvider below.
        WebSettings s = getBridge().getWebView().getSettings();
        s.setMediaPlaybackRequiresUserGesture(false);
    }
}
