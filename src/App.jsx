import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from "react";
import { pickChips, loadRecent, saveRecent } from "./chipPool.js";
import { APP_VERSION } from "./version.js";

const API_BASE = "";
const DISCORD_INVITE_URL = "https://discord.gg/twJuwv6WT";
// Discord Developer Portal -> the StoneHead bot -> Installation -> Install Link
// (the Discord Provided Link). Scopes and permissions come from the portal's
// Guild Install settings: bot + applications.commands, permissions 85056.
const DISCORD_BOT_INSTALL_URL = "https://discord.com/oauth2/authorize?client_id=1549743913261203516";
// Invite-only deploys (the test site) set REACT_APP_DISABLE_SIGNUP=true at build
// time to hide the sign-up toggle. The server enforces it too (DISABLE_SIGNUP).
const SIGNUP_DISABLED = process.env.REACT_APP_DISABLE_SIGNUP === "true";
const AppContext = createContext(null);

// ── Home-screen app ─────────────────────────────────────────────────
// Chrome fires beforeinstallprompt once, possibly before React mounts, so it
// is caught here at module load. Saved for the "get the app" item and the
// one-time banner; the browser's own mini-bar is suppressed.
window.__shInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__shInstallPrompt = e;
  window.dispatchEvent(new Event("sh-install-ready"));
});
window.addEventListener("appinstalled", () => {
  window.__shInstallPrompt = null;
  window.dispatchEvent(new Event("sh-installed"));
});
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Android browsers can always install from their own menu. Chrome only
// hands the page its install prompt after a tap and ~30s on the page, so
// until then "get the app" shows the menu steps instead of doing nothing.
const isAndroid = () => /android/i.test(navigator.userAgent);
// There's a way to install from here: a saved Chrome prompt, iOS's Add to
// Home Screen, or an Android browser menu. Never inside the installed app.
const installAvailable = () => !isStandalone() && (!!window.__shInstallPrompt || isIOS() || isAndroid());
const isPhone = () => window.matchMedia("(pointer: coarse)").matches;
// The install banner shows once per device, ever (install is per device).
const INSTALL_BANNER_KEY = "sh_install_banner_done";
function installBannerDone() { try { return localStorage.getItem(INSTALL_BANNER_KEY) === "1"; } catch { return false; } }
function markInstallBannerDone() { try { localStorage.setItem(INSTALL_BANNER_KEY, "1"); } catch {} }
function useApp() { return useContext(AppContext); }

// Single-flight session refresh: N parallel 401s trigger ONE refresh
// round-trip; everyone awaits the same promise. Supabase rotates refresh
// tokens, so both tokens are re-stored on success.
let refreshing = null;
async function refreshSession() {
  const refresh_token = localStorage.getItem("refresh_token");
  if (!refresh_token) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    let parsed;
    if (typeof data.body === "string") { try { parsed = JSON.parse(data.body); } catch { parsed = data; } } else { parsed = data; }
    if (!parsed.session_token || !parsed.refresh_token) return false;
    localStorage.setItem("session_token", parsed.session_token);
    localStorage.setItem("refresh_token", parsed.refresh_token);
    return true;
  } catch { return false; }
}

async function apiCall(endpoint, options = {}, isRetry = false) {
  const token = localStorage.getItem("session_token");
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  // A platform error (Netlify's 413 for an oversized body, a gateway timeout)
  // is not JSON. Turn it into an ordinary error instead of a parse crash.
  let data;
  try { data = await res.json(); } catch { data = { error: `request failed (${res.status})` }; }
  let parsed;
  if (typeof data.body === "string") { try { parsed = JSON.parse(data.body); } catch { parsed = data; } } else { parsed = data; }
  // Expired session: one transparent refresh + one retry, then give up.
  // Auth endpoints are exempt (a login 401 means wrong password, not an
  // expired session) and never loop: the retry passes isRetry=true.
  if (res.status === 401 && !endpoint.startsWith("/api/auth/")) {
    if (!isRetry && localStorage.getItem("refresh_token")) {
      if (!refreshing) refreshing = refreshSession().finally(() => { refreshing = null; });
      const refreshed = await refreshing;
      if (refreshed) return apiCall(endpoint, options, true);
    }
    // Refresh failed or the retry 401'd again — clear both tokens and throw;
    // loadProfile's catch path lands the user back on AuthScreen.
    localStorage.removeItem("session_token");
    localStorage.removeItem("refresh_token");
    throw new Error(parsed.error || "session expired");
  }
  if (parsed.error) {
    // status and code ride along so callers can tell a photo limit from a
    // dead network without string-matching the message.
    const err = new Error(parsed.error);
    err.status = res.status;
    err.code = parsed.code || null;
    err.data = parsed; // e.g. the photo quota on a rollover_confirm 409
    throw err;
  }
  return parsed;
}
async function apiPost(endpoint, body) { return apiCall(endpoint, { method: "POST", body: JSON.stringify(body) }); }
async function apiGet(endpoint, params = {}) { const qs = new URLSearchParams(params).toString(); return apiCall(qs ? `${endpoint}?${qs}` : endpoint, { method: "GET" }); }

// ── Talk the Plant photos ────────────────────────────────────────────
// Every photo is redrawn on a canvas before it leaves the phone. That does two
// jobs. It shrinks the photo to what the vision model actually uses (past
// about 1568px on the long edge it gets downscaled on their end anyway), and
// it strips everything the camera attached, GPS location included, because a
// canvas export carries no metadata at all. The server strips again
// (lib/photoRead.js) as a second lock.
const PHOTO_MAX_EDGE = 1568;
const PHOTO_JPEG_QUALITY = 0.85;
const PHOTO_MAX_FILE_BYTES = 40 * 1024 * 1024; // refuse to even decode past this
// Must match PHOTO_ONLY_TEXT in lib/photoRead.js: stored as the message text
// when a photo is sent with no words, and hidden behind the photo marker.
const PHOTO_ONLY_TEXT = "(photo)";

async function decodePhoto(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close && bitmap.close() };
    } catch { /* some browsers refuse the options bag or the format; <img> below covers them */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode_failed"));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function preparePhoto(file) {
  if (file.size > PHOTO_MAX_FILE_BYTES) throw new Error("too_big");
  const decoded = await decodePhoto(file);
  try {
    const { width, height } = decoded;
    if (!width || !height) throw new Error("decode_failed");
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx2d = canvas.getContext("2d");
    // JPEG has no transparency. White, not black, behind a transparent screenshot.
    ctx2d.fillStyle = "#ffffff";
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY));
    if (!blob) throw new Error("encode_failed");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("encode_failed"));
      reader.readAsDataURL(blob);
    });
    return { dataUrl, previewUrl: URL.createObjectURL(blob) };
  } finally {
    decoded.done();
  }
}

