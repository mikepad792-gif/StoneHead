# StoneHead AI — Privacy Policy

**Last updated:** August 5, 2026

StoneHead AI is built and operated by one person. This policy is written plainly, because you deserve to actually understand what happens to what you type. If anything here is unclear, ask me.

---

## The short version

- I store your email, your username, and your conversations, because the app doesn't work otherwise.
- Your messages are sent to third-party AI providers to generate replies. That's how the app works, and it's the part I control least.
- Before your message goes anywhere, the app checks it against a list of phrases that suggest a crisis or a drug emergency. See [The safety layer](#the-safety-layer) — it's the one part of the app that reads your words before the AI does.
- I don't train AI models on your conversations. I also can't speak for what the AI providers do — see [Training](#about-training) below, where I've been specific about that.
- StoneHead remembers things about you across sessions — that's a feature, and you can delete it.
- I don't sell your data. I don't run ads. There is no analytics tracker following you around.
- You can delete your account and everything in it, at any time, from the app.

---

## What I collect

**Account information**
- Your email address (to log you in and recover your account)
- Your username (shown in the app)
- Your password (stored as a secure hash — I cannot see your password)
- Whether you've confirmed you're 21+ (required for the Talk the Plant tab), and, if you've mentioned your age in conversation, which broad age band you said you were in — I store the band, never a birth date
- Whether you have a subscription, and when it expires

**Your conversations**
- Every message you send and every reply StoneHead gives
- Which tab it was on (the vibe / talk the plant)
- The title of each conversation thread (generated automatically from the conversation)

**What StoneHead remembers about you**
This is the part most apps don't tell you about, so I want to be direct.

StoneHead builds memory so conversations carry forward instead of restarting cold each time:
- **Session memories** — short summaries of a conversation thread
- **Core memories** — longer-running things StoneHead has picked up about you across conversations
- **Liked strains** — strains you've saved, with any notes you added

This is what makes StoneHead feel like it knows you. It's also the most personal data in the app. **You can view and delete these at any time in the memory section of the app.**

**Technical data**
- Token counts per message (how much text was processed — used to understand costs)
- Timestamps
- Error logs when something breaks. These record which AI model was called and what went wrong. They do not contain the body of your messages.
- **Safety-layer records.** When the crisis or drug-emergency check fires, the app records that it fired, which tier, and **the specific phrase that matched** — which is a short piece of text you actually typed. I'm calling that out rather than filing it under "technical data" and hoping you don't notice. See below.

**What I do NOT collect**
- No advertising or tracking cookies
- No third-party analytics following you around the web
- No location data
- No payment card details (there is currently no live payment system)
- No date of birth (age is self-attested — I ask, you confirm)

---

## The safety layer

Some things are too important to leave to an AI's judgment in the moment. So before your message is sent to the AI at all, the app checks it in code against lists of phrases.

**What it checks for:**
- Language suggesting you might be thinking about hurting yourself
- Language suggesting you've taken something and might be in physical danger

**What happens when it fires:** StoneHead responds with fixed text I wrote in advance rather than something the AI generated on the spot. Depending on what you said, that's either a question about what you meant, or a response that names **988** (crisis, call or text, any hour) or **911** and points you toward people actually equipped to help.

**What gets recorded:** that it fired, which tier, the timestamp, and the phrase that matched. That last one is a fragment of what you typed, and it's stored so I can tell whether the safety layer is working — including whether it's firing when it shouldn't.

**What does not happen:** nobody is alerted in real time. I am not watching. There is no monitoring desk, no notification on my phone, no report to anyone. It's a check in code and a log I read later, in batches, to find out where the thing is broken. **No one is contacted on your behalf, ever.** If you need someone, you have to reach out yourself — that's why the app gives you the numbers.

**It gets it wrong sometimes.** It fires on things people say casually — "I don't want to be here anymore" about a party, "I'm done" about a bad night. If you get a serious response you didn't expect, that's a false positive, not a judgment about you. Tell it what you meant and it moves on.

**This is not a crisis service.** It's a check in code written by one person. It will miss things. Please don't treat it as a safety net you can rely on.

The messages that trigger it are stored the same way as every other message in your thread, and deleted the same way when you delete the thread or your account.

---

## The data toggle

Each conversation has a **data toggle**, and it is **off by default**.

I want to be precise about what this is, because a switch in an app can imply more than it delivers.

**What it is:** a permission record. Turning it on marks that thread as one I'm allowed to open when I'm trying to work out why StoneHead gave a bad answer — where it guessed, where the voice broke, where it got something wrong. Leaving it off means I don't.

**What it is not:** encryption. I have administrative access to the database that stores your messages, and this toggle does not take that access away. It is a commitment about what I do, not a technical lock on what I'm able to do.

**One exception, stated plainly:** the safety-layer records described above are operational logs, not thread content, and I look at them regardless of the toggle. That's how I find out the crisis check is failing. If that isn't acceptable to you, the honest answer is that this app isn't for you.

I could have written this section to sound stronger. I'd rather you know exactly what you're getting: my word, and a default that starts at off so you're never opted in without choosing it.

---

## Who else sees your messages

**The AI providers.** To generate a reply, your message is sent over the internet to third-party AI services. Right now that means requests are routed through [OpenRouter](https://openrouter.ai/privacy), which passes them to the model that generates the reply — currently DeepSeek, with [Anthropic](https://www.anthropic.com/legal/privacy)'s Claude as a backup when the primary is unavailable.

Your message text is transmitted to them, along with recent context from the conversation and any memory StoneHead has of you. Their handling of that data is governed by their own privacy policies, not mine. I don't control it. If that doesn't sit right with you, this might not be the right app for you yet — and I'd rather tell you that plainly than bury it.

**The database provider.** Your data is stored in a Supabase database (Postgres) and the app is hosted on Netlify. They store the data; they don't use it.

**Me.** I can technically see the database. I don't read conversations for entertainment, and I don't go looking through people's threads. If you turn the data toggle **on**, you're giving me permission to read that thread to improve the app. If it's off, I leave it alone — with the safety-log exception named above.

**Nobody else.** I don't sell your data. I don't share it with advertisers. I don't have a business model that depends on it.

---

## Links out

When the safety layer fires it may point you to resources run by other organizations — the 988 Suicide & Crisis Lifeline, Never Use Alone, naloxone finders, and similar. Those are not mine. If you call, text, or visit them, whatever happens there is between you and them under their own policies. I don't get told that you went, and I have no relationship with any of them.

---

## About training

Earlier versions of this policy said your conversations were never used to train any AI model, "not mine, not anyone else's." The first half of that was true. The second half was a promise I wasn't in a position to make, and I'm correcting it rather than leaving it up.

**What I can tell you for certain:** I don't train AI models. I don't fine-tune anything, and I have never exported anyone's conversations to build a dataset. StoneHead's knowledge comes from material I assembled myself — cultivation research from university extension services, strain data, cannabis history — not from what users type.

**What I can't control:** the AI providers your messages pass through. Some model endpoints — particularly free ones — reserve the right to use what goes through them to improve their own systems. StoneHead has run on free endpoints for much of its life, which means messages sent before **August 5, 2026** may have been used that way by a provider, under their terms rather than mine.

As of that date StoneHead runs on paid endpoints, where the providers' terms say inputs are not used for training. That's their commitment to me, and I'm passing it to you as exactly what it is — a contract with someone else, not something I can personally guarantee.

If that ever changes, I'll say so here with the date it changed.

---

## Age

The **Talk the Plant** tab is for 21+ only, and asks you to confirm your age before you can use it.

**The vibe tab has no age gate.** It's for conversation — life, ideas, whatever's on your mind. It does not give strain recommendations, dosing guidance, or grow diagnosis; if you ask it for those, it points you to the 21+ tab instead. It does talk about cannabis history and culture, because that's part of what it is.

Age is self-attested. I ask; I trust your answer. If you're under 21, don't use the plant tab.

You must be at least 13 to use StoneHead at all. If I learn that someone under 13 has created an account, I'll delete it.

---

## How long I keep things

As long as you have an account. If you delete your account, your data — conversations, memories, everything linked to you — is deleted with it.

---

## Your rights over your data

You can, at any time:
- **See what StoneHead remembers** about you (in the app's memory section)
- **Delete individual memories**
- **Delete a conversation thread** (and its messages and summaries)
- **Delete your entire account and all data** — there's a button in the app, and it takes effect immediately. You can also email me and I'll do it.
- **Ask me what I have on you** and I'll tell you

Depending on where you live (California, the EU, and others), you may have additional legal rights over your data. I'll honor them. You don't need to cite a statute — just ask.

**Contact:** stoneheadAI@gmail.com

---

## Security, honestly

Passwords are hashed and never stored in readable form. Data is transmitted over HTTPS. The database is locked down so users can only see their own rows.

But I want to be honest with you: **this is a small project built by one person, not a company with a security team.** I've done what I know how to do, and I'll keep improving it. I'm not going to claim a level of security I can't guarantee. If you wouldn't want something read by a stranger in a worst case, think twice before typing it into any app — including this one.

If you find a security problem, please tell me. I'll fix it and I'll credit you.

---

## Changes

If I change this policy in a way that matters, I'll say so in the app and in the Discord — not quietly. When a change means something I previously told you was wrong, I'll say that too, rather than editing it out.

---

## Contact

Michael Padilla
stoneheadAI@gmail.com

Discord: the StoneHead AI server (linked in the app)
