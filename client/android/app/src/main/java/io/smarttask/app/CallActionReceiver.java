package io.smarttask.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

// The Decline button on the ringing notification. A receiver rather than an
// activity so declining never flashes the app open; goAsync keeps the process
// alive for the few seconds the server call takes after onReceive returns.
public class CallActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!CallRinger.ACTION_DECLINE.equals(intent.getAction())) return;
        Bundle call = intent.getBundleExtra(CallRinger.EXTRA_CALL);
        if (call == null) return;
        PendingResult pending = goAsync();
        CallRinger.decline(ctx.getApplicationContext(), call, pending::finish);
    }
}
