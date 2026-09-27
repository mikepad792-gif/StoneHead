# Spec: StoneHead as a home-screen web app

For Claude Code. Makes stoneheadai.com installable: an icon on the phone's
home screen that opens full-screen like a regular app, with a friendly page
when there's no signal. No app store, no new backend, no new data collected.

The new files in `public/` are finished and tested (below). The edits to
existing files are described, not shipped, because Mike's repo has moved
past the tree these were tested on (account deletion, feedback, and the
Discord submenu are already built there).

---

## New files (copy as-is)

| File | What |
|---|---|
| `public/manifest.webmanifest` | App name, colors, icons, full-screen mode |
| `public/sw.js` | Service worker: installability + offline page |
| `public/offline.html` | Self-contained "no signal, man" page with a retry button |
| `public/icons/icon-192.png`, `icon-512.png` | Home-screen icons |
| `public/icons/icon-maskable-512.png` | Android adaptive icon (badge inside the safe zone) |
| `public/icons/apple-touch-icon.png` | iPhone home-screen icon, 180px |

The icons are the vibe-tab StoneHead (no joint), Mike's pick.

### What the service worker does, and doesn't

- **Never touches** `/api/*`, `/.netlify/*`, other origins (Supabase,
  OpenRouter, fonts), or any non-GET request. Chat, login, photos, and
  payments work exactly as if the worker didn't exist.
- **Pages are network-first.** A new deploy shows up the next time the app
  opens. The offline page is served only when the network fails.
- **`/static/` build files are cache-first.** Safe because CRA puts a hash in
  every filename, so a changed file is a new file. Trimmed at 60 entries.
- Caches only the offline page, the icons, and one avatar image up front.
- No personal data is ever cached, so **no privacy policy change** is
  needed for this feature.

---

## Edits to existing files

### `public/index.html`

Replace the `theme-color` line and add the app tags right after it:

```html
<meta name="theme-color" content="#0e110d" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="StoneHead" />
<meta name="apple-mobile-web-app-status-bar-style" content="black" />
```

(`#0e110d` is the new background from the UI polish pass; the old
`#141412` gray would show a mismatched bar above the app.)

**Also fix while there:** the perf pass resized `og-banner.png` to 1200x675
but left the old size in the tags. Change `og:image:width` to `1200` and
`og:image:height` to `675` so link previews on Discord and elsewhere render
at the right shape.

Keep the existing viewport tag as it is. Don't add `viewport-fit=cover`: with
the plain `black` status bar style, iOS keeps the app out from under the
notch and home bar by itself, so no safe-area CSS is needed.

### `src/index.js`

Append after `root.render(...)`:

```js
// Home-screen app support. Production only: a service worker in development
// would cache files you're actively editing.
if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("service worker registration failed:", err);
    });
  });
}
```

### `netlify.toml`

Add before the existing `for = "/*"` headers block. `sw.js` must never be
cached by the browser or the CDN, or a fixed worker can take days to reach
people:

```toml
[[headers]]
  for = "/sw.js"
  [headers.values]
    Cache-Control = "no-cache"
    Service-Worker-Allowed = "/"

[[headers]]
  for = "/manifest.webmanifest"
  [headers.values]
    Content-Type = "application/manifest+json"
    Cache-Control = "no-cache"
```

The SPA fallback (`/*` to `/index.html`) doesn't need changes: Netlify serves
real files before redirects, so `sw.js`, the manifest, and `offline.html`
come through as themselves.

### `src/App.jsx`: "get the app" menu item

**Catch the install prompt early.** Chrome fires `beforeinstallprompt` once,
possibly before React mounts. At module level (top of `App.jsx` or in
`index.js`), before anything renders:

```js
window.__shInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();                 // no browser mini-bar; we show our own item
  window.__shInstallPrompt = e;
  window.dispatchEvent(new Event("sh-install-ready"));
});
window.addEventListener("appinstalled", () => {
  window.__shInstallPrompt = null;
  window.dispatchEvent(new Event("sh-installed"));
});
```

**Detect where we are:**

```js
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
```

**The menu item.** In the sidebar, below the Discord group, same style as
other nav items: `📲 get the app`.