// "Oct 26" and "5:00 PM" in the phone's own time zone.
// The year only when it isn't this one ("Sep 23, 2027"), so a date a year out
// never reads like one that already passed.
// Time left, coarse to fine: "20d 23h", "5h 12m", "12m", "under a minute".
function fmtCountdown(ms) {
  if (ms <= 0) return "";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m` : "under a minute";
}

function fmtDay(iso) {
  try {
    const d = new Date(iso);
    const utc = iso && iso.length === 10;
    const sameYear = (utc ? d.getUTCFullYear() : d.getFullYear()) === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: utc ? "UTC" : undefined });
  } catch { return ""; }
}
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch { return ""; } }
// A cached quota stops being true at the daily reset (midnight UTC).
function quotaIsFresh(q) { return !!q && !!q.resets_at && Date.now() < Date.parse(q.resets_at); }
function photoCountLine(q) {
  if (!q) return null;
  const n = q.remaining_today;
  let line = `${n} photo${n === 1 ? "" : "s"} left today · resets at ${fmtTime(q.resets_at)}`;
  if (q.rollover > 0) line += ` · ${q.rollover} rollover`;
  return line;
}
const ROLLOVER_OK_KEY = (threadId) => `sh_rollover_ok_${threadId}`;
function rolloverOkForThread(threadId) { try { return !!threadId && localStorage.getItem(ROLLOVER_OK_KEY(threadId)) === "1"; } catch { return false; } }
function markRolloverOkForThread(threadId) { try { if (threadId) localStorage.setItem(ROLLOVER_OK_KEY(threadId), "1"); } catch {} }

// What StoneHead says when a photo turn fails. `final` means retrying the
// same photo can't work, so the error bubble offers no retry button.
function photoErrorReply(e) {
  switch (e && e.code) {
    case "photo_limit":
      return { text: "that's all the photos I can look at today. tell me what you're seeing and I'll work with that.", final: true };
    case "bad_image":
      return { text: "couldn't open that photo. try a regular jpg or a screenshot of it.", final: true };
    case "photo_expired":
    case "photo_used":
    case "photo_not_found":
    case "photo_not_ready":
      return { text: "that photo timed out on me. attach it again?", final: true };
    case "age_blocked":
    case "age_unverified":
    case "not_plant":
      return { text: "photos only work on talk the plant.", final: true };
    case "vision_unavailable":
    case "vision_unreadable":
    case "photo_unavailable":
      return { text: "couldn't get a good look at that one, something's off on my end. try it again in a sec.", final: false };
    default:
      if (e && e.status === 413) return { text: "that photo's too big to send. try a screenshot of it.", final: true };
      return null;
  }
}

function CameraIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 8h3l1.6-2.4A1.5 1.5 0 0 1 9.85 5h4.3a1.5 1.5 0 0 1 1.25.6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.8"/>
    </svg>
  );
}

// §7: all four are in the USER's voice, and none can be satisfied by a single
// deep line — the previous set was quote-vending prompts, which taught the
// exact behavior the giveaway rejects. Chip 3 is the first-contact demo of the
// voice rewrite: it asks him to bring something, which surfaces a tide pool.
// Suggestion chips now rotate: pools and picker live in src/chipPool.js.

function relativeTime(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// De-hyphenated display name for strains (dataset names are slug-style).
function displayStrainName(name) {
  return String(name || "").replace(/-+/g, " ").replace(/\s+/g, " ").trim();
}

// Dark-launch flag for the Core (reflection) memory section. Flip to true
// once the consolidation job's output has been eyeballed against real users.
const SHOW_CORE = false;

function ToastContainer({ toasts, removeToast }) {
  return (
    <div className="sh-toast-container">
      {toasts.map((t) => (
        <div key={t.id} className="sh-toast" onClick={() => removeToast(t.id)}>{t.message}</div>
      ))}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem("session_token") || null);
  const [authView, setAuthView] = useState("login");
  const [activeTab, setActiveTab] = useState("vibe");
  const [view, setView] = useState("chat"); // "chat" | "memory"
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [usageRemaining, setUsageRemaining] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const [showAgeGate, setShowAgeGate] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingHandoff, setPendingHandoff] = useState(null); // vibe→plant question awaiting age verify
  const [loading, setLoading] = useState(false);
  const [appLoading, setAppLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [toasts, setToasts] = useState([]);
  // The photo quota (migration 019): { daily_limit, used_today, remaining_today,
  // rollover, earns_rollover, next_halving, resets_at }, from profile-get and
  // refreshed by every photo-read response.
  const [photoQuota, setPhotoQuota] = useState(null);
  const photosRemaining = photoQuota && quotaIsFresh(photoQuota) ? photoQuota.remaining_today : null;
  // The rollover warning card: { remaining, threadId, onOkay } while open.
  const [rolloverAsk, setRolloverAsk] = useState(null);
  const [loadingNote, setLoadingNote] = useState(null); // a word next to the typing dots ("looking at the photo...")
  const [recoveryToken, setRecoveryToken] = useState(null); // set from the reset-email hash
  // Owes an acknowledgement of the CURRENT terms — never accepted, or accepted
  // an older version. The server decides (profile-get compares against
  // TOS_VERSION); the client only renders.
  const [tosPending, setTosPending] = useState(false);
  // Home-screen app: whether there's a way to install, the iOS steps sheet,
  // and the one-time banner ("unseen" -> "showing" -> "done").
  const [canInstall, setCanInstall] = useState(() => installAvailable());
  const [showInstallSheet, setShowInstallSheet] = useState(false);
  const [installBanner, setInstallBanner] = useState(() => (installBannerDone() ? "done" : "unseen"));
  const [gotReply, setGotReply] = useState(false); // a live reply arrived this session

  function addToast(msg) {
    const id = Date.now();
    setToasts((p) => [...p, { id, message: msg }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3500);
  }
  function removeToast(id) { setToasts((p) => p.filter((t) => t.id !== id)); }

  useEffect(() => {
    if (sessionToken) { Promise.all([loadProfile(), loadThreads(), checkUsage()]).finally(() => setAppLoading(false)); }
    else { setAppLoading(false); }
  }, [sessionToken]);

  useEffect(() => { if (sessionToken) loadThreads(); }, [activeTab]);

  useEffect(() => {
    const onReady = () => setCanInstall(installAvailable());
    const onInstalled = () => {
      setCanInstall(false); setInstallBanner("done"); setShowInstallSheet(false);
      addToast("StoneHead's on your home screen.");
    };
    window.addEventListener("sh-install-ready", onReady);
    window.addEventListener("sh-installed", onInstalled);
    return () => { window.removeEventListener("sh-install-ready", onReady); window.removeEventListener("sh-installed", onInstalled); };
  }, []);

  // §6a — the password-reset link lands here with the tokens in the URL HASH
  // (Supabase verifies on its own domain, then redirects). Keying off the hash
  // rather than the path means this works no matter what redirect_to resolves
  // to. Runs once, before anything else touches the address bar.
  useEffect(() => {
    const hash = window.location.hash || "";
    if (hash.includes("type=recovery")) {
      const params = new URLSearchParams(hash.slice(1));
      const token = params.get("access_token");
      if (token) {
        setRecoveryToken(token);
        setAuthView("reset");
        // Strip the token out of the address bar so it isn't sitting in
        // history or a screenshot.
        window.history.replaceState({}, "", "/");
      }
    }
  }, []);

  // Back from Stripe Checkout (?paid=1 or ?paid=0). The pass is granted by
  // the webhook, a moment after the redirect, so wait for the end date to
  // move (up to ~20s) before saying so. The flag leaves the URL either way.
  useEffect(() => {
    if (!sessionToken) return;
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    if (paid === null) return;
    params.delete("paid");
    const rest = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    if (paid !== "1") return;
    let prev = null;
    try { prev = sessionStorage.getItem("sh_prev_expires"); sessionStorage.removeItem("sh_prev_expires"); } catch {}
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        try {
          const p = await apiGet("/api/profile/get");
          if (p.pass_active && p.subscription_expires && p.subscription_expires !== prev) {
            await loadProfile();
            addToast(`you're set until ${fmtDay(p.subscription_expires)}`);
            return;
          }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!cancelled) addToast("payment's still processing. it'll show up in a minute");
    })();
    return () => { cancelled = true; };
  }, [sessionToken]);

  async function loadProfile() {
    try {
      const p = await apiGet("/api/profile/get");
      setProfile(p);
      setUser({ user_id: p.user_id, username: p.username, is_subscribed: p.is_subscribed, age_verified: p.age_verified, is_founder: p.is_founder, founder_number: p.founder_number, badges: p.badges || [] });
      setUsageRemaining(p.usage_remaining ?? null);
      setTosPending(p.tos_pending === true);
      if (p.photos) setPhotoQuota(p.photos);
    } catch (e) { handleLogout(); }
  }
  async function loadThreads() {
    try { const data = await apiGet("/api/threads/list", { tab: activeTab }); setThreads(data.threads || []); } catch (e) {}
  }
  async function loadMessages(threadId) {
    // Filter out blank rows — an older deploy stored whitespace-only model
    // returns, and an empty bubble carries no information worth rendering.
    try { const data = await apiGet("/api/threads/messages", { thread_id: threadId }); setMessages((data.messages || []).filter((m) => m.content && m.content.trim())); }
    catch (e) { addToast("couldn't load messages"); }
  }
  async function checkUsage() {
    try { const data = await apiGet("/api/usage/check"); setUsageRemaining(data.usage_remaining ?? null); } catch (e) {}
  }
  async function handleLogin(email, password) {
    const data = await apiPost("/api/auth/login", { email, password });
    localStorage.setItem("session_token", data.session_token);
    if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
    setSessionToken(data.session_token);
    // badges arrive via loadProfile (fires on sessionToken change) — login response doesn't carry them.
    setUser({ user_id: data.user_id, username: data.username, is_subscribed: data.is_subscribed, age_verified: data.age_verified, is_founder: data.is_founder, founder_number: data.founder_number, badges: [] });
  }
  async function handleRegister(email, password, username) {
    const data = await apiPost("/api/auth/register", { email, password, username });
    localStorage.setItem("session_token", data.session_token);
    if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
    setSessionToken(data.session_token);
    // New signups are never founders and hold no badges — grants are operator-CLI only.
    setUser({ user_id: data.user_id, username, is_subscribed: false, age_verified: false, is_founder: false, founder_number: null, badges: [] });
  }
  // §6b — the toast copy matches what the endpoint actually does: it always
  // returns 200, so the UI must not claim an inbox we can't confirm exists.
  async function handleForgotPassword(email) {
    await apiPost("/api/auth/forgot-password", { email });
    addToast("if that email has an account, a reset link is on the way");
  }
  // §6c — send them to login rather than auto-signing-in. One extra step, and
  // it confirms the new password actually works.
  async function handleResetPassword(password) {
    await apiPost("/api/auth/reset-password", { access_token: recoveryToken, password });
    setRecoveryToken(null);
    setAuthView("login");
    addToast("password updated — log in with the new one");
  }
  function handleLogout() {
    localStorage.removeItem("session_token"); localStorage.removeItem("refresh_token");
    setSessionToken(null); setUser(null); setProfile(null);
    setThreads([]); setMessages([]); setActiveThreadId(null);
    setTosPending(false);
  }
  // Show the rollover card, unless the user turned the warning off (on the
  // account) or okayed rollover for this thread (on this device).
  function askRollover({ remaining, threadId, onOkay }) {
    if (profile && profile.warn_rollover === false) { onOkay(); return; }
    if (rolloverOkForThread(threadId)) { onOkay(); return; }
    setRolloverAsk({ remaining, threadId, onOkay });
  }
  // The two profile toggles. Optimistic, reverted if the save fails.
  async function saveSetting(field, value) {
    const before = profile ? profile[field] : undefined;
    setProfile((p) => (p ? { ...p, [field]: value } : p));
    try { await apiPost("/api/profile/settings", { [field]: value }); }
    catch (e) { setProfile((p) => (p ? { ...p, [field]: before } : p)); addToast("couldn't save that. try again"); }
  }
  // Thumbs up / down on a reply. rating null removes it. Throws on failure so
  // the dialog can stay open; the thumb only changes once the server saved.
  async function handleRate(messageId, rating, extra = {}) {
    await apiPost("/api/feedback", { message_id: messageId, rating, ...extra });
    setMessages((p) => p.map((m) => (m.id === messageId ? { ...m, rating } : m)));
    if (rating === "up" && extra.dont_ask_again) setProfile((p) => (p ? { ...p, skip_training_prompt: true } : p));
  }
  // "get the app": Chrome's saved install prompt (single-use either way), or
  // the Add to Home Screen steps on iOS.
  async function handleInstall() {
    setInstallBanner((b) => (b === "showing" ? "done" : b));
    const prompt = window.__shInstallPrompt;
    if (prompt) {
      window.__shInstallPrompt = null;
      setCanInstall(installAvailable());
      try { await prompt.prompt(); await prompt.userChoice; } catch {}
      return;
    }
    if (isIOS()) setShowInstallSheet("ios");
    else if (isAndroid()) setShowInstallSheet("android");
  }
  function dismissInstallBanner() { setInstallBanner("done"); }
  // Runs after /api/account/delete succeeded: the same cleanup as logging
  // out, then the login screen says goodbye.
  function handleAccountDeleted() {
    handleLogout();
    setShowProfile(false);
    addToast("your account's gone. take care of yourself.");
  }
  async function handleAcceptTos() {
    await apiPost("/api/profile/accept-tos", {});
    setTosPending(false);
  }
  async function handleSwitchTab(tab) {
    if (tab === "plant" && user && !user.age_verified) { setShowAgeGate(true); return; }
    setActiveTab(tab); setActiveThreadId(null); setMessages([]);
  }
  async function handleAgeVerify() {
    try {
      await apiPost("/api/profile/age-verify", {});
      setUser((u) => ({ ...u, age_verified: true }));
      setShowAgeGate(false); setActiveTab("plant"); setActiveThreadId(null); setMessages([]);
      // A handoff that hit the gate resumes here — verified first, then carried.
      if (pendingHandoff) { const carried = pendingHandoff; setPendingHandoff(null); await startPlantThreadWith(carried); }
    }
    catch (e) { addToast("age verification failed"); }
  }
  function dismissAgeGate() { setShowAgeGate(false); setPendingHandoff(null); }
  async function handleNewThread() {
    try { const data = await apiPost("/api/threads/create", { tab: activeTab }); setActiveThreadId(data.thread_id); setMessages([]); await loadThreads(); setSidebarOpen(false); }
    catch (e) { addToast("couldn't create thread"); }
  }
  async function handleSelectThread(threadId) { setActiveThreadId(threadId); await loadMessages(threadId); setSidebarOpen(false); }
  async function handleDeleteThread(threadId) {
    try { await apiPost("/api/threads/delete", { thread_id: threadId }); setThreads((p) => p.filter((t) => t.id !== threadId)); if (activeThreadId === threadId) { setActiveThreadId(null); setMessages([]); } }
    catch (e) { addToast("couldn't delete thread"); }
  }
  async function handleRenameThread(threadId, newTitle) {
    try { await apiPost("/api/threads/rename", { thread_id: threadId, title: newTitle }); setThreads((p) => p.map((t) => (t.id === threadId ? { ...t, title: newTitle } : t))); }
    catch (e) { addToast("couldn't rename thread"); }
  }
  // opts { threadId, tab } override the active state — the vibe→plant handoff
  // sends into a thread it just created, before React state has caught up.
  //
  // opts.photo { dataUrl, previewUrl, photoReadId? } makes it a photo turn,
  // Talk the Plant only. Two requests: /api/plant/photo-read looks at the
  // photo and returns a read id, then /api/chat/send runs the turn with it.
  // A retry carries photoReadId so it doesn't pay for a second read.
  async function handleSendMessage(text, opts = {}) {
    const photo = opts.photo || null;
    if (!text.trim() && !photo) return;
    const tab = opts.tab || activeTab;
    if (photo && tab !== "plant") return;
    let threadId = opts.threadId || activeThreadId;
    if (!threadId) {
      try { const data = await apiPost("/api/threads/create", { tab }); threadId = data.thread_id; setActiveThreadId(threadId); loadThreads(); }
      catch (e) { addToast("couldn't start thread"); return; }
    }
    const tempId = `temp-${Date.now()}`;
    setMessages((p) => [...p, { id: tempId, role: "user", content: text, created_at: new Date().toISOString(), ...(photo ? { photo: true, photoUrl: photo.previewUrl } : {}) }]);
    setLoading(true);
    let photoReadId = photo ? photo.photoReadId || null : null;
    try {
      if (photo && !photoReadId) {
        setLoadingNote("looking at the photo...");
        const read = await apiPost("/api/plant/photo-read", { thread_id: threadId, image: photo.dataUrl, caption: text, ...(photo.allowRollover ? { allow_rollover: true } : {}) });
        if (read.photos) setPhotoQuota(read.photos);
        // "skipped" (a safety intercept on the words, or out of messages) has
        // no read id. The turn still goes to chat-send, as plain text, and
        // chat-send answers it the way it answers any other message.
        photoReadId = read.photo_read_id || null;
        setLoadingNote(null);
      }
      // supports_safety_card tells the backend this bundle can RENDER the
      // card. Without it the backend appends the resource to the message text
      // instead, so an old cached bundle degrades to a visible number rather
      // than silently dropping the disclosure.
      const data = await apiPost("/api/chat/send", {
        message: text || (photo && !photoReadId ? PHOTO_ONLY_TEXT : text),
        thread_id: threadId,
        tab,
        supports_safety_card: true,
        ...(photoReadId ? { photo_read_id: photoReadId } : {}),
      });
      // A blank/whitespace reply must never render as an empty bubble — treat
      // it as a failed send so the user gets the error bubble + retry button.
      if (!data.reply || !String(data.reply).trim()) throw new Error("empty reply");
      // handoff and safetyCard both come from API fields, never from
      // string-matching the prose.
      // assistant_message_id is the stored row, so the reply can be rated
      // right away; rateable is the server's call (never a safety turn).
      setMessages((p) => [...p, { id: data.assistant_message_id || `resp-${Date.now()}`, role: "assistant", content: data.reply, created_at: new Date().toISOString(), handoff: data.handoff || null, handoff_message: data.handoff_message || null, safetyCard: data.safetyCard || null, rateable: data.rateable === true && !!data.assistant_message_id, rating: null }]);
      if (data.usage_remaining !== null && data.usage_remaining !== undefined) setUsageRemaining(data.usage_remaining);
      setGotReply(true);
      setTimeout(() => loadThreads(), 2000);
    } catch (e) {
      if (e && e.data && e.data.photos) setPhotoQuota(e.data.photos);
      // The next photo would come out of rollover (say, photos used on another
      // device since the quota was cached). Nothing was used: take the bubble
      // back and ask, and "okay" resends the same photo with allow_rollover.
      if (photo && e && e.code === "rollover_confirm") {
        setMessages((p) => p.filter((m) => m.id !== tempId));
        askRollover({
          remaining: e.data?.photos?.rollover ?? 0,
          threadId,
          onOkay: () => handleSendMessage(text, { ...opts, threadId, tab, photo: { ...photo, allowRollover: true } }),
        });
        return;
      }
      const photoError = photo ? photoErrorReply(e) : null;
      // A photo turn that failed AFTER its read keeps the read id, so the
      // retry button goes straight to the send instead of paying again.
      const retryPhoto = photo && !(photoError && photoError.final) ? { ...photo, photoReadId } : null;
      setMessages((p) => [...p, { id: `err-${Date.now()}`, role: "assistant", content: photoError ? photoError.text : "man, something went sideways... try again in a sec", created_at: new Date().toISOString(), isError: true, noRetry: !!(photoError && photoError.final), retryPhoto }]);
      addToast(photoError ? "photo didn't go through" : "message failed to send");
    } finally { setLoading(false); setLoadingNote(null); }
  }
  // The click-over button: switch to plant, new thread, carry the question so
  // they never retype what they just asked. Unverified users route THROUGH
  // the age gate (handleAgeVerify resumes the carry) — never around it.
  async function handleHandoffClick(text) {
    if (!text || !text.trim() || loading) return;
    if (user && !user.age_verified) { setPendingHandoff(text); setShowAgeGate(true); return; }
    await startPlantThreadWith(text);
  }
  async function startPlantThreadWith(text) {
    try {
      const data = await apiPost("/api/threads/create", { tab: "plant" });
      setView("chat"); setActiveTab("plant"); setActiveThreadId(data.thread_id); setMessages([]);
      await handleSendMessage(text, { threadId: data.thread_id, tab: "plant" });
    } catch (e) { addToast("couldn't carry that over — try again"); }
  }
  async function handleToggleData(threadId, currentState) {
    try { const data = await apiPost("/api/threads/toggle-data", { thread_id: threadId, data_opt_in: !currentState }); setThreads((p) => p.map((t) => (t.id === threadId ? { ...t, data_opt_in: data.data_opt_in } : t))); }
    catch (e) { addToast("couldn't update data setting"); }
  }

  // The one-time install banner. Never on the welcome screen (it would push
  // the suggestions below the fold), never on a desktop, and never in a
  // thread with a safety turn: nobody gets an app promo under a crisis
  // response. A safety turn is a reply with a card, or one the server marked
  // not rateable (crisis tier 1 has no card).
  const threadHadSafetyTurn = messages.some((m) => m.role === "assistant" && (m.safetyCard || m.rateable === false));
  const bannerAllowed = canInstall && view === "chat" && !threadHadSafetyTurn;
  const bannerEligible = installBanner === "unseen" && bannerAllowed && gotReply && isPhone() &&
    !showProfile && !showSubscription && !showAgeGate && !tosPending && !showInstallSheet;
  useEffect(() => {
    // Marked done the moment it first shows: tap add, tap x, or ignore it,
    // it never comes back on this device.
    if (bannerEligible) { setInstallBanner("showing"); markInstallBannerDone(); }
  }, [bannerEligible]);
  const showInstallBanner = installBanner === "showing" && bannerAllowed;

  const ctx = { photoQuota, askRollover, saveSetting, setProfile, canInstall, handleInstall, showInstallBanner, dismissInstallBanner, user, activeTab, view, setView, threads, activeThreadId, messages, usageRemaining, loading, profile, showProfile, showSubscription, showAgeGate, sidebarOpen, setShowProfile, setShowSubscription, setSidebarOpen, handleLogin, handleRegister, handleLogout, handleAccountDeleted, handleRate, handleSwitchTab, handleAgeVerify, dismissAgeGate, handleNewThread, handleSelectThread, handleSendMessage, handleHandoffClick, handleToggleData, handleDeleteThread, handleRenameThread, loadProfile, authView, setAuthView, addToast, setShowAgeGate, handleForgotPassword, handleResetPassword, tosPending, handleAcceptTos, photosRemaining, loadingNote };

  // A recovery link can arrive while a session is still in localStorage, so the
  // reset view wins over the logged-in app until the password is set.
  if (!sessionToken || (authView === "reset" && recoveryToken)) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="sh-root">
          <ToastContainer toasts={toasts} removeToast={removeToast} />
          <AuthScreen />
        </div>
      </AppContext.Provider>
    );
  }
  if (appLoading) return (
    <div className="sh-root"><div className="sh-loading">
      <img src="/images/stonehead-clean.png" alt="" className="sh-loading-img" />
      <div className="sh-loading-dots"><div className="sh-typing-dot"/><div className="sh-typing-dot"/><div className="sh-typing-dot"/></div>
    </div></div>
  );

  return (
    <AppContext.Provider value={ctx}>
      <div className="sh-root">
        <ToastContainer toasts={toasts} removeToast={removeToast} />
        {/* Rendered FIRST and outside the layout: it must sit over everything,
            including the age gate, because it is the more fundamental
            agreement. */}
        {tosPending && <TosModal />}
        {showAgeGate && <AgeGateModal />}
        {showProfile && <ProfilePage />}
        {showSubscription && <SubscriptionPage />}
        {rolloverAsk && <RolloverCard ask={rolloverAsk} onClose={() => setRolloverAsk(null)} />}
        {showInstallSheet && <InstallSheet platform={showInstallSheet} onClose={() => setShowInstallSheet(false)} />}
        <div className="sh-layout">
          {sidebarOpen && <div className="sh-sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
          <ThreadSidebar />
          <div className="sh-main">
            <header className="sh-header">
              <button className="sh-menu-btn" onClick={() => setSidebarOpen((s) => !s)} aria-label="Menu">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect y="3" width="20" height="2" rx="1" fill="currentColor"/><rect y="9" width="20" height="2" rx="1" fill="currentColor"/><rect y="15" width="20" height="2" rx="1" fill="currentColor"/></svg>
              </button>
              <div className="sh-header-brand"><img src="/images/stonehead-logo-text.png" alt="stonehead ai" className="sh-logo-img" /><span className="sh-header-tagline">your always stone-d AI friend</span></div>
              <div className="sh-header-right">
                {view !== "memory" && activeThreadId && <DataToggle threadId={activeThreadId} currentState={threads.find((t) => t.id === activeThreadId)?.data_opt_in || false} />}
                <button className="sh-avatar-btn" onClick={() => setShowProfile(true)} title="Profile">{user?.username?.[0]?.toUpperCase() || "?"}</button>
              </div>
            </header>
            {view === "memory" ? (
              <MemoryPage />
            ) : (
              <>
                <div className="sh-tab-bar"><TabSwitcher /></div>
                <ChatWindow />
              </>
            )}
          </div>
        </div>
      </div>
    </AppContext.Provider>
  );
}

