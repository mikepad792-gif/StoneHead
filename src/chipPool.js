// src/chipPool.js
// Rotating suggestion chips for the empty chat screen. Pure data + a pure
// picker, so scripts/chips-check.mjs can test it under plain Node.
//
// Vibe: 4 chips drawn from one pool.
// Plant: 4 chips, one from each category (strain, grow, help, smoke), in
// random order, so every set covers all four kinds of thing the tab does.
// Both: chips shown recently are skipped while enough others remain, so the
// same ones don't come right back.
//
// House style: lowercase start and a lowercase "i", like the old chips.
// No long dashes. The vibe tab is open to 13+, so nothing in VIBE may be
// about getting high; that lives in the plant tab's "smoke" pool (21+).

export const VIBE = [
  { icon: "💭", text: "what's a weird thought you've been having lately?" },
  { icon: "💎", text: "tell me something you think is underrated." },
  { icon: "🐇", text: "what's a rabbit hole worth falling into?" },
  { icon: "😮‍💨", text: "what's something humans take way too seriously?" },
  { icon: "🌀", text: "what's the strangest thing you've ever wondered about?" },
  { icon: "🧩", text: "give me something interesting to think about." },
  { icon: "🔍", text: "what's a theory you can't completely dismiss?" },
  { icon: "🎧", text: "why do certain songs hit completely different sometimes?" },
  { icon: "🌌", text: "what's something that makes you wonder about reality?" },
  { icon: "🤯", text: "tell me something that sounds fake but isn't." },
  { icon: "❓", text: "what's a question you think nobody asks enough?" },
  { icon: "🔄", text: "what's something you've changed your mind about?" },
  { icon: "🔁", text: "what's a thought that's been stuck in your head?" },
  { icon: "🥄", text: "what's something ordinary that's actually pretty weird?" },
  { icon: "🪞", text: "do you think people really know themselves?" },
  { icon: "🗣️", text: "what's something you could talk about for hours?" },
  { icon: "🎲", text: "what's the weirdest coincidence you've heard of?" },
  { icon: "🧬", text: "what's something about being human you find fascinating?" },
  { icon: "🤔", text: "give me a random philosophical question." },
  { icon: "🔮", text: "what's something you think we'll understand differently someday?" },
  { icon: "👽", text: "what would you ask an alien if you had one minute?" },
  { icon: "🛑", text: "what's something that makes you stop and think?" },
  { icon: "🕵️", text: "what's a harmless conspiracy theory that's fun to explore?" },
  { icon: "🌙", text: "what do you think dreams are really doing?" },
  { icon: "👀", text: "what's something you wish you could see from another person's perspective?" },
  { icon: "🪨", text: "what's a seemingly stupid question that actually gets deep?" },
  { icon: "⏳", text: "what's something about time that messes with your head?" },
  { icon: "🌍", text: "tell me something that'll make me look at the world differently." },
  { icon: "🌀", text: "what's something you think is stranger than people realize?" },
  { icon: "🪐", text: "if you could know one completely useless fact about the universe, what would you pick?" },
  { icon: "🎭", text: "what's something you think we're all pretending to understand?" },
  { icon: "🔀", text: "what's the most interesting \"what if\" you can think of?" },
  { icon: "🌱", text: "what's something that gets more interesting the more you think about it?" },
  { icon: "🧠", text: "do you think consciousness is more than the brain?" },
  { icon: "🧪", text: "what's a thought experiment worth trying?" },
  { icon: "✨", text: "what's something you'd want to experience just to understand it?" },
  { icon: "😂", text: "what's something you think people will laugh about 100 years from now?" },
  { icon: "🤖", text: "what's something you've always wanted to ask an AI?" },
  { icon: "🗿", text: "what do you think about when nobody's talking to you?" },
];

