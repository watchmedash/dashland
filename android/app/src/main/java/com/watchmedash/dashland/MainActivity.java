package com.watchmedash.dashland;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * The game, with the phone's own bars out of the way.
 *
 * The owner: "should be fullscreen no light action bar/stats bar etc". The
 * theme already carried `android:windowFullscreen`, which is why this looked
 * done — but that flag only ever hid the STATUS bar, it is deprecated from
 * Android 11, and it never had anything to say about the navigation bar at the
 * bottom. On a modern phone the game was running with a clock and a battery
 * across the top and a gesture pill across the foot of the screen, both over a
 * HUD laid out to the very edges.
 *
 * `WindowInsetsControllerCompat` is the replacement and it is the only thing
 * that hides both. Three parts, and each is doing separate work:
 *
 *   setDecorFitsSystemWindows(false)   stop the layout being inset for bars
 *                                      that are not there, or the web view is
 *                                      drawn into a box the size of the screen
 *                                      minus two bars that are hidden.
 *   hide(systemBars())                 the status bar and the navigation bar
 *                                      together. `systemBars()` is both; hiding
 *                                      one is the state we are trying to leave.
 *   BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
 *                                      a swipe from an edge brings them back
 *                                      briefly and they leave again on their
 *                                      own. The alternative is a swipe that
 *                                      restores them permanently, which means
 *                                      one accidental gesture ends fullscreen
 *                                      for the rest of the session.
 *
 * Re-applied on every focus gain, which is the part that is easy to leave out.
 * The bars come back whenever the window loses focus — a notification shade
 * pulled down, a permission dialog, the app switcher, returning from the
 * background — and without this the game would be fullscreen exactly once, at
 * launch, and never again.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        goFullscreen();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goFullscreen();
    }

    private void goFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.hide(WindowInsetsCompat.Type.systemBars());
        bars.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