function AuthScreen() {
  const { handleLogin, handleRegister, handleForgotPassword, authView, setAuthView } = useApp();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [username, setUsername] = useState(""); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  async function handleSubmit(e) {
    e.preventDefault(); setError(""); setSubmitting(true);
    try { if (authView === "login") await handleLogin(email, password); else { if (!username.trim()) { setError("need a username, dude"); setSubmitting(false); return; } await handleRegister(email, password, username); } }
    catch (err) { setError(err.message || "something went wrong"); } finally { setSubmitting(false); }
  }
  async function onForgot() {
    setError("");
    if (!email.trim()) { setError("put your email in first"); return; }
    setSubmitting(true);
    try { await handleForgotPassword(email); }
    catch (err) { setError(err.message || "couldn't send that — try again"); } finally { setSubmitting(false); }
  }
  return (
    <div className="sh-auth-screen"><div className="sh-auth-card">
      <div className="sh-auth-logo">
        <img src="/images/stonehead-clean.png" alt="Stone Head AI" className="sh-auth-mascot" />
        <img src="/images/stonehead-logo-text.png" alt="stonehead ai" className="sh-logo-img sh-logo-img--large" />
        <p className="sh-tagline">Your Always Stone-D AI Friend</p>
      </div>
      {authView === "reset" ? <ResetPasswordForm /> : (
        <>
          <form onSubmit={handleSubmit} className="sh-auth-form">
            {authView === "register" && <input type="text" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} className="sh-input" autoComplete="username" />}
            <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} className="sh-input" autoComplete="email" required />
            <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} className="sh-input" autoComplete={authView === "login" ? "current-password" : "new-password"} required />
            {error && <p className="sh-error">{error}</p>}
            <button type="submit" className="sh-btn-primary" disabled={submitting}>{submitting ? "hold on..." : authView === "login" ? "come in" : "join up"}</button>
          </form>
          {authView === "login" && <button type="button" className="sh-auth-toggle" onClick={onForgot} disabled={submitting}>forgot your password?</button>}
          {!SIGNUP_DISABLED && <button className="sh-auth-toggle" onClick={() => setAuthView(authView === "login" ? "register" : "login")}>{authView === "login" ? "don't have an account? sign up" : "already here? log in"}</button>}
          {/* Signup notice. The agreement wording only makes sense on the
              register view — that's the moment somebody is actually agreeing
              to something — but the LINKS belong on both, or a returning user
              never sees them at all. Plain links to static pages, not a modal
              or a checkbox: consent GATING is its own spec; this publishes and
              discloses. */}
          {authView === "register" ? (
            <p className="sh-auth-legal">
              by signing up you're agreeing to the{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer">terms</a>
              {" "}and the{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a>.
              you have to be 13 or older, and 21+ for talk the plant.
            </p>
          ) : (
            <p className="sh-auth-legal">
              <a href="/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a>
              {" · "}
              <a href="/terms" target="_blank" rel="noopener noreferrer">terms</a>
            </p>
          )}
        </>
      )}
    </div></div>
  );
}

