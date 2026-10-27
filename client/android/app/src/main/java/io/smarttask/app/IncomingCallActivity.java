package io.smarttask.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

// The full-screen "X is calling you" that a sleeping or locked phone wakes up
// to, opened by the ringing notification's full-screen intent. Native, not the
// web app: the WebView would have to cold-start (seconds) before it could draw
// anything, and it cannot show over the lock screen without dragging the whole
// app there with it. The ringtone is the notification's, so leaving this screen
// (Home, Back) does not silence the call — just like a phone call.
public class IncomingCallActivity extends Activity implements CallRinger.Listener {

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Bundle call;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();
        setContentView(R.layout.activity_incoming_call);
        findViewById(R.id.call_answer).setOnClickListener((v) -> { if (call != null) CallRinger.answer(this, call); finish(); });
        findViewById(R.id.call_decline).setOnClickListener((v) -> { if (call != null) CallRinger.decline(this, call, null); finish(); });
        CallRinger.addListener(this);
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    private void bind(Intent intent) {
        call = intent == null ? null : intent.getBundleExtra(CallRinger.EXTRA_CALL);
        String callId = call == null ? null : call.getString("call_id");
        long left = call == null ? 0 : CallRinger.remainingMs(call);
        if (callId == null || CallRinger.isHandled(callId) || left == 0) { finish(); return; }

        String title = call.getString("title");
        if (title == null || title.isEmpty()) title = call.getString("from_name");
        if (title == null || title.isEmpty()) title = "VoTask";
        ((TextView) findViewById(R.id.call_title)).setText(title);
        ((TextView) findViewById(R.id.call_avatar)).setText(initials(title));
        ((TextView) findViewById(R.id.call_subtitle)).setText(CallRinger.subtitle(this, call));
        boolean video = "video".equals(call.getString("kind"));
        findViewById(R.id.call_answer_video).setVisibility(video ? View.VISIBLE : View.GONE);
        findViewById(R.id.call_answer_audio).setVisibility(video ? View.GONE : View.VISIBLE);

        // The notification times out by itself; this screen has to as well, or
        // a missed call would leave a dead "calling you" up until someone looks.
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::finish, left);
    }

    @Override
    public void onCallGone(String callId) {
        if (call != null && callId.equals(call.getString("call_id"))) runOnUiThread(this::finish);
    }

    @Override
    protected void onDestroy() {
        CallRinger.removeListener(this);
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // Deliberately no requestDismissKeyguard: answering happens over the lock
        // screen and the call itself does not need the phone unlocked.
    }

    private static String initials(String name) {
        String[] parts = name.trim().split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p.isEmpty()) continue;
            sb.appendCodePoint(Character.toUpperCase(p.codePointAt(0)));
            if (sb.length() >= 2) break;
        }
        return sb.length() == 0 ? "?" : sb.toString();
    }
}
