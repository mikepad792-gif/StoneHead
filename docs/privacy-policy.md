# StoneHead AI — Privacy Policy

**Last updated:** September 26, 2026

StoneHead AI is built and operated by one person. This policy is written plainly, because you deserve to actually understand what happens to what you type. If anything here is unclear, ask me.

---

## The short version

- I store your email, your username, and your conversations, because the app doesn't work otherwise.
- Your messages are sent to third-party AI providers to generate replies. That's how the app works, and it's the part I control least.
- Photos you send on Talk the Plant go to an AI to be looked at, and they're never saved. See [Photos](#photos-talk-the-plant-only).
- Before your message goes anywhere, the app checks it against a list of phrases that suggest a crisis or a drug emergency. See [The safety layer](#the-safety-layer) — it's the one part of the app that reads your words before the AI does.
- I don't train AI models on your conversations. I also can't speak for what the AI providers do — see [Training](#about-training) below, where I've been specific about that.
- If you rate a reply with a thumbs up or down, I can read that one reply and your message before it, even if the thread's data toggle is off. A shared thumbs-up can become a test case for tuning StoneHead. See [Reply ratings](#reply-ratings).
- StoneHead remembers things about you across sessions — that's a feature, and you can delete it.
- I don't sell your data. I don't run ads. There is no analytics tracker following you around.
- You can delete your account and everything in it, at any time, from the app. One exception: memory summaries from chats where you turned the data toggle on are kept, with nothing that links them to you.
- There's a Discord bot. It gets your Discord user ID and server ID and uses them to count requests and to avoid repeating itself. Nothing else. See [The Discord bot](#the-discord-bot).

---

## What I collect

**Account information**
- Your email address (to log you in and recover your account)
- Your username (shown in the app)
- Your password (stored as a secure hash — I cannot see your password)
- Whether you've confirmed you're 21+ (required for the Talk the Plant tab), and, if you've mentioned your age in conversation, which broad age band you said you were in — I store the band, never a birth date
- Whether you have a pass, and when it ends

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

### Reply ratings

Under each StoneHead reply there's a thumbs up and a thumbs down. If you use them, I save:
- which reply you rated, and whether it was up or down
- the comment you wrote, if you wrote one (it's optional, on either thumb)
- which version of StoneHead you were using
- for a thumbs up, whether you chose "share it" (every saved thumbs-up has), and whether you asked not to see that prompt again

Rating a reply is permission for me to read **that reply and the message you sent right before it**, even in a thread with the data toggle off. Only that one exchange, not the rest of the thread. That's what lets me see what went wrong behind a thumbs down.

A thumbs-up you share may be used to train and improve StoneHead. Here, that means one specific thing: the exchange can become a test case or an example I use when I tune StoneHead's prompts and reference material. It does not mean training an AI model. See [About training](#about-training).

Replies to messages that set off the [safety layer](#the-safety-layer) can't be rated at all. Someone's worst night doesn't become test data.

You can take a rating back at any time by tapping the same thumb again, which deletes it. Ratings are also deleted when you delete the thread or your account.

### Photos (Talk the Plant only)

On Talk the Plant you can send a photo of your plant. Here's everything that happens to it:
- It goes through OpenRouter to **Anthropic's Claude**, which looks at it and writes a short text description of what's on the plant. StoneHead answers from that description. The model that writes StoneHead's replies can't see images, which is why a second AI is involved.
- **The photo itself is never saved.** It's on my server for the few seconds it takes to send, and it's never written to the database, to storage, or to logs.
- What I do save: that text description, which conversation it belongs to, and which AI wrote it. It's deleted when you delete the thread or your account.
- Before a photo leaves your phone, the app redraws it, which strips the hidden data phones attach to pictures, including GPS location. The server strips it again in case anything slipped through.
- The photo request is sent with OpenRouter's setting that only allows providers who don't keep or train on what they're sent.
- StoneHead is told to ignore people in photos, but whatever is in the frame still gets sent. Keep faces, and anything with your address on it, out of the shot.
- There's a daily limit on photos, because each one costs real money to read. See the Terms for how the limit and rollover work.

**Passes and payments**
If you buy a pass, you pay on Stripe's checkout page, and **Stripe handles your card details**. I never see or store your card number. Stripe tells me the purchase went through, and I keep a record of each pass: which pass, when it started and ends, and the amount and currency. Stripe emails you a receipt, so Stripe has your email for that. What Stripe does with payment information is covered by [Stripe's privacy policy](https://stripe.com/privacy), not mine.

**Photo usage**
How many photo reads you used each day, and your rollover count. These are counts, not photos: photos are read once and never saved. They're kept per day so the daily limit works even if you delete a thread, and they're deleted with your account.

**Technical data**
- Token counts per message (how much text was processed — used to understand costs)
- Timestamps
- Error logs when something breaks. These record which AI model was called and what went wrong. They do not contain the body of your messages.
- **Safety-layer records.** When the crisis or drug-emergency check fires, the app records that it fired, which tier, and **the specific phrase that matched** — which is a short piece of text you actually typed. I'm calling that out rather than filing it under "technical data" and hoping you don't notice. See below.

**What I do NOT collect**
- No advertising or tracking cookies
- No third-party analytics following you around the web
- No location data
- No payment card details. Card payments are handled by Stripe; I never see or store your card number
- No date of birth (age is self-attested — I ask, you confirm)

---

## The Discord bot

StoneHead AI runs a bot in Discord. If you've never used it, nothing in this section applies to you.

When you run one of its commands, Discord hands me two numbers: your Discord user ID and the ID of the server you ran it in. Those are the numeric IDs Discord assigns. I don't get your Discord username, your email, or anything else from your profile, and in a DM there's no server ID at all.

I use them for two internal operations, and nothing else:

- **Usage limits.** Both IDs key an hourly counter, so one person or one busy server can't run the bot's costs up for everyone else.
- **Not repeating myself.** Your user ID is stored with a flag saying the bot has already introduced itself to you, and with the names of the last 20 strains it has shown you, so it doesn't hand you the same suggestion twice. That's a list of strain names, not of anything you typed.

**What the bot does not do.** What you type in a command isn't stored. It goes to the AI provider to generate the reply, and through the same safety layer described below that every message in the app goes through, and then it's gone. The bot's own logs record the server ID, the strain it answered with, and how many characters you typed — not your user ID and not your words. None of this builds a profile, none of it is used for advertising, and none of it is sold or shared.

**Not linked to your account.** Bot activity isn't connected to a StoneHead account, even if you have one. Your Discord ID and your email address never meet.

**Retention, specifically.** The hourly counter resets every hour. The intro flag and the recent-strain list stay on that row until they're removed — email me at stoneheadAI@gmail.com with your Discord user ID and I'll delete it. You don't need an account to ask.

This is here because of the children's-privacy rule on persistent identifiers: collecting one for internal operations like rate limiting is allowed, but only if it's disclosed and only if it isn't used for anything else. The two bullets above are the whole of what it's used for.

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

**Photo descriptions follow the same rule.** I only look at the description of a photo in a thread where the toggle is on.

**One exception, stated plainly:** the safety-layer records described above are operational logs, not thread content, and I look at them regardless of the toggle. That's how I find out the crisis check is failing. If that isn't acceptable to you, the honest answer is that this app isn't for you.

**Two things reach past the toggle, and you choose both:**
- Rating a reply lets me read that one exchange even with the toggle off. See [Reply ratings](#reply-ratings).
- If you delete your account, memory summaries from threads where the toggle was **on** are kept, with no name, email, account, or thread attached. A summary is free text written by the AI, so it can still mention something like a name or a town you brought up; it isn't scrubbed of those. You agreed to review of that thread when you turned the toggle on, and this is the part of it that outlives the account.

I could have written this section to sound stronger. I'd rather you know exactly what you're getting: my word, and a default that starts at off so you're never opted in without choosing it.

---

## Who else sees your messages

**The AI providers.** To generate a reply, your message is sent over the internet to third-party AI services. Right now that means requests are routed through [OpenRouter](https://openrouter.ai/privacy), which passes them to the model that generates the reply — currently DeepSeek, with [Anthropic](https://www.anthropic.com/legal/privacy)'s Claude as a backup when the primary is unavailable.

Your message text is transmitted to them, along with recent context from the conversation and any memory StoneHead has of you. Their handling of that data is governed by their own privacy policies, not mine. I don't control it. If that doesn't sit right with you, this might not be the right app for you yet — and I'd rather tell you that plainly than bury it.

**Photos are the one place a different AI is used.** The model that writes replies can't see images, so photos go to Anthropic's Claude, through OpenRouter, to be described. Claude doesn't write your replies; it only reports what's in the picture. See [Photos](#photos-talk-the-plant-only).

**The database provider.** Your data is stored in a Supabase database (Postgres) and the app is hosted on Netlify. They store the data; they don't use it.

**Stripe**, only if you buy a pass. Stripe processes the payment and sends your receipt. It doesn't see your conversations.

**Me.** I can technically see the database. I don't read conversations for entertainment, and I don't go looking through people's threads. If you turn the data toggle **on**, you're giving me permission to read that thread to improve the app. If it's off, I leave it alone, with two exceptions: the safety logs named above, and any single exchange you rated with a thumbs up or down.

**Nobody else.** I don't sell your data. I don't share it with advertisers. I don't have a business model that depends on it.

---

## Links out

When the safety layer fires it may point you to resources run by other organizations — the 988 Suicide & Crisis Lifeline, Never Use Alone, naloxone finders, and similar. Those are not mine. If you call, text, or visit them, whatever happens there is between you and them under their own policies. I don't get told that you went, and I have no relationship with any of them.

---

## About training

Earlier versions of this policy said your conversations were never used to train any AI model, "not mine, not anyone else's." The first half of that was true. The second half was a promise I wasn't in a position to make, and I'm correcting it rather than leaving it up.

**What I can tell you for certain:** I don't train AI models and I don't fine-tune anything. StoneHead's knowledge comes from material I assembled myself — cultivation research from university extension services, strain data, cannabis history — not from what users type.

**The one exception, since September 24, 2026:** when you give a reply a thumbs-up and choose "share it", that reply and your message before it may be kept as a test case or example for tuning StoneHead's prompts and reference material. That's what "train and improve StoneHead" means in that prompt. Until this update, this section also said I had never exported anyone's conversations to build a dataset. That stays true for everything you haven't shared this way. If I ever fine-tune a model on shared exchanges, that's a new use, and I'll ask you to accept a new policy first.

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

As long as you have an account. If you delete your account, your data — conversations, memories, reply ratings, photo reads, everything linked to you — is deleted with it, including your login.

Your pass records and photo usage counts are deleted with the account too. Stripe keeps its own record of the payment (it's required to, for tax and fraud reasons), under Stripe's policy.

**One exception:** memory summaries from threads where you turned the data toggle on are copied out first and kept, with no account, email, username, or thread attached, and only the month they were written. Nothing in what's kept links back to you. See [The data toggle](#the-data-toggle) for what a summary can still contain.

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

**September 26, 2026.** Photos. On Talk the Plant you can send a photo of your plant; Anthropic's Claude reads it, the photo is never saved, and only a text description is kept (see [Photos](#photos-talk-the-plant-only)). Also on this date: passes. You can buy a 7-day or 30-day pass through Stripe. Stripe handles card details; StoneHead keeps a record of each pass and a per-day count of photo reads (see [What I collect](#what-i-collect)). Both are new kinds of stored data, so you're being asked to accept the policy again.

**September 24, 2026.** Two changes, so you're being asked to accept the policy again.
- **Delete my account is now a real button** in your profile. This policy already promised it; now it exists. It also changes one promise: memory summaries from threads where you turned the data toggle on now outlive your account, unlinked. Before this, the policy said everything was deleted with the account.
- **Reply ratings.** You can rate replies with a thumbs up or down. Rating a reply lets me read that one exchange even with the data toggle off, and a shared thumbs-up can become a test case for tuning StoneHead. That corrects what [About training](#about-training) said before: that I had never exported anyone's conversations for a dataset. See [Reply ratings](#reply-ratings).

The Terms of Service changed with it, to match.

**September 20, 2026.** Added [The Discord bot](#the-discord-bot). The bot now stores two things against your Discord user ID that it didn't before: a flag saying it has already introduced itself to you, and the names of the last 20 strains it has shown you, so it doesn't repeat a suggestion. Nothing about what you type is stored, and none of it is linked to a StoneHead account. This is a new category of stored data, so you're being asked to accept the policy again — that's what the re-prompt is for, not a wording tweak.

The Terms of Service are unchanged; their date moved with this one because a single version string covers both documents.

---

## Contact

Michael Padilla
stoneheadAI@gmail.com

Discord: the StoneHead AI server (linked in the app)