// §6c — shown when a recovery hash put us in the "reset" view. The token
// itself lives in App state; this form only collects the new password.
function ResetPasswordForm() {
  const { handleResetPassword, setAuthView } = useApp();
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  async function onSubmit(e) {
    e.preventDefault(); setError("");
    // Same minimum as register and as api/auth-reset-password.js.
    if (password.length < 8) { setError("password must be at least 8 characters"); return; }
    if (password !== confirm) { setError("those don't match"); return; }
    setSubmitting(true);
    try { await handleResetPassword(password); }
    catch (err) { setError(err.message || "couldn't update the password"); } finally { setSubmitting(false); }
  }
  return (
    <>
      <form onSubmit={onSubmit} className="sh-auth-form">
        <p className="sh-tagline">pick a new password</p>
        <input type="password" placeholder="new password" value={password} onChange={(e) => setPassword(e.target.value)} className="sh-input" autoComplete="new-password" required />
        <input type="password" placeholder="confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="sh-input" autoComplete="new-password" required />
        {error && <p className="sh-error">{error}</p>}
        <button type="submit" className="sh-btn-primary" disabled={submitting}>{submitting ? "hold on..." : "set it"}</button>
      </form>
      <button className="sh-auth-toggle" onClick={() => setAuthView("login")}>back to log in</button>
    </>
  );
}

function TabSwitcher() {
  const { activeTab, handleSwitchTab } = useApp();
  return (
    <div className="sh-tab-switcher">
      <button className={`sh-tab ${activeTab === "vibe" ? "sh-tab--active" : ""}`} onClick={() => handleSwitchTab("vibe")}>the vibe</button>
      <button className={`sh-tab ${activeTab === "plant" ? "sh-tab--active sh-tab--plant" : ""}`} onClick={() => handleSwitchTab("plant")}>talk the plant <span className="sh-tab-leaf">🌿</span></button>
    </div>
  );
}