- Hidden when already running as the installed app (`isStandalone()`).
- Shown when `window.__shInstallPrompt` exists (Android Chrome, Samsung
  Internet, desktop Chrome/Edge) or on iOS. Listen for `sh-install-ready`
  and `sh-installed` to update. Hidden everywhere else (Firefox Android,
  for example, has no install prompt to call).
- **Tap with a saved prompt:** `await prompt.prompt()`, then
  `await prompt.userChoice`, then clear `window.__shInstallPrompt` (it's
  single-use either way).
- **Tap on iOS:** open a small sheet (same modal style as the profile):

  > **put StoneHead on your home screen**
  >
  > 1. tap the share button (the square with the arrow)
  > 2. scroll down and tap **Add to Home Screen**
  > 3. tap **Add**
  >
  > you'll log in once inside the app. after that it remembers you.
  >
  > [got it]

- On `sh-installed`: hide the item, toast "StoneHead's on your home screen."

### `src/App.jsx`: one-time install banner

Besides the menu item, phone visitors get the offer once, as a slim bar
directly above the chat input:

> 📲 put StoneHead on your home screen   **[add]**  ✕

- **add** does exactly what the menu item does (Chrome's install prompt, or
  the iOS steps sheet). **✕** closes it.
- **Once per device, ever.** Set `localStorage["sh_install_banner_done"] = "1"`
  the moment it first shows, so it never comes back whether they tap add,
  tap ✕, or ignore it. Install is per device, so per-device storage is the
  right place for this.
- **Shown only when all of these are true:**
  - not already running as the installed app (`isStandalone()` is false)
  - there's a way to install: a saved Chrome prompt, or iOS
  - it's a phone: `window.matchMedia("(pointer: coarse)").matches`
  - the user has gotten at least one reply this session. Not on the empty
    welcome screen, where the UI polish pass made all four suggestions fit
    on one phone screen; a banner there would push them back below the fold.
  - **no safety card anywhere in the current thread.** Someone who just got a
    crisis response doesn't get an app promo under it. Same rule the code
    already follows for memory and titles on those turns.
  - no modal is open
- On `sh-installed`, remove it immediately if it's showing.

No other popups. After the banner's one appearance, the menu item is the
only way in.

**Why the login line:** on iPhone, a home-screen app keeps its own storage
separate from Safari, so users sign in once inside it. That's normal iOS
behavior, not a bug, but it reads like one if nobody says so.

---

## What was tested (on the photo-plus-perf tree)

Built with `CI=true npm run build` (clean), served locally, and driven in
headless Chromium:

- the manifest parses with no errors
- Chrome reports **zero installability errors**
- the service worker installs, activates, and controls the page after one
  reload
- with the server killed, a deep link (`/some/deep/link`) shows the offline
  page
- `/api/*` requests while offline fail as network errors, never served from
  cache
- caches after first load: shell (4 files) and static (the JS and CSS
  bundles), nothing else

Not testable from here: real phones.

## Live test after deploy (on the test site first)

1. **Android Chrome:** menu shows "get the app". Tap it, install, and check
   the icon and the name "StoneHead" on the home screen.
2. Open from the icon: full screen, no browser bar, dark status bar.
3. Log in, send a vibe message, send a plant photo from both camera and
   gallery.
4. Airplane mode, then open the app: "no signal, man". Turn airplane mode
   off and tap "try again": back in.
5. **iPhone Safari:** menu shows "get the app", and the sheet's steps work.
   Log in inside the app once.
6. Tap the Discord links, privacy policy, and terms from inside the app.
   They should open outside it and let you come back.
7. Deploy any small visible change, then close and reopen the app. The
   change should show on the next open.
8. Password reset: the email link opens in the browser. Reset there, then
   log in inside the app with the new password.
9. **Banner:** on a phone that hasn't installed, the banner is NOT on the
   welcome screen. Send one message; it appears above the input after the
   reply. Close it, reload, and it stays gone. It never shows inside the
   installed app, on a desktop, or in a thread with a safety card.

## Decisions (Mike, Sept 24, 2026)

1. **Icon:** the vibe-tab StoneHead, no joint.
2. **Install offer:** the menu item, plus the one-time banner above.
3. **Portrait lock:** yes (`"orientation": "portrait"` stays in the
   manifest).
