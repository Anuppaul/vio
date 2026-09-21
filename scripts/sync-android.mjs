import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

function cap(...args) {
  const result=spawnSync(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', ...args], {stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
const config=JSON.parse(await readFile('capacitor.config.json','utf8'));
const pkg=JSON.parse(await readFile('package.json','utf8'));
await access('out/native-build.json');
try{await access('android/app/build.gradle')}catch{cap('add','android')}
cap('sync','android');

const manifestPath='android/app/src/main/AndroidManifest.xml';
let manifest=await readFile(manifestPath,'utf8');
for(const permission of ['RECORD_AUDIO','MODIFY_AUDIO_SETTINGS']) {
  if(!manifest.includes(`android.permission.${permission}`)) {
    manifest=manifest.replace('</manifest>',`    <uses-permission android:name="android.permission.${permission}" />\n</manifest>`);
  }
}
if(!manifest.includes('android.hardware.microphone')) manifest=manifest.replace('</manifest>','    <uses-feature android:name="android.hardware.microphone" android:required="false" />\n</manifest>');
manifest=manifest.replace('android:allowBackup="true"','android:allowBackup="false"');
await writeFile(manifestPath,manifest);

const mainDir=join('android/app/src/main/java',...config.appId.split('.'));
await mkdir(mainDir,{recursive:true});
await writeFile(join(mainDir,'MainActivity.java'),`package ${config.appId};

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.net.Uri;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
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
`);

// The checked-in Gradle overlay uses environment variables, never key material.
const gradlePath='android/app/build.gradle';
let gradle=await readFile(gradlePath,'utf8');
if(!gradle.includes("apply from: '../../scripts/android-release.gradle'"))gradle+="\napply from: '../../scripts/android-release.gradle'\n";
await writeFile(gradlePath,gradle);
await chmod('android/gradlew',0o755);

// Generate real density-specific icons from the user's existing canonical PNG.
const res='android/app/src/main/res';
const densities={mdpi:1,hdpi:1.5,xhdpi:2,xxhdpi:3,xxxhdpi:4};
for(const [name,scale] of Object.entries(densities)) {
  const dir=join(res,`mipmap-${name}`);await mkdir(dir,{recursive:true});
  const size=Math.round(48*scale),image=await sharp('app/icon.png').resize(size,size,{fit:'contain',background:'#f8f9fd'}).png().toBuffer();
  await writeFile(join(dir,'ic_launcher.png'),image);
  await writeFile(join(dir,'ic_launcher_round.png'),image);
  const canvas=Math.round(108*scale),art=Math.round(64*scale);
  const foreground=await sharp('app/icon.png').resize(art,art,{fit:'contain',background:'#f8f9fd'}).png().toBuffer();
  await sharp({create:{width:canvas,height:canvas,channels:4,background:'#f8f9fd'}}).composite([{input:foreground,gravity:'centre'}]).png().toFile(join(dir,'ic_launcher_foreground.png'));
}
const adaptive=join(res,'mipmap-anydpi-v26');await mkdir(adaptive,{recursive:true});
const adaptiveXml='<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/vio_launcher_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>\n';
for(const file of ['ic_launcher.xml','ic_launcher_round.xml'])await writeFile(join(adaptive,file),adaptiveXml);
await writeFile(join(res,'values/vio_colors.xml'),'<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="vio_launcher_background">#f8f9fd</color></resources>\n');
console.log(`Android configured: ${config.appId}, VIO ${pkg.version}, microphone permission, local navigation, launcher icons.`);
