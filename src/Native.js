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

let appPlugin = null;
async function plugin() {
  if (!nativeApp()) return null;
  if (appPlugin) return appPlugin;
  try {
    ({ App: appPlugin } = await import('@capacitor/app'));
  } catch {
    // A build without the plugin is a build where the app cannot be closed from
    // inside it and the back gesture keeps its default. Both are survivable;
    // throwing here would take the title screen down with it.
    appPlugin = null;
  }
  return appPlugin;
}

/** Close the app. Does nothing at all on the web. */
export async function exitApp() {
  const a = await plugin();
  a?.exitApp?.();
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
  const a = await plugin();
  if (!a?.addListener) return;
  a.addListener('backButton', () => { try { handler(); } catch { /* never exit */ } });
}
