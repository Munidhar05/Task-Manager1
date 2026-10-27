package io.smarttask.app;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// The web app's handle on the native ring (client/src/lib/nativeCall.ts). The
// web side owns the call itself — WebRTC, the server lifecycle — and this only
// does what a WebView cannot: ring over the lock screen, and say when the user
// picked up from outside the app.
@CapacitorPlugin(name = "CallRing")
public class CallRingPlugin extends Plugin {

    private static CallRingPlugin instance;
    // An Answer that cold-started the app, waiting for the page to ask. Only a
    // cold start lands here; a running app gets the callAction event instead,
    // so one Answer can never reach the page twice.
    private static JSObject pending;

    @Override
    public void load() { instance = this; }

    @Override
    protected void handleOnDestroy() { if (instance == this) instance = null; }

    static synchronized void deliverAnswer(JSObject action, boolean coldStart) {
        if (coldStart || instance == null) { pending = action; return; }
        // Retained so a page that is mid-reload when the Answer lands still gets it.
        instance.notifyListeners("callAction", action, true);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        CallRinger.saveApiBase(getContext(), call.getString("apiBase", ""));
        call.resolve();
    }

    @PluginMethod
    public void showIncoming(PluginCall call) {
        boolean shown = CallRinger.show(getContext(), CallRinger.fromJson(call.getData()));
        call.resolve(new JSObject().put("shown", shown));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        CallRinger.cancel(getContext(), call.getString("call_id"));
        call.resolve();
    }

    @PluginMethod
    public void getPendingAction(PluginCall call) {
        JSObject p;
        synchronized (CallRingPlugin.class) { p = pending; pending = null; }
        call.resolve(p != null ? p : new JSObject());
    }

    @PluginMethod
    public void callUiDone(PluginCall call) {
        Activity a = getActivity();
        if (a instanceof MainActivity) a.runOnUiThread(() -> ((MainActivity) a).releaseLockScreen());
        call.resolve();
    }

    @PluginMethod
    public void fullScreenStatus(PluginCall call) {
        boolean allowed = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            allowed = nm == null || nm.canUseFullScreenIntent();
        }
        call.resolve(new JSObject().put("allowed", allowed));
    }

    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        String pkg = getContext().getPackageName();
        Intent i;
        if (Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + pkg));
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open settings", e);
        }
    }
}
