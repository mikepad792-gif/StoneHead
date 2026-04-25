import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";

// ─────────────────────────────────────────────
// STONEHEAD AI — Thread 3: Frontend
// All component names match MASTER_TERMS exactly
// All API field names use snake_case at boundary
// ─────────────────────────────────────────────

const API_BASE = "";

// ── Context ──────────────────────────────────
const AppContext = createContext(null);

function useApp() {
  return useContext(AppContext);
}

// ── API Layer (snake_case at boundary) ───────
async function apiCall(endpoint, options = {}) {
  const token = localStorage.getItem("session_token");
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

  const data = await res.json();
  // Netlify Functions return { statusCode, body } where body is a JSON string
  // If we get a body field that's a string, parse it. Otherwise treat data as-is.
  let parsed;
  if (typeof data.body === "string") {
    try {
      parsed = JSON.parse(data.body);
    } catch {
      parsed = data;
    }
  } else {
    parsed = data;
  }
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

async function apiPost(endpoint, body) {
  return apiCall(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function apiGet(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${endpoint}?${qs}` : endpoint;
  return apiCall(url, { method: "GET" });
}

// ── Suggestion prompts per tab ───────────────
const VIBE_SUGGESTIONS = [
  "what's on your mind lately?",
  "tell me something weird",
  "is it okay to not have a plan?",
  "what's the meaning of all this?",
];
const PLANT_SUGGESTIONS = [
  "what's good for a chill night in?",
  "recommend something creative",
  "sativa or indica for a hike?",
  "what pairs with pizza and a movie?",
];

// ── Main App ─────────────────────────────────
export default function App() {
  // Auth state
  const [user, setUser] = useState(null);
  const [sessionToken, setSessionToken] = useState(
    () => localStorage.getItem("session_token") || null
  );
  const [authView, setAuthView] = useState("login"); // login | register

  // App state
  const [activeTab, setActiveTab] = useState("vibe");
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [usageRemaining, setUsageRemaining] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const [showAgeGate, setShowAgeGate] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Profile data
  const [profile, setProfile] = useState(null);

  // On mount: check for existing session
  useEffect(() => {
    if (sessionToken) {
      loadProfile();
      loadThreads();
      checkUsage();
    }
  }, [sessionToken]);

  // Load threads when tab changes
  useEffect(() => {
    if (sessionToken) loadThreads();
  }, [activeTab]);

  async function loadProfile() {
    try {
      const p = await apiGet("/api/profile/get");
      setProfile(p);
      setUser({
        user_id: p.user_id,
        username: p.username,
        is_subscribed: p.is_subscribed,
        age_verified: p.age_verified,
      });
      if (p.usage_remaining !== null && p.usage_remaining !== undefined) {
        setUsageRemaining(p.usage_remaining);
      } else {
        setUsageRemaining(null);
      }
    } catch (e) {
      console.error("Profile load failed:", e);
      handleLogout();
    }
  }

  async function loadThreads() {
    try {
      const data = await apiGet("/api/threads/list", { tab: activeTab });
      setThreads(data.threads || []);
    } catch (e) {
      console.error("Thread load failed:", e);
    }
  }

  async function loadMessages(threadId) {
    try {
      const data = await apiGet("/api/threads/messages", {
        thread_id: threadId,
      });
      setMessages(data.messages || []);
    } catch (e) {
      console.error("Messages load failed:", e);
    }
  }

  async function checkUsage() {
    try {
      const data = await apiGet("/api/usage/check");
      // null means subscribed — hide counter entirely
      setUsageRemaining(
        data.usage_remaining === null || data.usage_remaining === undefined
          ? null
          : data.usage_remaining
      );
    } catch (e) {
      console.error("Usage check failed:", e);
    }
  }

  async function handleLogin(email, password) {
    const data = await apiPost("/api/auth/login", { email, password });
    localStorage.setItem("session_token", data.session_token);
    setSessionToken(data.session_token);
    setUser({
      user_id: data.user_id,
      username: data.username,
      is_subscribed: data.is_subscribed,
      age_verified: data.age_verified,
    });
  }

  async function handleRegister(email, password, username) {
    const data = await apiPost("/api/auth/register", {
      email,
      password,
      username,
    });
    localStorage.setItem("session_token", data.session_token);
    setSessionToken(data.session_token);
    // Register only returns user_id + session_token — store username from form
    setUser({
      user_id: data.user_id,
      username: username,
      is_subscribed: false,
      age_verified: false,
    });
  }

  function handleLogout() {
    localStorage.removeItem("session_token");
    setSessionToken(null);
    setUser(null);
    setProfile(null);
    setThreads([]);
    setMessages([]);
    setActiveThreadId(null);
  }

  async function handleSwitchTab(tab) {
    if (tab === "plant" && user && !user.age_verified) {
      setShowAgeGate(true);
      return;
    }
    setActiveTab(tab);
    setActiveThreadId(null);
    setMessages([]);
  }

  async function handleAgeVerify() {
    try {
      await apiPost("/api/profile/age-verify", {});
      setUser((u) => ({ ...u, age_verified: true }));
      setShowAgeGate(false);
      setActiveTab("plant");
      setActiveThreadId(null);
      setMessages([]);
    } catch (e) {
      console.error("Age verify failed:", e);
    }
  }

  async function handleNewThread() {
    try {
      const data = await apiPost("/api/threads/create", { tab: activeTab });
      setActiveThreadId(data.thread_id);
      setMessages([]);
      await loadThreads();
      setSidebarOpen(false);
    } catch (e) {
      console.error("Thread create failed:", e);
    }
  }

  async function handleSelectThread(threadId) {
    setActiveThreadId(threadId);
    await loadMessages(threadId);
    setSidebarOpen(false);
  }

  async function handleSendMessage(text) {
    if (!text.trim()) return;

    let threadId = activeThreadId;
    // Auto-create thread if none selected
    if (!threadId) {
      try {
        const data = await apiPost("/api/threads/create", { tab: activeTab });
        threadId = data.thread_id;
        setActiveThreadId(threadId);
        loadThreads();
      } catch (e) {
        console.error("Auto-create thread failed:", e);
        return;
      }
    }

    // Optimistic user message
    const userMsg = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const data = await apiPost("/api/chat/send", {
        message: text,
        thread_id: threadId,
        tab: activeTab,
      });

      // Limit message comes as a normal 200 with reply — render like any message
      const assistantMsg = {
        id: `resp-${Date.now()}`,
        role: "assistant",
        content: data.reply,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Update usage — null means subscribed
      if (data.usage_remaining !== null && data.usage_remaining !== undefined) {
        setUsageRemaining(data.usage_remaining);
      }

      loadThreads(); // refresh titles
    } catch (e) {
      const errMsg = {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: "yo something went sideways... try again in a sec",
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleData(threadId, currentState) {
    try {
      const data = await apiPost("/api/threads/toggle-data", {
        thread_id: threadId,
        data_opt_in: !currentState,
      });
      // Update thread in local state
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, data_opt_in: data.data_opt_in } : t
        )
      );
    } catch (e) {
      console.error("Toggle data failed:", e);
    }
  }

  const ctx = {
    user,
    activeTab,
    threads,
    activeThreadId,
    messages,
    usageRemaining,
    loading,
    profile,
    showProfile,
    showSubscription,
    showAgeGate,
    sidebarOpen,
    setShowProfile,
    setShowSubscription,
    setSidebarOpen,
    handleLogin,
    handleRegister,
    handleLogout,
    handleSwitchTab,
    handleAgeVerify,
    handleNewThread,
    handleSelectThread,
    handleSendMessage,
    handleToggleData,
    loadProfile,
    authView,
    setAuthView,
  };

  if (!sessionToken) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="sh-root">
          <AuthScreen />
        </div>
      </AppContext.Provider>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className="sh-root">
        {showAgeGate && <AgeGateModal />}
        {showProfile && <ProfilePage />}
        {showSubscription && <SubscriptionPage />}

        <div className="sh-layout">
          {sidebarOpen && (
            <div
              className="sh-sidebar-overlay"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <ThreadSidebar />

          <div className="sh-main">
            <header className="sh-header">
              <button
                className="sh-menu-btn"
                onClick={() => setSidebarOpen((s) => !s)}
                aria-label="Toggle sidebar"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <rect y="3" width="20" height="2" rx="1" fill="currentColor" />
                  <rect y="9" width="20" height="2" rx="1" fill="currentColor" />
                  <rect y="15" width="20" height="2" rx="1" fill="currentColor" />
                </svg>
              </button>

              <TabSwitcher />

              <div className="sh-header-right">
                {activeThreadId && (
                  <DataToggle
                    threadId={activeThreadId}
                    currentState={
                      threads.find((t) => t.id === activeThreadId)
                        ?.data_opt_in || false
                    }
                  />
                )}
                <button
                  className="sh-avatar-btn"
                  onClick={() => setShowProfile(true)}
                  title="Profile"
                >
                  {user?.username?.[0]?.toUpperCase() || "?"}
                </button>
              </div>
            </header>

            <ChatWindow />
          </div>
        </div>
      </div>
    </AppContext.Provider>
  );
}

// ── AuthScreen ───────────────────────────────
function AuthScreen() {
  const { handleLogin, handleRegister, authView, setAuthView } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (authView === "login") {
        await handleLogin(email, password);
      } else {
        if (!username.trim()) {
          setError("need a username, dude");
          setSubmitting(false);
          return;
        }
        await handleRegister(email, password, username);
      }
    } catch (err) {
      setError(err.message || "something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sh-auth-screen">
      <div className="sh-auth-card">
        <div className="sh-auth-logo">
          <span className="sh-logo-icon">🪨</span>
          <h1>StoneHead AI</h1>
          <p className="sh-tagline">your friendly, slightly stoned AI friend</p>
        </div>

        <form onSubmit={handleSubmit} className="sh-auth-form">
          {authView === "register" && (
            <input
              type="text"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="sh-input"
              autoComplete="username"
            />
          )}
          <input
            type="email"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="sh-input"
            autoComplete="email"
            required
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="sh-input"
            autoComplete={
              authView === "login" ? "current-password" : "new-password"
            }
            required
          />
          {error && <p className="sh-error">{error}</p>}
          <button
            type="submit"
            className="sh-btn-primary"
            disabled={submitting}
          >
            {submitting
              ? "hold on..."
              : authView === "login"
              ? "come in"
              : "join up"}
          </button>
        </form>

        <button
          className="sh-auth-toggle"
          onClick={() =>
            setAuthView(authView === "login" ? "register" : "login")
          }
        >
          {authView === "login"
            ? "don't have an account? sign up"
            : "already here? log in"}
        </button>
      </div>
    </div>
  );
}

// ── TabSwitcher ──────────────────────────────
function TabSwitcher() {
  const { activeTab, handleSwitchTab } = useApp();

  return (
    <div className="sh-tab-switcher">
      <button
        className={`sh-tab ${activeTab === "vibe" ? "sh-tab--active" : ""}`}
        onClick={() => handleSwitchTab("vibe")}
      >
        the vibe
      </button>
      <button
        className={`sh-tab ${activeTab === "plant" ? "sh-tab--active sh-tab--plant" : ""}`}
        onClick={() => handleSwitchTab("plant")}
      >
        talk the plant
      </button>
    </div>
  );
}

// ── ChatWindow ───────────────────────────────
function ChatWindow() {
  const {
    messages,
    activeTab,
    handleSendMessage,
    loading,
    usageRemaining,
    activeThreadId,
    user,
  } = useApp();
  const [input, setInput] = useState("");
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  function handleSubmit(e) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    handleSendMessage(input.trim());
    setInput("");
  }

  function handleChipClick(text) {
    handleSendMessage(text);
  }

  const showSuggestions = messages.length === 0;
  // Show usage only when non-null (null = subscribed)
  const showUsage = usageRemaining !== null && usageRemaining !== undefined;

  return (
    <div className="sh-chat-window">
      <div className="sh-messages" ref={scrollRef}>
        {showSuggestions && (
          <div className="sh-welcome">
            <div className="sh-welcome-icon">🪨</div>
            <p className="sh-welcome-text">
              {activeTab === "vibe"
                ? "hey... pull up a chair. what's on your mind?"
                : "yo what's good... let's talk about the plant."}
            </p>
            <SuggestionChips
              tab={activeTab}
              onChipClick={handleChipClick}
            />
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} tab={activeTab} />
        ))}

        {loading && (
          <div className="sh-typing">
            <div className="sh-typing-dot" />
            <div className="sh-typing-dot" />
            <div className="sh-typing-dot" />
          </div>
        )}
      </div>

      <div className="sh-input-bar">
        {showUsage && (
          <div className="sh-usage-badge">
            {usageRemaining > 0
              ? `${usageRemaining} left today`
              : "tapped out for today"}
          </div>
        )}
        <form onSubmit={handleSubmit} className="sh-input-form">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              activeTab === "vibe"
                ? "say something..."
                : "ask about a strain..."
            }
            className="sh-chat-input"
            disabled={loading}
          />
          <button
            type="submit"
            className="sh-send-btn"
            disabled={!input.trim() || loading}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M22 2L11 13"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M22 2L15 22L11 13L2 9L22 2Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}

// ── MessageBubble ────────────────────────────
function MessageBubble({ message, tab }) {
  const isUser = message.role === "user";

  return (
    <div className={`sh-bubble-row ${isUser ? "sh-bubble-row--user" : ""}`}>
      {!isUser && <div className="sh-bubble-avatar">🪨</div>}
      <div
        className={`sh-bubble ${
          isUser
            ? "sh-bubble--user"
            : tab === "plant"
            ? "sh-bubble--assistant-plant"
            : "sh-bubble--assistant-vibe"
        }`}
      >
        <p className="sh-bubble-text">{message.content}</p>
      </div>
    </div>
  );
}

// ── SuggestionChips ──────────────────────────
function SuggestionChips({ tab, onChipClick }) {
  const chips = tab === "plant" ? PLANT_SUGGESTIONS : VIBE_SUGGESTIONS;

  return (
    <div className="sh-chips">
      {chips.map((text) => (
        <button
          key={text}
          className="sh-chip"
          onClick={() => onChipClick(text)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

// ── ThreadSidebar ────────────────────────────
function ThreadSidebar() {
  const {
    threads,
    activeThreadId,
    handleNewThread,
    handleSelectThread,
    sidebarOpen,
    activeTab,
  } = useApp();

  return (
    <aside className={`sh-sidebar ${sidebarOpen ? "sh-sidebar--open" : ""}`}>
      <div className="sh-sidebar-header">
        <span className="sh-sidebar-title">threads</span>
        <button className="sh-new-thread-btn" onClick={handleNewThread}>
          + new
        </button>
      </div>

      <div className="sh-thread-list">
        {threads.length === 0 && (
          <p className="sh-no-threads">no threads yet... start one</p>
        )}
        {threads.map((thread) => (
          <button
            key={thread.id}
            className={`sh-thread-item ${
              thread.id === activeThreadId ? "sh-thread-item--active" : ""
            }`}
            onClick={() => handleSelectThread(thread.id)}
          >
            <span className="sh-thread-title">
              {thread.title || "untitled thread"}
            </span>
            <span className="sh-thread-tab">
              {thread.tab === "plant" ? "🌿" : "~"}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ── DataToggle ───────────────────────────────
function DataToggle({ threadId, currentState }) {
  const { handleToggleData } = useApp();

  return (
    <div className="sh-data-toggle" title="Share anonymized data for training">
      <label className="sh-toggle-label">
        <input
          type="checkbox"
          checked={currentState}
          onChange={() => handleToggleData(threadId, currentState)}
          className="sh-toggle-input"
        />
        <span className="sh-toggle-track">
          <span className="sh-toggle-thumb" />
        </span>
        <span className="sh-toggle-text">data</span>
      </label>
    </div>
  );
}

// ── AgeGateModal ─────────────────────────────
function AgeGateModal() {
  const { handleAgeVerify, showAgeGate } = useApp();
  const { setShowAgeGate } = useApp();

  if (!showAgeGate) return null;

  return (
    <div className="sh-modal-overlay">
      <div className="sh-modal sh-age-gate">
        <div className="sh-age-icon">🌿</div>
        <h2>hold up</h2>
        <p>
          Talk the Plant is for people 21 and older. Are you 21 years of age or
          older?
        </p>
        <div className="sh-age-actions">
          <button className="sh-btn-primary" onClick={handleAgeVerify}>
            yeah, I'm 21+
          </button>
          <button
            className="sh-btn-secondary"
            onClick={() => setShowAgeGate(false)}
          >
            nah, take me back
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ProfilePage ──────────────────────────────
function ProfilePage() {
  const { user, profile, setShowProfile, setShowSubscription, handleLogout, loadProfile } =
    useApp();

  useEffect(() => {
    loadProfile();
  }, []);

  return (
    <div className="sh-modal-overlay">
      <div className="sh-modal sh-profile">
        <div className="sh-modal-close-row">
          <button
            className="sh-close-btn"
            onClick={() => setShowProfile(false)}
          >
            x
          </button>
        </div>

        <div className="sh-profile-header">
          <div className="sh-profile-avatar">
            {user?.username?.[0]?.toUpperCase() || "?"}
          </div>
          <h2>{user?.username || "..."}</h2>
          <span
            className={`sh-sub-badge ${
              user?.is_subscribed ? "sh-sub-badge--active" : ""
            }`}
          >
            {user?.is_subscribed ? "subscribed" : "free tier"}
          </span>
        </div>

        {profile?.liked_strains && profile.liked_strains.length > 0 && (
          <div className="sh-profile-section">
            <h3>liked strains</h3>
            <StrainList strains={profile.liked_strains} />
          </div>
        )}

        {profile?.liked_strains && profile.liked_strains.length === 0 && (
          <div className="sh-profile-section">
            <h3>liked strains</h3>
            <p className="sh-empty-strains">
              none yet... tell Stone Head about strains you like in Talk the
              Plant
            </p>
          </div>
        )}

        <div className="sh-profile-actions">
          <button
            className="sh-btn-primary"
            onClick={() => {
              setShowProfile(false);
              setShowSubscription(true);
            }}
          >
            {user?.is_subscribed ? "manage subscription" : "subscribe"}
          </button>
          <button className="sh-btn-danger" onClick={handleLogout}>
            log out
          </button>
        </div>
      </div>
    </div>
  );
}

// ── StrainList ───────────────────────────────
function StrainList({ strains }) {
  return (
    <div className="sh-strain-list">
      {strains.map((s, i) => (
        <div key={s.strain_name + i} className="sh-strain-card">
          <div className="sh-strain-header">
            <span className="sh-strain-name">{s.strain_name}</span>
            <span
              className={`sh-strain-type sh-strain-type--${s.strain_type}`}
            >
              {s.strain_type}
            </span>
          </div>
          {s.notes && <p className="sh-strain-notes">{s.notes}</p>}
        </div>
      ))}
    </div>
  );
}

// ── SubscriptionPage ─────────────────────────
function SubscriptionPage() {
  const { setShowSubscription } = useApp();
  const [code, setCode] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [paymentUrl, setPaymentUrl] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generateCode() {
    setGenerating(true);
    try {
      const data = await apiPost("/api/subscription/generate-code", {});
      setCode(data.payment_code);
      setExpiresAt(data.expires_at);
      setPaymentUrl(data.payment_url);
    } catch (e) {
      console.error("Code generation failed:", e);
    } finally {
      setGenerating(false);
    }
  }

  function copyCode() {
    if (code) {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="sh-modal-overlay">
      <div className="sh-modal sh-subscription">
        <div className="sh-modal-close-row">
          <button
            className="sh-close-btn"
            onClick={() => setShowSubscription(false)}
          >
            x
          </button>
        </div>

        <h2>subscribe to Stone Head</h2>
        <p className="sh-sub-desc">
          unlimited messages, no daily cap. just you and Stone Head, as long as
          you want.
        </p>

        {!code ? (
          <button
            className="sh-btn-primary"
            onClick={generateCode}
            disabled={generating}
          >
            {generating ? "generating..." : "get your payment code"}
          </button>
        ) : (
          <div className="sh-code-section">
            <p className="sh-code-label">your payment code:</p>
            <div className="sh-code-box" onClick={copyCode}>
              <code>{code}</code>
              <span className="sh-copy-hint">
                {copied ? "copied!" : "click to copy"}
              </span>
            </div>
            {expiresAt && (
              <p className="sh-code-expires">
                expires{" "}
                {new Date(expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
            {paymentUrl && (
              <a
                href={paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="sh-btn-primary sh-payment-link"
              >
                go to payment page
              </a>
            )}
            <p className="sh-code-instructions">
              copy the code above, head to the payment page, enter the code with
              your payment info. that's it — your account activates
              automatically.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── LimitMessage ─────────────────────────────
// Available for explicit use, but limit messages from the API
// render as normal MessageBubble since they're 200 responses.
function LimitMessage() {
  return (
    <div className="sh-limit-message">
      <div className="sh-bubble sh-bubble--assistant-vibe sh-bubble--limit">
        <p className="sh-bubble-text">
          hey bro... I'm kinda tapped for today. come back tomorrow, I'll be
          right here.
        </p>
      </div>
    </div>
  );
}