export const PLANT = {
  strain: { icon: "🌱", items: [
    "is Blue Dream hard to grow?",
    "what makes a strain easy for beginners?",
    "what's the difference between indica and sativa?",
    "why do some strains make people sleepy?",
    "what makes a strain good for daytime?",
    "why do some strains make me anxious?",
    "what should i know before growing a new strain?",
    "what makes a strain more forgiving?",
    "why do some strains stretch so much?",
    "what causes different strains to smell so different?",
    "why do some plants produce more resin?",
    "what makes a strain finish early or late?",
    "why do some strains handle stress better?",
    "what does a strain's flowering time actually tell me?",
    "how much does genetics affect how a plant grows?",
  ]},
  grow: { icon: "🪴", items: [
    "how do i know when my plant needs water?",
    "how do i know if i'm overwatering?",
    "how do i know if i'm underwatering?",
    "why are my leaves getting brown tips?",
    "what causes nutrient burn?",
    "how do i know if my plant needs more light?",
    "why is my plant growing so slowly?",
    "what causes plants to stretch?",
    "when should i start training my plant?",
    "how do i know when flowering has started?",
    "why are my leaves drooping?",
    "what should healthy new growth look like?",
    "what are the most common beginner growing mistakes?",
  ]},
  help: { icon: "🔍", items: [
    "my plant suddenly looks sick. where do i start?",
    "something changed overnight. what should i check?",
    "my leaves are turning yellow, help.",
    "my plant is drooping even though i watered it.",
    "my leaves have spots. what could be causing them?",
    "my plant isn't drinking much water. is that normal?",
    "my leaves are curling. what's going on?",
    "my plant looks healthy but isn't growing. why?",
    "i think i overwatered my plant. what do i do?",
    "i think i underwatered my plant. what do i do?",
    "my plant has weird discoloration. can you help me figure it out?",
    "something is eating my leaves. what should i look for?",
    "my plant smells different than usual. should i worry?",
    "my plant is getting too tall. what can i do?",
    "can you help me diagnose what's wrong with my plant?",
  ]},
  smoke: { icon: "☁️", items: [
    "what's good for a lazy Sunday?",
    "something that won't make me anxious?",
    "why does the same strain feel different sometimes?",
    "why does weed sometimes make me sleepy?",
    "why do some strains make food taste amazing?",
    "why does tolerance build so quickly?",
    "why can two people have completely different experiences?",
    "why does being high sometimes make music sound incredible?",
    "why do edibles feel so different from smoking?",
    "why does cannabis sometimes make my thoughts race?",
    "what's the difference between CBD and THC?",
    "why does my high sometimes feel different from the last one?",
    "why does cannabis affect my sense of time?",
    "why do i sometimes get really introspective when i'm high?",
    "how can i make a cannabis experience more comfortable?",
    "what's something that feels different when you're high?",
  ]},
};

export const RECENT_LIMIT = { vibe: 12, plant: 8 };
const STORE_KEY = "sh_chip_recent";

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Prefer chips not in `recent`; fall back to recent ones only if the fresh
// ones run out (never happens with these pool sizes, but keeps it safe).
function takeFresh(candidates, n, recent, rng) {
  const fresh = shuffled(candidates.filter((c) => !recent.has(c.text)), rng);
  const stale = shuffled(candidates.filter((c) => recent.has(c.text)), rng);
  return [...fresh, ...stale].slice(0, n);
}

export function pickChips(tab, recentTexts = [], rng = Math.random) {
  const recent = new Set(recentTexts);
  if (tab === "plant") {
    const picks = Object.values(PLANT).map(({ icon, items }) =>
      takeFresh(items.map((text) => ({ icon, text })), 1, recent, rng)[0]
    );
    return shuffled(picks, rng);
  }
  return takeFresh(VIBE, 4, recent, rng);
}

// Newest first, no duplicates, capped per tab.
export function rememberShown(recentTexts, shownTexts, limit) {
  const next = [...shownTexts, ...recentTexts.filter((t) => !shownTexts.includes(t))];
  return next.slice(0, limit);
}

// localStorage wrappers. Storage can be missing or full; chips still work.
export function loadRecent(tab) {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}")[tab] || []; }
  catch { return []; }
}
export function saveRecent(tab, shownTexts) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    all[tab] = rememberShown(all[tab] || [], shownTexts, RECENT_LIMIT[tab] || 12);
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch { /* chips still work without the cooldown */ }
}