function ChatWindow() {
  const { messages, activeTab, activeThreadId, handleSendMessage, loading, loadingNote, usageRemaining, user, photosRemaining, photoQuota, askRollover, addToast, showInstallBanner, handleInstall, dismissInstallBanner } = useApp();
  const [input, setInput] = useState(""); const scrollRef = useRef(null); const textareaRef = useRef(null);
  // Photos are a Talk the Plant feature. The button only exists on that tab,
  // and the server refuses a photo anywhere else.
  const photosOn = activeTab === "plant";
  const [photo, setPhoto] = useState(null); // { dataUrl, previewUrl } while drafting
  const [preparing, setPreparing] = useState(false);
  const fileRef = useRef(null);
  function discardPhoto() {
    setPhoto((p) => { if (p && p.previewUrl) URL.revokeObjectURL(p.previewUrl); return null; });
  }
  // Leaving the tab drops an unsent photo.
  useEffect(() => { if (!photosOn) discardPhoto(); }, [photosOn]);
  // Set when the user okayed a rollover photo before picking it; the photo
  // then carries allow_rollover to the server.
  const allowRolloverRef = useRef(false);
  function openPicker(allowRollover) {
    allowRolloverRef.current = !!allowRollover;
    if (fileRef.current) fileRef.current.click();
  }
  // The camera button checks the cached quota first. A stale quota (past the
  // daily reset) or photos left today: straight to the picker. Only rollover
  // left: the warning card, unless it's been turned off. Nothing left: say
  // when more arrive. The server still has the final say either way.
  function handleCameraTap() {
    const q = photoQuota;
    if (!quotaIsFresh(q) || q.remaining_today > 0) { openPicker(false); return; }
    if (q.rollover > 0) {
      askRollover({ remaining: q.rollover, threadId: activeThreadId, onOkay: () => openPicker(true) });
      return;
    }
    addToast(`that's all the photos for today. more at ${fmtTime(q.resets_at)}`);
  }
  async function handlePickPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // picking the same file twice should still fire
    if (!file) return;
    const allowRollover = allowRolloverRef.current;
    allowRolloverRef.current = false;
    setPreparing(true);
    try {
      const prepared = { ...(await preparePhoto(file)), ...(allowRollover ? { allowRollover: true } : {}) };
      setPhoto((p) => { if (p && p.previewUrl) URL.revokeObjectURL(p.previewUrl); return prepared; });
    } catch (err) {
      addToast(err && err.message === "too_big" ? "that photo's too big. try a screenshot of it" : "couldn't open that photo. try a jpg or a screenshot");
    } finally { setPreparing(false); }
  }
  useEffect(() => {
    if (!scrollRef.current) return;
    // Empty/welcome thread: keep the hero pinned to the top so the full
    // mascot is visible on open instead of auto-scrolling past it.
    if (messages.length === 0) scrollRef.current.scrollTop = 0;
    else scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);
  function handleSubmit(e) {
    if (e) e.preventDefault();
    if (loading || preparing) return;
    const text = input.trim();
    if (!text && !photo) return;
    if (photo) {
      handleSendMessage(text, { photo });
      setPhoto(null); // not revoked: the sent bubble is still showing it
    } else {
      handleSendMessage(text);
    }
    setInput(""); if (textareaRef.current) textareaRef.current.style.height = "auto";
  }
  const canSend = (!!input.trim() || !!photo) && !loading && !preparing;
  function handleKeyDown(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }
  function handleTextareaChange(e) { setInput(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 130) + "px"; }
  const showSuggestions = messages.length === 0;
  // The photo count sits under StoneHead's reply to the MOST RECENT photo only,
  // so an older count is never left on screen to go stale. Plant tab only.
  const latestPhotoReplyIndex = useMemo(() => {
    if (activeTab !== "plant") return -1;
    let lastPhoto = -1;
    messages.forEach((m, i) => { if (m.role === "user" && m.photo) lastPhoto = i; });
    if (lastPhoto < 0) return -1;
    for (let i = lastPhoto + 1; i < messages.length; i++) {
      if (messages[i].role === "assistant") return messages[i].isError ? -1 : i;
      if (messages[i].role === "user") return -1;
    }
    return -1;
  }, [messages, activeTab]);
  const showUsage = usageRemaining !== null && usageRemaining !== undefined;
  return (
    <div className="sh-chat-window">
      <div className="sh-messages" ref={scrollRef}>
        {showSuggestions && (
          <div className="sh-welcome">
            <div className="sh-welcome-mascot">
              <div className="sh-hero">
                <div className="glow"></div>
                <img src={activeTab === "plant" && user?.age_verified ? "/images/stonehead-smoke.png" : "/images/stonehead-clean.png"} alt="Stone Head" className="mascot sh-mascot-img" />
              </div>
            </div>
            <div className="sh-welcome-bubble">
              <span className="sh-welcome-spark" aria-hidden="true">✦</span>
              <p className="sh-welcome-text">{activeTab === "vibe" ? "hey... pull up a chair. what's on your mind?" : "what's good... ask me anything about the plant. if yours looks off, send me a pic."}</p>
            </div>
            <SuggestionChips tab={activeTab} onChipClick={(t) => handleSendMessage(t)} />
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={msg.id} message={msg} tab={activeTab}
            photoLine={i === latestPhotoReplyIndex ? photoCountLine(photoQuota) : null}
            onRetry={msg.isError && !msg.noRetry && messages[i - 1] ? () => handleSendMessage(messages[i - 1].content, msg.retryPhoto ? { photo: msg.retryPhoto } : {}) : null} />
        ))}
        {loading && (
          <div className="sh-typing-row">
            <div className="sh-bubble-avatar"><img src={activeTab === "plant" ? "/images/stonehead-avatar-smoke.png" : "/images/stonehead-avatar-clean.png"} alt="" className="sh-avatar-img" /></div>
            <div className="sh-typing"><div className="sh-typing-dot"/><div className="sh-typing-dot"/><div className="sh-typing-dot"/></div>
            {loadingNote && <span className="sh-typing-note">{loadingNote}</span>}
          </div>
        )}
      </div>
      <div className="sh-input-bar">
        {showInstallBanner && (
          <div className="sh-install-banner" role="region" aria-label="install StoneHead">
            <span className="sh-install-banner-text">📲 put StoneHead on your home screen</span>
            <button className="sh-install-banner-add" onClick={handleInstall}>add</button>
            <button className="sh-install-banner-close" onClick={dismissInstallBanner} aria-label="close">✕</button>
          </div>
        )}
        {showUsage && <div className="sh-usage-badge">{usageRemaining > 0 ? `${usageRemaining} left today` : "tapped out for today"}</div>}
        {photosOn && (photo || preparing) && (
          <div className="sh-photo-draft">
            {photo
              ? <img src={photo.previewUrl} alt="Your photo, ready to send" className="sh-photo-draft-thumb" />
              : <div className="sh-photo-draft-thumb sh-photo-draft-thumb--busy" aria-hidden="true" />}
            <div className="sh-photo-draft-body">
              <p className="sh-photo-draft-tip">{photo ? "white light, close up, and in focus reads best" : "getting the photo ready..."}</p>
              {photo && typeof photosRemaining === "number" && (
                <p className="sh-photo-draft-count">{photosRemaining} photo {photosRemaining === 1 ? "read" : "reads"} left today</p>
              )}
            </div>
            {photo && <button type="button" className="sh-photo-draft-remove" onClick={discardPhoto} aria-label="Remove photo">×</button>}
          </div>
        )}
        <div className="sh-input-form">
          {photosOn && (
            <>
              <input ref={fileRef} type="file" accept="image/*" className="sh-photo-input" onChange={handlePickPhoto} tabIndex={-1} aria-hidden="true" />
              {/* Not disabled at 0 left: that count goes stale overnight in an
                  open tab. The draft shows the count, and the server has the
                  final say (photo_limit). */}
              <button type="button" className="sh-attach-btn" onClick={handleCameraTap}
                disabled={loading || preparing}
                aria-label="Add a photo of your plant"
                title="Add a photo of your plant">
                <CameraIcon />
              </button>
            </>
          )}
          <textarea ref={textareaRef} value={input} onChange={handleTextareaChange} onKeyDown={handleKeyDown} maxLength={4000}
            placeholder={activeTab === "vibe" ? "say something..." : photo ? "what should I look at? (optional)" : "ask about a strain..."} className="sh-chat-input" disabled={loading} rows={1} />
          <button type="button" className={`sh-send-btn ${canSend ? "sh-send-btn--active" : ""}`}
            onClick={handleSubmit} disabled={!canSend}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// §6 — the model emits markdown emphasis (*can*, **Especially**) and the bubble
// rendered it as literal asterisks, including on the crisis path, which is the
// most sensitive screen in the app.
//
// Deliberately NOT a markdown library. Only inline emphasis ever showed up, the
// persona forbids headings and lists outright, and pulling in a parser to render
// two delimiters would mean shipping an HTML pipeline for prose we control.
//
// Returns React nodes, never HTML — no dangerouslySetInnerHTML, so model output
// can never become markup.
// The delimiter must hug its content on both sides, same as real markdown.
// Without that, "2 * 3 * 4" italicizes the 3.
const EMPHASIS_RE =
  /(\*\*[^\s*][^*\n]*?[^\s*]\*\*|\*\*[^\s*]\*\*|\*[^\s*][^*\n]*?[^\s*]\*|\*[^\s*]\*)/g;
const BOLD_RE = /^\*\*[^*\n]+\*\*$/;
const ITALIC_RE = /^\*[^*\n]+\*$/;

function renderInline(text) {
  const parts = String(text || "").split(EMPHASIS_RE);
  return parts.map((part, i) => {
    if (BOLD_RE.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (ITALIC_RE.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

// The resource card (Addendum B1). Rendered below the message, never inside
// the prose. Dismissible — and it comes back on the next message while the
// state is still active, because it's re-attached server-side each turn.
function SafetyCard({ card }) {
  const [dismissed, setDismissed] = useState(false);
  if (!card || dismissed) return null;
  return (
    <div className={`sh-safety-card sh-safety-card--${card.type}`} role="complementary" aria-label={card.title}>
      <div className="sh-safety-card-head">
        <span className="sh-safety-card-title">{card.title}</span>
        <button
          className="sh-safety-card-close"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >×</button>
      </div>
      {(card.resources || []).map((r, i) => (
        <div key={i} className="sh-safety-card-item">
          <div className="sh-safety-card-line">
            <span className="sh-safety-card-label">{r.label}</span>
            {r.href
              ? <a className="sh-safety-card-value" href={r.href} target="_blank" rel="noopener noreferrer">{r.value}</a>
              : <span className="sh-safety-card-value">{r.value}</span>}
          </div>
          {r.detail && <p className="sh-safety-card-detail">{r.detail}</p>}
          {(r.hrefLabel || r.secondaryLabel) && (
            <p className="sh-safety-card-links">
              {r.hrefLabel && <a href={r.href} target="_blank" rel="noopener noreferrer">{r.hrefLabel}</a>}
              {r.hrefLabel && r.secondaryLabel && <span> · </span>}
              {r.secondaryLabel && <a href={r.secondaryHref} target="_blank" rel="noopener noreferrer">{r.secondaryLabel}</a>}
            </p>
          )}
        </div>
      ))}
      {/* Tells someone in that moment exactly what they're looking at, and
          matches what the Terms of Service already say. */}
      <p className="sh-safety-card-attr">{card.attribution}</p>
    </div>
  );
}

function MessageBubble({ message, tab, onRetry, photoLine }) {
  const { handleHandoffClick } = useApp();
  const isUser = message.role === "user";
  // A photo sent with no words is stored as PHOTO_ONLY_TEXT. Show the photo
  // (or its marker), never the placeholder.
  const photoOnly = isUser && message.photo && (!message.content || message.content === PHOTO_ONLY_TEXT);
  return (
    <>
    <div className={`sh-bubble-row ${isUser ? "sh-bubble-row--user" : ""}`}>
      {!isUser && (
        <div className="sh-bubble-avatar"><img src={tab === "plant" ? "/images/stonehead-avatar-smoke.png" : "/images/stonehead-avatar-clean.png"} alt="" className="sh-avatar-img" /></div>
      )}
      <div className={`sh-bubble ${isUser ? "sh-bubble--user" : tab === "plant" ? "sh-bubble--assistant-plant" : "sh-bubble--assistant-vibe"}`}>
        {isUser && message.photo && (message.photoUrl
          ? <img src={message.photoUrl} alt="Your plant photo" className="sh-bubble-photo" />
          : <span className="sh-photo-chip" title="Photos are read once and not saved"><CameraIcon size={14} /> photo (not saved)</span>)}
        {!photoOnly && <p className="sh-bubble-text">{renderInline(message.content)}</p>}
        {!isUser && message.handoff === "plant" && message.handoff_message && (
          <button className="sh-handoff-btn" onClick={() => handleHandoffClick(message.handoff_message)}>
            take it to talk the plant 🌿
          </button>
        )}
        {onRetry && <button className="sh-retry-btn" onClick={onRetry}>↻ retry</button>}
        {!isUser && message.safetyCard && <SafetyCard card={message.safetyCard} />}
      </div>
    </div>
    {/* Only on real, stored model replies the server marked rateable: never
        a greeting, limit or error bubble, and never a safety turn. */}
    {!isUser && photoLine && <p className="sh-photo-count-line">{photoLine}</p>}
    {!isUser && message.rateable && !message.safetyCard && !message.isError && <FeedbackThumbs message={message} />}
    </>
  );
}

function ThumbIcon({ down = false, filled = false }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style={down ? { transform: "scaleY(-1)" } : undefined}
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3z" />
      <path d="M7 10l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7" />
    </svg>
  );
}

const FEEDBACK_MAX = 1000;
const FEEDBACK_COUNTER_FROM = 800;

function FeedbackThumbs({ message }) {
  const { handleRate, profile, addToast } = useApp();
  const [dialog, setDialog] = useState(null); // null | "up" | "down"
  const [busy, setBusy] = useState(false);
  const rating = message.rating || null;
  async function save(next, extra) {
    setBusy(true);
    try { await handleRate(message.id, next, extra); setDialog(null); return true; }
    catch (e) { addToast("couldn't save that. try again"); return false; }
    finally { setBusy(false); }
  }
  function onUp() {
    if (busy) return;
    if (rating === "up") return save(null);
    if (profile?.skip_training_prompt) return save("up");
    setDialog("up");
  }
  function onDown() {
    if (busy) return;
    if (rating === "down") return save(null);
    setDialog("down");
  }
  return (
    <div className="sh-feedback-row">
      <button className={`sh-thumb ${rating === "up" ? "sh-thumb--up" : ""}`} onClick={onUp} disabled={busy}
        aria-pressed={rating === "up"} aria-label={rating === "up" ? "remove thumbs up" : "thumbs up"} title="good reply">
        <ThumbIcon filled={rating === "up"} />
      </button>
      <button className={`sh-thumb ${rating === "down" ? "sh-thumb--down" : ""}`} onClick={onDown} disabled={busy}
        aria-pressed={rating === "down"} aria-label={rating === "down" ? "remove thumbs down" : "thumbs down"} title="something was off">
        <ThumbIcon down filled={rating === "down"} />
      </button>
      {dialog === "up" && <ThumbsUpDialog busy={busy} onCancel={() => setDialog(null)} onShare={(dontAsk, comment) => save("up", { ...(dontAsk ? { dont_ask_again: true } : {}), ...(comment ? { comment } : {}) })} />}
      {dialog === "down" && <ThumbsDownDialog busy={busy} onCancel={() => setDialog(null)} onSend={(comment) => save("down", comment ? { comment } : {})} />}
    </div>
  );
}

function ThumbsUpDialog({ busy, onCancel, onShare }) {
  const [dontAsk, setDontAsk] = useState(false);
  const [comment, setComment] = useState("");
  return (
    <div className="sh-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="sh-modal sh-feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="sh-fb-up-title">
        <h2 id="sh-fb-up-title">thanks, man.</h2>
        <p>this reply and the message before it may be used to train and improve StoneHead.</p>
        <textarea className="sh-input sh-feedback-text" rows={3} maxLength={FEEDBACK_MAX} value={comment}
          onChange={(e) => setComment(e.target.value)} placeholder="what hit right? (optional)" disabled={busy} />
        {comment.length > FEEDBACK_COUNTER_FROM && <span className="sh-feedback-count">{comment.length}/{FEEDBACK_MAX}</span>}
        <label className="sh-feedback-check">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} disabled={busy} />
          don't show this again
        </label>
        <div className="sh-feedback-actions">
          <button className="sh-btn-primary" onClick={() => onShare(dontAsk, comment.trim())} disabled={busy}>{busy ? "..." : "share it"}</button>
          <button className="sh-btn-secondary" onClick={onCancel} disabled={busy}>cancel</button>
        </div>
      </div>
    </div>
  );
}

function ThumbsDownDialog({ busy, onCancel, onSend }) {
  const [comment, setComment] = useState("");
  return (
    <div className="sh-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="sh-modal sh-feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="sh-fb-down-title">
        <h2 id="sh-fb-down-title">what was off?</h2>
        <textarea className="sh-input sh-feedback-text" rows={4} maxLength={FEEDBACK_MAX} value={comment}
          onChange={(e) => setComment(e.target.value)} placeholder="tell me what went wrong" disabled={busy} autoFocus />
        {comment.length > FEEDBACK_COUNTER_FROM && <span className="sh-feedback-count">{comment.length}/{FEEDBACK_MAX}</span>}
        <p>sending this shares this reply and your message before it with me, so I can see what happened.</p>
        <div className="sh-feedback-actions">
          <button className="sh-btn-primary" onClick={() => onSend(comment.trim())} disabled={busy}>{busy ? "..." : "send"}</button>
          <button className="sh-btn-secondary" onClick={onCancel} disabled={busy}>cancel</button>
        </div>
      </div>
    </div>
  );
}

function SuggestionChips({ tab, onChipClick }) {
  // Picked once per tab while this screen is showing, so the set never
  // reshuffles under someone's thumb. A new empty chat gets a new set.
  const chips = useMemo(() => pickChips(tab, loadRecent(tab)), [tab]);
  useEffect(() => { saveRecent(tab, chips.map((c) => c.text)); }, [tab, chips]);
  return (
    <div className="sh-chips-section">
      <span className="sh-chips-label">try asking me about...</span>
      <div className="sh-chips">
        {chips.map((c) => (
          <button key={c.text} className="sh-chip" onClick={() => onChipClick(c.text)}>
            <span className="sh-chip-icon">{c.icon}</span><span className="sh-chip-text">{c.text}</span><span className="sh-chip-arrow">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadSidebar() {
  const { threads, activeThreadId, handleNewThread, handleSelectThread, handleDeleteThread, handleRenameThread, sidebarOpen, view, setView, setSidebarOpen, canInstall, handleInstall } = useApp();
  const [editingId, setEditingId] = useState(null); const [editTitle, setEditTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [discordOpen, setDiscordOpen] = useState(false);
  function startRename(t) { setEditingId(t.id); setEditTitle(t.title || ""); }
  function saveRename(id) { if (editTitle.trim()) handleRenameThread(id, editTitle.trim()); setEditingId(null); }
  function goChat() { setView("chat"); setSidebarOpen(false); }
  function goMemory() { setView("memory"); setSidebarOpen(false); }
  return (
    <aside className={`sh-sidebar ${sidebarOpen ? "sh-sidebar--open" : ""}`}>
      <div className="sh-sidebar-nav">
        <button className={`sh-nav-item ${view === "chat" ? "sh-nav-item--active" : ""}`} onClick={goChat}>💬 chat</button>
        <button className={`sh-nav-item ${view === "memory" ? "sh-nav-item--active" : ""}`} onClick={goMemory}>🧠 memory</button>
        <button className="sh-nav-item" onClick={() => setDiscordOpen((o) => !o)} aria-expanded={discordOpen} aria-controls="sh-discord-sub">
          👾 discord<span className={`sh-nav-chevron ${discordOpen ? "sh-nav-chevron--open" : ""}`} aria-hidden="true">▸</span>
        </button>
        {discordOpen && (
          <div className="sh-nav-sub" id="sh-discord-sub">
            <a className="sh-nav-subitem" href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">join the StoneHead server</a>
            {DISCORD_BOT_INSTALL_URL && <a className="sh-nav-subitem" href={DISCORD_BOT_INSTALL_URL} target="_blank" rel="noopener noreferrer">add the bot to your server</a>}
          </div>
        )}
        {canInstall && <button className="sh-nav-item" onClick={() => { setSidebarOpen(false); handleInstall(); }}>📲 get the app</button>}
      </div>
      <div className="sh-sidebar-header"><span className="sh-sidebar-title">THREADS</span><button className="sh-new-thread-btn" onClick={handleNewThread}>+ new</button></div>
      <div className="sh-thread-list">
        {threads.length === 0 && <p className="sh-no-threads">no threads yet... start one</p>}
        {threads.map((thread) => (
          <div key={thread.id} className={`sh-thread-item ${thread.id === activeThreadId ? "sh-thread-item--active" : ""}`}>
            {editingId === thread.id ? (
              <input className="sh-thread-edit-input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveRename(thread.id); if (e.key === "Escape") setEditingId(null); }}
                onBlur={() => saveRename(thread.id)} autoFocus />
            ) : (
              <button className="sh-thread-content" onClick={() => handleSelectThread(thread.id)}>
                <span className="sh-thread-title">{thread.title || "untitled"}</span>
                <span className="sh-thread-time">{relativeTime(thread.updated_at || thread.created_at)}</span>
              </button>
            )}
            {editingId !== thread.id && (
              <div className="sh-thread-actions">
                <button className="sh-thread-action-btn" onClick={(e) => { e.stopPropagation(); startRename(thread); }} title="Rename">✎</button>
                {confirmDeleteId === thread.id ? (
                  <><button className="sh-thread-action-btn sh-thread-action-btn--danger" onClick={(e) => { e.stopPropagation(); handleDeleteThread(thread.id); setConfirmDeleteId(null); }}>✓</button>
                  <button className="sh-thread-action-btn" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}>✕</button></>
                ) : (
                  <button className="sh-thread-action-btn" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(thread.id); }} title="Delete">✕</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function DataToggle({ threadId, currentState }) {
  const { handleToggleData } = useApp();
  return (
    <div className="sh-data-toggle" title="Share anonymized data for training">
      <label className="sh-toggle-label">
        <input type="checkbox" checked={currentState} onChange={() => handleToggleData(threadId, currentState)} className="sh-toggle-input" />
        <span className="sh-toggle-track"><span className="sh-toggle-thumb" /></span><span className="sh-toggle-text">data</span>
      </label>
    </div>
  );
}

function AgeGateModal() {
  const { handleAgeVerify, showAgeGate, dismissAgeGate } = useApp();
  if (!showAgeGate) return null;
  return (
    <div className="sh-modal-overlay"><div className="sh-modal sh-age-gate">
      <img src="/images/stonehead-smoke.png" alt="" className="sh-age-mascot" />
      <h2>hold up</h2>
      <p>Talk the Plant is for people 21 and older. Are you 21 years of age or older?</p>
      <div className="sh-age-actions">
        <button className="sh-btn-primary" onClick={handleAgeVerify}>yeah, I'm 21+</button>
        <button className="sh-btn-secondary" onClick={dismissAgeGate}>nah, take me back</button>
      </div>
    </div></div>
  );
}

// One-time acknowledgement of the terms and privacy policy, for every account
// old and new. Gated server-side on TOS_VERSION, so bumping that constant
// re-prompts everybody — which is the mechanism behind the promise in the
// Terms that meaningful changes get announced rather than slipped in.
//
// NOT DISMISSIBLE. No × and no overlay click-through: a modal you can dismiss
// without answering records nothing, and then it isn't an acknowledgement, it
// is a popup.
//
// DECLINE LOGS OUT AND DELETES NOTHING. It is fully recoverable — log back in
// and this is waiting. That matters because a real choice needs a real second
// option, and because somebody who misreads two buttons shouldn't lose their
// threads over it.
function TosModal() {
  const { handleAcceptTos, handleLogout, addToast } = useApp();
  const [submitting, setSubmitting] = useState(false);
  async function accept() {
    setSubmitting(true);
    try { await handleAcceptTos(); }
    catch (e) { addToast("couldn't save that — try again"); setSubmitting(false); }
  }
  return (
    <div className="sh-modal-overlay sh-modal-overlay--top"><div className="sh-modal sh-tos-modal">
      <h2>before you keep going</h2>
      <p>
        StoneHead's terms and privacy policy are published. They're written
        plainly and they're worth the two minutes — the privacy one covers what
        the app remembers about you, how to delete it, and what the safety
        layer logs.
      </p>
      <p className="sh-tos-links">
        <a href="/terms" target="_blank" rel="noopener noreferrer">terms of service</a>
        {" · "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a>
      </p>
      <p className="sh-tos-fine">
        You need to be 13 or older to use StoneHead, and 21+ for Talk the Plant.
      </p>
      <div className="sh-age-actions">
        <button className="sh-btn-primary" onClick={accept} disabled={submitting}>
          {submitting ? "one sec..." : "I'm good with that"}
        </button>
        <button className="sh-btn-secondary" onClick={handleLogout} disabled={submitting}>
          not for me
        </button>
      </div>
      <p className="sh-tos-fine">
        "not for me" just logs you out — nothing gets deleted, and you can come
        back whenever.
      </p>
    </div></div>
  );
}

function ProfilePage() {
  const { user, profile, setShowProfile, setShowSubscription, handleLogout, loadProfile, addToast, photoQuota, saveSetting } = useApp();
  const passActive = !!profile?.pass_active;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  useEffect(() => { loadProfile(); }, []);
  function startEditName() { setNameDraft(user?.username || ""); setEditingName(true); }
  async function handleSaveName() {
    const next = nameDraft.trim();
    if (!next || next === user?.username) { setEditingName(false); return; }
    if (next.length < 2 || next.length > 30) { addToast("username must be 2-30 characters"); return; }
    setSavingName(true);
    try {
      await apiPost("/api/profile/username-update", { username: next });
      await loadProfile();
      setEditingName(false);
      addToast("username updated");
    } catch (e) {
      // Server says why — "username already taken" is the common case.
      addToast(e.message || "couldn't update username");
    } finally { setSavingName(false); }
  }
  if (confirmingDelete) return <DeleteAccountView onCancel={() => setConfirmingDelete(false)} />;
  if (showSupport) return <SupportView onDone={() => setShowSupport(false)} />;
  return (
    <div className="sh-modal-overlay"><div className="sh-modal sh-profile">
      <div className="sh-modal-close-row"><button className="sh-close-btn" onClick={() => setShowProfile(false)}>×</button></div>
      <div className="sh-profile-header">
        <div className="sh-profile-avatar">{user?.username?.[0]?.toUpperCase() || "?"}</div>
        {editingName ? (
          <div className="sh-username-edit">
            <input
              className="sh-username-input"
              value={nameDraft}
              maxLength={30}
              autoFocus
              disabled={savingName}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditingName(false); }}
            />
            <button className="sh-username-btn" onClick={handleSaveName} disabled={savingName}>{savingName ? "..." : "save"}</button>
            <button className="sh-username-btn sh-username-btn--cancel" onClick={() => setEditingName(false)} disabled={savingName}>cancel</button>
          </div>
        ) : (
          <div className="sh-username-row">
            <h2>{user?.username || "..."}</h2>
            <button className="sh-username-edit-btn" onClick={startEditName} title="edit username" aria-label="edit username">✎</button>
          </div>
        )}
        <span className={`sh-sub-badge ${passActive ? "sh-sub-badge--active" : ""}`}>{passActive ? (profile?.subscription_expires ? `pass active until ${fmtDay(profile.subscription_expires)}` : "pass active") : "free tier"}</span>
        {user?.is_founder && (
          <span className="sh-founder-badge" title={`OG Sesher #${user.founder_number}`}>
            ★ og sesher{user.founder_number ? ` #${user.founder_number}` : ""}
          </span>
        )}
        {/* New-system badges render after founder — one strip, two data sources. */}
        {(user?.badges || []).map((b) => (
          <span
            key={b.key}
            className="sh-badge"
            style={b.color ? { color: b.color, background: `${b.color}2e` } : undefined}
            title={`${b.label}${b.number ? ` #${b.number}` : ""}`}
          >
            ★ {b.label.toLowerCase()}{b.number ? ` #${b.number}` : ""}
          </span>
        ))}
      </div>
      {photoQuota && (
        <div className="sh-profile-section sh-profile-photos">
          <h3>PHOTOS</h3>
          <p>{photoQuota.daily_limit} per day · {quotaIsFresh(photoQuota) ? photoQuota.remaining_today : photoQuota.daily_limit} left today</p>
          {(photoQuota.earns_rollover || photoQuota.rollover > 0) && (
            <p>{photoQuota.rollover} rollover · half expire {fmtDay(photoQuota.next_halving)}</p>
          )}
          {!photoQuota.earns_rollover && <p className="sh-profile-muted">with a pass, each day you don't use all your photos adds 1 rollover photo</p>}
        </div>
      )}
      <div className="sh-profile-section sh-profile-settings">
        <label className="sh-setting">
          <span>warn before using a rollover photo</span>
          <input type="checkbox" role="switch" checked={profile?.warn_rollover !== false}
            onChange={(e) => saveSetting("warn_rollover", e.target.checked)} />
        </label>
        <label className="sh-setting">
          <span>ask before sharing rated replies for training</span>
          <input type="checkbox" role="switch" checked={!profile?.skip_training_prompt}
            onChange={(e) => saveSetting("skip_training_prompt", !e.target.checked)} />
        </label>
      </div>
      <div className="sh-profile-actions">
        <button className="sh-btn-primary" onClick={() => { setShowProfile(false); setShowSubscription(true); }}>{passActive ? "get more time" : "get a pass"}</button>
        <button className="sh-btn-secondary" onClick={() => setShowSupport(true)}>contact support</button>
        <button className="sh-btn-danger" onClick={handleLogout}>log out</button>
        <button className="sh-delete-account-link" onClick={() => setConfirmingDelete(true)}>delete my account</button>
      </div>
      {/* The signup notice is only on the register view, which means an
          existing user had no route to either document from inside the app.
          A privacy policy you can't reach after signup isn't published in any
          way that matters — and this one tells people how to delete their
          memories and what the safety layer logs. */}
      <p className="sh-profile-legal">
        <a href="/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a>
        {" · "}
        <a href="/terms" target="_blank" rel="noopener noreferrer">terms</a>
      </p>
      <p className="sh-profile-version">StoneHead v{APP_VERSION}</p>
    </div></div>
  );
}

// iOS has no install prompt to call, so this walks through Safari's own
// Add to Home Screen (Android gets its browser-menu steps the same way when
// Chrome hasn't handed over its prompt yet). The login line matters: a home-screen app on iPhone
// keeps its own storage, so people sign in once inside it.
function InstallSheet({ platform, onClose }) {
  return (
    <div className="sh-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sh-modal sh-install-sheet" role="dialog" aria-modal="true" aria-labelledby="sh-install-title">
        <h2 id="sh-install-title">put StoneHead on your home screen</h2>
        {platform === "android" ? (
          <ol>
            <li>tap your browser's menu (the <strong>⋮</strong> in the corner)</li>
            <li>tap <strong>Install app</strong> or <strong>Add to Home screen</strong></li>
            <li>tap <strong>Install</strong></li>
          </ol>
        ) : (
          <>
            <ol>
              <li>tap the share button (the square with the arrow)</li>
              <li>scroll down and tap <strong>Add to Home Screen</strong></li>
              <li>tap <strong>Add</strong></li>
            </ol>
            <p>you'll log in once inside the app. after that it remembers you.</p>
          </>
        )}
        <button className="sh-btn-primary" onClick={onClose}>got it</button>
      </div>
    </div>
  );
}

// Same modal as the profile, swapped to a confirm view. The server takes the
// account from the session and needs the literal word, so this input is the
// whole confirmation.
function DeleteAccountView({ onCancel }) {
  const { profile, setShowProfile, handleAccountDeleted } = useApp();
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const ready = typed.trim().toLowerCase() === "delete";
  async function handleDelete() {
    if (!ready || deleting) return;
    setDeleting(true); setError("");
    try {
      await apiPost("/api/account/delete", { confirm: "delete" });
      handleAccountDeleted();
    } catch (e) {
      setError(e.message || "couldn't delete your account. try again in a sec");
      setDeleting(false);
    }
  }
  return (
    <div className="sh-modal-overlay"><div className="sh-modal sh-profile">
      <div className="sh-modal-close-row"><button className="sh-close-btn" onClick={() => setShowProfile(false)} disabled={deleting}>×</button></div>
      <div className="sh-delete-account">
        <h2>delete your account?</h2>
        <p>this wipes everything: your conversations, what StoneHead remembers, your liked strains, your photo reads, and your login. it can't be undone.</p>
        <p>one exception: summaries from chats where you turned the data toggle on are kept, with no name, email, or anything that links them back to you.</p>
        {/* Passes are one-time purchases, so there's no billing to cancel. What
            they do lose is the time left on a pass. */}
        {profile?.pass_active && (
          <p className="sh-delete-account-warn">
            heads up: your pass runs until {profile.subscription_expires ? fmtDay(profile.subscription_expires) : "later"}. deleting your account ends it, and that time is lost. bought it in the last 3 days? email me for a refund before you delete.
          </p>
        )}
        <p>type <strong>delete</strong> to confirm.</p>
        <input className="sh-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="delete"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={deleting}
          onKeyDown={(e) => { if (e.key === "Enter") handleDelete(); }} aria-label="type delete to confirm" />
        {error && <p className="sh-error">{error}</p>}
        <div className="sh-profile-actions">
          <button className="sh-btn-delete" onClick={handleDelete} disabled={!ready || deleting}>{deleting ? "deleting..." : "delete everything"}</button>
          <button className="sh-btn-secondary" onClick={onCancel} disabled={deleting}>keep my account</button>
        </div>
      </div>
    </div></div>
  );
}

// Support form: where to reply, and what's wrong. The server attaches the
// account id, username and account email from the session (api/support.js).
function SupportView({ onDone }) {
  const { profile, setShowProfile, addToast } = useApp();
  const [email, setEmail] = useState(profile?.email || "");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const ready = email.trim().length > 3 && message.trim().length > 0;
  async function handleSend() {
    if (!ready || sending) return;
    setSending(true); setError("");
    try {
      await apiPost("/api/support", { email: email.trim(), message: message.trim() });
      addToast("sent. I'll get back to you by email");
      onDone();
    } catch (e) {
      setError(e.message || "couldn't send that. try again in a sec");
      setSending(false);
    }
  }
  return (
    <div className="sh-modal-overlay"><div className="sh-modal sh-profile">
      <div className="sh-modal-close-row"><button className="sh-close-btn" onClick={() => setShowProfile(false)} disabled={sending}>×</button></div>
      <div className="sh-support">
        <h2>contact support</h2>
        <p>something broken, a billing question, anything. your account info is attached automatically so I can find you.</p>
        <label className="sh-support-label" htmlFor="sh-support-email">email to reply to</label>
        <input id="sh-support-email" className="sh-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={254} disabled={sending} />
        <label className="sh-support-label" htmlFor="sh-support-message">what's going on?</label>
        <textarea id="sh-support-message" className="sh-input sh-support-message" value={message} onChange={(e) => setMessage(e.target.value)}
          maxLength={2000} rows={6} disabled={sending} />
        {error && <p className="sh-error">{error}</p>}
        <div className="sh-profile-actions">
          <button className="sh-btn-primary" onClick={handleSend} disabled={!ready || sending}>{sending ? "sending..." : "send"}</button>
          <button className="sh-btn-secondary" onClick={onDone} disabled={sending}>back</button>
        </div>
      </div>
    </div></div>
  );
}

function MemoryPage() {
  const { user, addToast } = useApp();
  const [core, setCore] = useState(null); // { pinned, core } or null
  useEffect(() => { loadCore(); }, []);
  async function loadCore() {
    try { const d = await apiGet("/api/core-memories/get"); setCore({ pinned: d.pinned || [], core: d.core || [] }); }
    catch (e) { setCore({ pinned: [], core: [] }); }
  }
  async function togglePin(id, pinned) {
    try { await apiPost("/api/memory/pin", { memory_id: id, pinned }); await loadCore(); }
    catch (e) { addToast("couldn't update pin"); }
  }
  const pinned = core?.pinned || [];
  const coreList = core?.core || [];
  return (
    <div className="sh-memory-page">
      <div className="sh-memory-intro">
        <h2>memory</h2>
        <p className="sh-memory-tagline">here's what I've got on you{user?.username ? `, ${user.username}` : ""}. all yours — keep what matters, clear what doesn't.</p>
      </div>

      <MemoryGroup title="PINNED" subtitle="what you marked to keep" count={pinned.length} empty="pin a memory to keep it here.">
        <div className="sh-memory-list">{pinned.map((m) => <CoreCard key={m.id} m={m} onTogglePin={togglePin} />)}</div>
      </MemoryGroup>

      {SHOW_CORE && (
        <MemoryGroup title="CORE MEMORIES" subtitle="what Stone Head's reflection surfaced" count={coreList.length} empty="nothing yet — these grow as you talk.">
          <div className="sh-memory-list">{coreList.map((m) => <CoreCard key={m.id} m={m} onTogglePin={togglePin} />)}</div>
        </MemoryGroup>
      )}

      <LikedStrainsSection />

      {!SHOW_CORE && <RecentSessionsSection onPinned={loadCore} />}
    </div>
  );
}

function MemoryGroup({ title, subtitle, count, empty, children, action }) {
  return (
    <div className="sh-mem-group">
      <div className="sh-mem-group-head">
        <div className="sh-mem-group-titles"><h3>{title}</h3>{subtitle && <span className="sh-mem-sub">{subtitle}</span>}</div>
        {count > 0 && action}
      </div>
      {!count ? <p className="sh-empty-strains">{empty}</p> : children}
    </div>
  );
}

function CoreCard({ m, onTogglePin }) {
  return (
    <div className="sh-mem-card">
      <p className="sh-mem-text">{m.text}</p>
      {m.why_it_carries && <p className="sh-mem-why">{m.why_it_carries}</p>}
      <button className="sh-mem-pin" onClick={() => onTogglePin(m.id, !m.pinned)}>{m.pinned ? "📌 unpin" : "📌 pin"}</button>
    </div>
  );
}

function LikedStrainsSection() {
  const { addToast } = useApp();
  const [strains, setStrains] = useState(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { load(); }, []);
  async function load() {
    try { const d = await apiGet("/api/strains/liked"); setStrains(d.liked_strains || []); }
    catch (e) { setStrains([]); }
  }
  async function remove(name) {
    try { await apiPost("/api/strains/liked/update", { action: "remove", strain_name: name }); setStrains((s) => s.filter((x) => x.strain_name !== name)); }
    catch (e) { addToast("couldn't remove that"); }
  }
  if (strains === null) return null;
  const shown = expanded ? strains : strains.slice(0, 5);
  return (
    <MemoryGroup title="LIKED STRAINS" subtitle="strains you've saved" count={strains.length}
      empty="none yet... tell Stone Head about strains you like"
      action={strains.length > 5 && <button className="sh-seeall" onClick={() => setExpanded((e) => !e)}>{expanded ? "show less" : "see all"}</button>}>
      <div className="sh-strain-list">
        {shown.map((s, i) => (
          <div key={s.strain_name + i} className="sh-strain-card">
            <div className="sh-strain-header">
              <span className="sh-strain-name">{displayStrainName(s.strain_name)}</span>
              {s.strain_type && <span className={`sh-strain-type sh-strain-type--${s.strain_type}`}>{s.strain_type}</span>}
            </div>
            {s.notes && <p className="sh-strain-notes">{s.notes}</p>}
            <button className="sh-mem-remove" onClick={() => remove(s.strain_name)}>remove</button>
          </div>
        ))}
      </div>
    </MemoryGroup>
  );
}

function RecentSessionsSection({ onPinned }) {
  const { addToast } = useApp();
  const [memories, setMemories] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);
  useEffect(() => { load(); }, []);
  async function load() {
    try { const d = await apiGet("/api/memories/get"); setMemories(d.memories || []); }
    catch (e) { setMemories([]); }
  }
  async function clearOne(id) {
    try { await apiPost("/api/memories/clear", { memory_id: id }); setMemories((m) => m.filter((x) => x.id !== id)); }
    catch (e) { addToast("couldn't forget that one"); }
  }
  async function pin(m) {
    try { await apiPost("/api/memory/pin", { summary: m.summary, source_session_id: m.id }); addToast("pinned"); if (onPinned) onPinned(); }
    catch (e) { addToast("couldn't pin that"); }
  }
  async function clearAll() {
    setClearing(true);
    try { await apiPost("/api/memories/clear", {}); setMemories([]); }
    catch (e) { addToast("couldn't clear memories"); } finally { setClearing(false); }
  }
  if (memories === null) return null;
  const shown = expanded ? memories : memories.slice(0, 3);
  return (
    <MemoryGroup title="RECENT SESSIONS" subtitle="what Stone Head took from your chats" count={memories.length}
      empty="nothing yet... the more you two talk, the more he'll hold onto"
      action={
        <div className="sh-mem-actions">
          {memories.length > 3 && <button className="sh-seeall" onClick={() => setExpanded((e) => !e)}>{expanded ? "show less" : "see all"}</button>}
          {expanded && <button className="sh-memory-clear-all" onClick={clearAll} disabled={clearing}>{clearing ? "clearing..." : "clear all"}</button>}
        </div>
      }>
      <div className="sh-memory-list">
        {shown.map((m) => (
          <div key={m.id} className="sh-memory-card">
            <div className="sh-memory-meta">
              <span className={`sh-memory-frame sh-memory-frame--${m.frame_tag}`}>{m.frame_tag}</span>
              <span className="sh-memory-tab">{m.tab}</span>
              <span className="sh-memory-time">{relativeTime(m.created_at)}</span>
              {expanded && <button className="sh-memory-clear" onClick={() => clearOne(m.id)} title="Forget this">✕</button>}
            </div>
            <p className="sh-memory-summary">{m.summary}</p>
            <button className="sh-mem-pin" onClick={() => pin(m)}>📌 pin</button>
          </div>
        ))}
      </div>
    </MemoryGroup>
  );
}

// The pass picker (2.1). One-time Stripe purchases; buying while a pass is
// active adds the time after it. The pass itself is granted by the Stripe
// webhook, so this page only ever sends people to Checkout.
function SubscriptionPage() {
  const { setShowSubscription, profile, addToast } = useApp();
  const [busy, setBusy] = useState(null); // the pass being bought
  const active = !!profile?.pass_active;
  const limits = profile?.photo_limits || null;
  // After a refund the server refuses new passes for a while; say so up front.
  // Ticks every 30s so the countdown moves and the passes unlock on their own at zero.
  const [now, setNow] = useState(() => Date.now());
  const blockedMs = profile?.pass_blocked_until ? new Date(profile.pass_blocked_until).getTime() - now : 0;
  const blockedUntil = blockedMs > 0 ? profile.pass_blocked_until : null;
  useEffect(() => {
    if (!blockedUntil) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [blockedUntil]);
  async function buy(pass) {
    if (busy || blockedUntil) return;
    setBusy(pass);
    try {
      const { url } = await apiPost("/api/checkout/create", { pass });
      // So the return trip can tell when the new end date has landed.
      try { sessionStorage.setItem("sh_prev_expires", profile?.subscription_expires || ""); } catch {}
      window.location.href = url;
    } catch (e) {
      addToast(e.message || "couldn't start checkout. try again in a sec");
      setBusy(null);
    }
  }
  return (
    <div className="sh-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setShowSubscription(false); }}>
      <div className="sh-modal sh-subscription" role="dialog" aria-modal="true" aria-labelledby="sh-pass-title">
        <div className="sh-modal-close-row"><button className="sh-close-btn" onClick={() => setShowSubscription(false)} disabled={!!busy}>×</button></div>
        <h2 id="sh-pass-title">{active ? "get more time" : "get a pass"}</h2>
        <p className="sh-sub-desc">
          unlimited messages{limits ? `, ${limits.pass} photos a day` : ", more photos a day"}, and 1 rollover photo for each day you don't use them all.
          {active && profile?.subscription_expires ? ` your pass runs until ${fmtDay(profile.subscription_expires)}; a new one starts after that.` : ""}
        </p>
        <div className="sh-pass-cards">
          <button className="sh-pass-card" onClick={() => buy("7day")} disabled={!!busy || !!blockedUntil}>
            <span className="sh-pass-days">7 days</span>
            <span className="sh-pass-price">{busy === "7day" ? "..." : "$1.99"}</span>
          </button>
          <button className="sh-pass-card" onClick={() => buy("30day")} disabled={!!busy || !!blockedUntil}>
            <span className="sh-pass-days">30 days</span>
            <span className="sh-pass-price">{busy === "30day" ? "..." : "$7"}</span>
          </button>
        </div>
        {blockedUntil
          ? <p className="sh-pass-note">you got a refund recently, so passes open back up {fmtDay(blockedUntil)} · {fmtCountdown(blockedMs)} left</p>
          : <p className="sh-pass-note">one-time purchase, no auto-renew.</p>}
      </div>
    </div>
  );
}

// "this uses a rollover photo". Cancel, the X, tapping outside, and the
// phone's back button all close it with nothing used.
function RolloverCard({ ask, onClose }) {
  const { saveSetting } = useApp();
  useEffect(() => {
    // A history entry while open, so the back button closes the card instead
    // of leaving the app.
    window.history.pushState({ shRollover: true }, "");
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (window.history.state && window.history.state.shRollover) window.history.back();
    };
  }, []);
  function proceed(remember) {
    if (remember === "thread") markRolloverOkForThread(ask.threadId);
    if (remember === "always") saveSetting("warn_rollover", false);
    const okay = ask.onOkay;
    onClose();
    okay(); // synchronous, still inside the tap: the photo picker needs that
  }
  const n = ask.remaining;
  return (
    <div className="sh-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sh-modal sh-rollover-card" role="dialog" aria-modal="true" aria-labelledby="sh-rollover-title">
        <div className="sh-modal-close-row"><button className="sh-close-btn" onClick={onClose} aria-label="close">×</button></div>
        <h2 id="sh-rollover-title">this uses a rollover photo</h2>
        <p>you've got {n} left.</p>
        <div className="sh-feedback-actions">
          <button className="sh-btn-primary" onClick={() => proceed(null)}>okay</button>
          {ask.threadId && <button className="sh-btn-secondary" onClick={() => proceed("thread")}>don't show again in this thread</button>}
          <button className="sh-btn-secondary" onClick={() => proceed("always")}>don't show again</button>
          <button className="sh-btn-secondary" onClick={onClose}>cancel</button>
        </div>
      </div>
    </div>
  );
}

function LimitMessage() {
  return <div className="sh-limit-message"><div className="sh-bubble sh-bubble--assistant-vibe sh-bubble--limit"><p className="sh-bubble-text">hey bro... I'm kinda tapped for today. come back tomorrow, I'll be right here.</p></div></div>;
}
