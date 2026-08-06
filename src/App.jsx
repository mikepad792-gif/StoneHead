import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";

const API_BASE = "";
const DISCORD_INVITE_URL = "https://discord.gg/twJuwv6WT";
const AppContext = createContext(null);
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
  const data = await res.json();
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
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}
async function apiPost(endpoint, body) { return apiCall(endpoint, { method: "POST", body: JSON.stringify(body) }); }
async function apiGet(endpoint, params = {}) { const qs = new URLSearchParams(params).toString(); return apiCall(qs ? `${endpoint}?${qs}` : endpoint, { method: "GET" }); }

// §7: all four are in the USER's voice, and none can be satisfied by a single
// deep line — the previous set was quote-vending prompts, which taught the
// exact behavior the giveaway rejects. Chip 3 is the first-contact demo of the
// voice rewrite: it asks him to bring something, which surfaces a tide pool.
const VIBE_SUGGESTIONS = [
  { text: "i don't even know what to say to you", icon: "💭" },
  { text: "there's something i can't stop thinking about", icon: "🌀" },
  { text: "what do you think about when nobody's talking to you?", icon: "🗿" },
  { text: "i keep going back and forth on something", icon: "🔀" },
];
const PLANT_SUGGESTIONS = [
  // §7: 2 strain + 2 grow, each phrased as a real user message. The grow chips
  // teach what's newly possible (diagnosis + cultivation-about-a-strain).
  { text: "what's good for a lazy Sunday?", icon: "🛋" },
  { text: "something that won't make me anxious", icon: "🌿" },
  { text: "my leaves are turning yellow, help", icon: "🍃" },
  { text: "is Blue Dream hard to grow?", icon: "🌱" },
];

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
  const [recoveryToken, setRecoveryToken] = useState(null); // set from the reset-email hash

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

  async function loadProfile() {
    try {
      const p = await apiGet("/api/profile/get");
      setProfile(p);
      setUser({ user_id: p.user_id, username: p.username, is_subscribed: p.is_subscribed, age_verified: p.age_verified, is_founder: p.is_founder, founder_number: p.founder_number, badges: p.badges || [] });
      setUsageRemaining(p.usage_remaining ?? null);
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
  async function handleSendMessage(text, opts = {}) {
    if (!text.trim()) return;
    const tab = opts.tab || activeTab;
    let threadId = opts.threadId || activeThreadId;
    if (!threadId) {
      try { const data = await apiPost("/api/threads/create", { tab }); threadId = data.thread_id; setActiveThreadId(threadId); loadThreads(); }
      catch (e) { addToast("couldn't start thread"); return; }
    }
    setMessages((p) => [...p, { id: `temp-${Date.now()}`, role: "user", content: text, created_at: new Date().toISOString() }]);
    setLoading(true);
    try {
      // supports_safety_card tells the backend this bundle can RENDER the
      // card. Without it the backend appends the resource to the message text
      // instead, so an old cached bundle degrades to a visible number rather
      // than silently dropping the disclosure.
      const data = await apiPost("/api/chat/send", { message: text, thread_id: threadId, tab, supports_safety_card: true });
      // A blank/whitespace reply must never render as an empty bubble — treat
      // it as a failed send so the user gets the error bubble + retry button.
      if (!data.reply || !String(data.reply).trim()) throw new Error("empty reply");
      // handoff and safetyCard both come from API fields, never from
      // string-matching the prose.
      setMessages((p) => [...p, { id: `resp-${Date.now()}`, role: "assistant", content: data.reply, created_at: new Date().toISOString(), handoff: data.handoff || null, handoff_message: data.handoff_message || null, safetyCard: data.safetyCard || null }]);
      if (data.usage_remaining !== null && data.usage_remaining !== undefined) setUsageRemaining(data.usage_remaining);
      setTimeout(() => loadThreads(), 2000);
    } catch (e) {
      setMessages((p) => [...p, { id: `err-${Date.now()}`, role: "assistant", content: "man, something went sideways... try again in a sec", created_at: new Date().toISOString(), isError: true }]);
      addToast("message failed to send");
    } finally { setLoading(false); }
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

  const ctx = { user, activeTab, view, setView, threads, activeThreadId, messages, usageRemaining, loading, profile, showProfile, showSubscription, showAgeGate, sidebarOpen, setShowProfile, setShowSubscription, setSidebarOpen, handleLogin, handleRegister, handleLogout, handleSwitchTab, handleAgeVerify, dismissAgeGate, handleNewThread, handleSelectThread, handleSendMessage, handleHandoffClick, handleToggleData, handleDeleteThread, handleRenameThread, loadProfile, authView, setAuthView, addToast, setShowAgeGate, handleForgotPassword, handleResetPassword };

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
        {showAgeGate && <AgeGateModal />}
        {showProfile && <ProfilePage />}
        {showSubscription && <SubscriptionPage />}
        <div className="sh-layout">
          {sidebarOpen && <div className="sh-sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
          <ThreadSidebar />
          <div className="sh-main">
            <header className="sh-header">
              <button className="sh-menu-btn" onClick={() => setSidebarOpen((s) => !s)} aria-label="Menu">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect y="3" width="20" height="2" rx="1" fill="currentColor"/><rect y="9" width="20" height="2" rx="1" fill="currentColor"/><rect y="15" width="20" height="2" rx="1" fill="currentColor"/></svg>
              </button>
              <div className="sh-header-brand"><img src="/images/stonehead-logo-text.png" alt="stonehead ai" className="sh-logo-img" /></div>
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
          <button className="sh-auth-toggle" onClick={() => setAuthView(authView === "login" ? "register" : "login")}>{authView === "login" ? "don't have an account? sign up" : "already here? log in"}</button>
          {/* Signup notice. Shown on the register view because that's the point
              where someone is actually agreeing to something. Plain links to
              static pages, not a modal or a checkbox — consent GATING is its
              own spec; this batch publishes and discloses. */}
          {authView === "register" && (
            <p className="sh-auth-legal">
              by signing up you're agreeing to the{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer">terms</a>
              {" "}and the{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a>.
              you have to be 13 or older, and 21+ for talk the plant.
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
  const { messages, activeTab, handleSendMessage, loading, usageRemaining, user } = useApp();
  const [input, setInput] = useState(""); const scrollRef = useRef(null); const textareaRef = useRef(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    // Empty/welcome thread: keep the hero pinned to the top so the full
    // mascot is visible on open instead of auto-scrolling past it.
    if (messages.length === 0) scrollRef.current.scrollTop = 0;
    else scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);
  function handleSubmit(e) { if (e) e.preventDefault(); if (!input.trim() || loading) return; handleSendMessage(input.trim()); setInput(""); if (textareaRef.current) textareaRef.current.style.height = "auto"; }
  function handleKeyDown(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }
  function handleTextareaChange(e) { setInput(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 130) + "px"; }
  const showSuggestions = messages.length === 0;
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
            <p className="sh-tagline">Your Always Stone-D AI Friend</p>
<div className="sh-welcome-bubble">
  <p className="sh-welcome-text">{activeTab === "vibe" ? "hey... pull up a chair. what's on your mind?" : "yo what's good... let's talk about the plant. you can ask me about growing too, not just what to smoke."}</p>
</div>
            <SuggestionChips tab={activeTab} onChipClick={(t) => handleSendMessage(t)} />
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={msg.id} message={msg} tab={activeTab}
            onRetry={msg.isError && messages[i - 1] ? () => handleSendMessage(messages[i - 1].content) : null} />
        ))}
        {loading && (
          <div className="sh-typing-row">
            <div className="sh-bubble-avatar"><img src={activeTab === "plant" ? "/images/stonehead-avatar-smoke.png" : "/images/stonehead-avatar-clean.png"} alt="" className="sh-avatar-img" /></div>
            <div className="sh-typing"><div className="sh-typing-dot"/><div className="sh-typing-dot"/><div className="sh-typing-dot"/></div>
          </div>
        )}
      </div>
      <div className="sh-input-bar">
        {showUsage && <div className="sh-usage-badge">{usageRemaining > 0 ? `${usageRemaining} left today` : "tapped out for today"}</div>}
        <div className="sh-input-form">
          <textarea ref={textareaRef} value={input} onChange={handleTextareaChange} onKeyDown={handleKeyDown} maxLength={4000}
            placeholder={activeTab === "vibe" ? "say something..." : "ask about a strain..."} className="sh-chat-input" disabled={loading} rows={1} />
          <button type="button" className={`sh-send-btn ${input.trim() && !loading ? "sh-send-btn--active" : ""}`}
            onClick={handleSubmit} disabled={!input.trim() || loading}>
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

function MessageBubble({ message, tab, onRetry }) {
  const { handleHandoffClick } = useApp();
  const isUser = message.role === "user";
  return (
    <div className={`sh-bubble-row ${isUser ? "sh-bubble-row--user" : ""}`}>
      {!isUser && (
        <div className="sh-bubble-avatar"><img src={tab === "plant" ? "/images/stonehead-avatar-smoke.png" : "/images/stonehead-avatar-clean.png"} alt="" className="sh-avatar-img" /></div>
      )}
      <div className={`sh-bubble ${isUser ? "sh-bubble--user" : tab === "plant" ? "sh-bubble--assistant-plant" : "sh-bubble--assistant-vibe"}`}>
        <p className="sh-bubble-text">{renderInline(message.content)}</p>
        {!isUser && message.handoff === "plant" && message.handoff_message && (
          <button className="sh-handoff-btn" onClick={() => handleHandoffClick(message.handoff_message)}>
            take it to talk the plant 🌿
          </button>
        )}
        {onRetry && <button className="sh-retry-btn" onClick={onRetry}>↻ retry</button>}
        {!isUser && message.safetyCard && <SafetyCard card={message.safetyCard} />}
      </div>
    </div>
  );
}

function SuggestionChips({ tab, onChipClick }) {
  const chips = tab === "plant" ? PLANT_SUGGESTIONS : VIBE_SUGGESTIONS;
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
  const { threads, activeThreadId, handleNewThread, handleSelectThread, handleDeleteThread, handleRenameThread, sidebarOpen, view, setView, setSidebarOpen } = useApp();
  const [editingId, setEditingId] = useState(null); const [editTitle, setEditTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  function startRename(t) { setEditingId(t.id); setEditTitle(t.title || ""); }
  function saveRename(id) { if (editTitle.trim()) handleRenameThread(id, editTitle.trim()); setEditingId(null); }
  function goChat() { setView("chat"); setSidebarOpen(false); }
  function goMemory() { setView("memory"); setSidebarOpen(false); }
  return (
    <aside className={`sh-sidebar ${sidebarOpen ? "sh-sidebar--open" : ""}`}>
      <div className="sh-sidebar-nav">
        <button className={`sh-nav-item ${view === "chat" ? "sh-nav-item--active" : ""}`} onClick={goChat}>💬 chat</button>
        <button className={`sh-nav-item ${view === "memory" ? "sh-nav-item--active" : ""}`} onClick={goMemory}>🧠 memory</button>
        <a className="sh-nav-item sh-nav-item--link" href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">👾 discord</a>
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

function ProfilePage() {
  const { user, profile, setShowProfile, setShowSubscription, handleLogout, loadProfile, addToast } = useApp();
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
        <span className={`sh-sub-badge ${user?.is_subscribed ? "sh-sub-badge--active" : ""}`}>{user?.is_subscribed ? "subscribed" : "free tier"}</span>
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
      <p className="sh-profile-memory-hint">your liked strains and what Stone Head remembers now live in <strong>memory</strong> (open the menu).</p>
      <div className="sh-profile-actions">
        <button className="sh-btn-primary" onClick={() => { setShowProfile(false); setShowSubscription(true); }}>{user?.is_subscribed ? "manage subscription" : "subscribe"}</button>
        <button className="sh-btn-danger" onClick={handleLogout}>log out</button>
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

function SubscriptionPage() {
  const { setShowSubscription, loadProfile, addToast } = useApp();
  const [code, setCode] = useState(null); const [expiresAt, setExpiresAt] = useState(null);
  const [paymentUrl, setPaymentUrl] = useState(null); const [generating, setGenerating] = useState(false); const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  async function generateCode() {
    setGenerating(true);
    try { const data = await apiPost("/api/subscription/generate-code", {}); setCode(data.payment_code); setExpiresAt(data.expires_at); setPaymentUrl(data.payment_url); }
    catch (e) {} finally { setGenerating(false); }
  }
  function copyCode() { if (code) { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } }
  // Payment happens on an external page — nothing pushes the new state back
  // into this client, so refresh on close (when a code was generated this
  // session) and offer an explicit "I paid" refresh.
  function handleClose() {
    if (code) loadProfile();
    setShowSubscription(false);
  }
  async function checkPaid() {
    setChecking(true);
    try {
      const p = await apiGet("/api/profile/get");
      await loadProfile();
      if (p.is_subscribed) { setShowSubscription(false); addToast("you're in — no more daily cap"); }
      else { addToast("not seeing it yet... give it a sec and try again"); }
    } catch (e) { addToast("couldn't check — try again"); }
    finally { setChecking(false); }
  }
  return (
    <div className="sh-modal-overlay"><div className="sh-modal sh-subscription">
      <div className="sh-modal-close-row"><button className="sh-close-btn" onClick={handleClose}>×</button></div>
      <h2>subscribe to Stone Head</h2>
      <p className="sh-sub-price">$8/month — what you see is what you pay</p>
      <p className="sh-sub-desc">unlimited messages, no daily cap. just you and Stone Head, as long as you want.</p>
      {!code ? (
        <button className="sh-btn-primary" onClick={generateCode} disabled={generating}>{generating ? "generating..." : "get your payment code"}</button>
      ) : (
        <div className="sh-code-section">
          <p className="sh-code-label">your payment code:</p>
          <div className="sh-code-box" onClick={copyCode}><code>{code}</code><span className="sh-copy-hint">{copied ? "copied!" : "click to copy"}</span></div>
          {expiresAt && <p className="sh-code-expires">expires {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
          {paymentUrl && <a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="sh-btn-primary sh-payment-link">go to payment page</a>}
          <p className="sh-code-instructions">copy the code, head to the payment page, enter it with your payment info. your account activates automatically.</p>
          <button className="sh-btn-secondary" onClick={checkPaid} disabled={checking}>{checking ? "checking..." : "I paid — refresh my account"}</button>
        </div>
      )}
    </div></div>
  );
}

function LimitMessage() {
  return <div className="sh-limit-message"><div className="sh-bubble sh-bubble--assistant-vibe sh-bubble--limit"><p className="sh-bubble-text">hey bro... I'm kinda tapped for today. come back tomorrow, I'll be right here.</p></div></div>;
}
