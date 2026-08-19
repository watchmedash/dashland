// The three things the packaged app can do that a browser tab cannot, behind
// one door.
//
// Everything here is optional by construction. The web build has no Capacitor
// runtime at all, so `Capacitor` is undefined, `isApp` is false and every
// function below is a no-op that returns quietly. Nothing in the game may
// depend on one of these having happened.
//
// The plugin is imported lazily rather than at module scope for the same
// reason: `@capacitor/app` is a dependency of the APK build, and a static
// import would put it in the web bundle and make the title screen wait on a
// module it will never use.

/** Is this the packaged app rather than a browser tab? */
export function nativeApp() {
  const c = globalThis.Capacitor;
  return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
}

/**
 * The plugin, BOXED - and the box is the whole point.
 *
 * Capacitor's `App` is a proxy that turns any property access into a call to a
 * native method of that name. Returning it out of an `async` function hands it
 * to the promise machinery, which probes every resolved value for `.then` to see
 * whether it is a thenable - so the runtime asks the proxy for `then`, the proxy
 * dispatches a native call named `then`, and the web build says so out loud:
 *   "App.then()" is not implemented on web
 * On a device that dispatch goes to the real bridge instead, which is a native
 * call that does not exist being made on every await, at startup and again on
 * every exit.
 *
 * Wrapping it in a plain object means nothing ever awaits the proxy itself. The
 * cost is one `.app` at each call site and it is worth it.
 */
let boxed = null;
async function plugin() {
  if (!nativeApp()) return null;
  if (boxed) return boxed;
  try {
    const mod = await import('@capacitor/app');
    boxed = { app: mod.App };
  } catch {
    // A build without the plugin is a build where the app cannot be closed from
    // inside it and the back gesture keeps its default. Both are survivable;
    // throwing here would take the title screen down with it.
    boxed = { app: null };
  }
  return boxed;
}
/** Close the app. Does nothing at all on the web. */
export async function exitApp() {
  try {
    (await plugin())?.app?.exitApp?.();
  } catch { /* nothing to do about it, and never worth throwing for */ }
}

/**
 * Take over the Android back gesture.
 *
 * THE DEFAULT IS THE BUG. Android's back button closes the Activity when
 * nothing handles it, so in a game it is a single unguarded tap that throws away
 * whatever you were doing - and on a phone it is one of the three buttons always
 * on screen. Registering ANY listener suppresses that default, which is most of
 * what this function is for; what it does afterwards is the polite half.
 *
 * `handler` is called with no arguments and decides what back means right now -
 * close the open screen, open the pause menu, and so on. It is never allowed to
 * exit: the only way out of the app is the Exit button on the title screen,
 * where it is a deliberate act with a confirmation on it.
 */
export async function onBackButton(handler) {
  try {
    const app = (await plugin())?.app;
    if (!app?.addListener) return;
    app.addListener('backButton', () => { try { handler(); } catch { /* never exit */ } });
  } catch { /* the gesture keeps its default; better than a dead title screen */ }
}
