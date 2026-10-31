# Mobile UI design prompt: Taash (Thulla)

Copy everything below the line into your design tool (Figma AI, Google Stitch, v0, Galileo, Uizard, an image model, or a human designer brief). A shorter version for tools with a character limit is at the end.

---

## Role and goal

You are a senior mobile game UI/UX designer. Design the complete mobile app UI for **Taash**, an online card room for traditional South Asian card games played with friends. The first and only playable game is **Thulla** (Urdu: ٹھلا), a Pakistani shedding game. Three more games (Rung, Bluff, Seep) are "in the workshop" and appear as locked teasers.

The app is a **pure client**. All data comes from a backend over a REST API plus a realtime WebSocket channel. The client never decides game outcomes: it sends actions, then animates what the server says happened. Design every screen so it can be bound directly to the data contracts listed in section 9, and include loading, empty, error and reconnecting states for each.

Deliver a cohesive, production-ready design: a design system, every screen listed below at phone size (390 × 844 pt, iPhone 15 frame), key states, and the in-game motion spec.

## 1. Product and audience

- **Who plays:** families and friend groups, mostly Pakistani and South Asian diaspora, ages 16–60. Many learned Thulla at family gatherings. Some are casual phone users, so clarity beats density.
- **How they play:** someone creates a table, shares a six-character code (e.g. `QAF-7R2`) or a WhatsApp link, friends join, and the host starts the game. Guests can play with just a display name; accounts keep a rating, coins, history and friends.
- **Session length:** 15–30 minutes per game, often several rematches in a row.
- **Tone:** warm, a little cheeky, culturally specific without being a costume. Short Urdu/Punjabi exclamations appear as flavour ("Oye hoye!", "Shabash!", "Pakra gaya!", "Wah ji wah!", "Bhaag gaya!", "Darr gaya!", "Itni jaldi?"). All UI copy is in English; these lines are seasoning, never instructions.

## 2. Visual identity (keep this; it is the existing brand)

**Concept:** a lamp-lit card room at night. Dark aubergine walls, a green baize table at the centre of every game, ivory paper cards, and gold used sparingly for only three things: the host, whose turn it is, and the winner. Dark theme only, by choice.

**Colour tokens**

| Role | Token | Hex |
| --- | --- | --- |
| Room background, darkest → lightest | night-950 / 900 / 850 / 800 | `#0c0915` `#120e1f` `#17122a` `#1d1733` |
| Plum surfaces | plum-700 / 600 / 500 | `#2a2045` `#3a2c5c` `#54417f` |
| Primary text | ivory-50 | `#f7f0e1` |
| Secondary / tertiary text | lavender-300 / 400 | `#b8a9d8` `#9787bd` |
| Hairlines | lavender-600 at 45% | `#6b5c94` |
| Gold (host, turn, primary action) | gold-300 / 400 / 500, text on gold `#241a06` | `#ead197` `#d6b06a` `#b88f45` |
| Thulla impact | ember-400 / 500 | `#f07a52` `#d9583a` |
| Cleared / success | mist-300 | `#9fd8c6` |
| Error | rose-300 | `#f0a3b2` |
| Table felt | baize-700 / 800 / 900 | `#0f3a31` `#0b2c26` `#071d19` |
| Table rail | rail-700 / 500 | `#2b1c35` `#4a3158` |
| Card paper / edge | | `#fbf6ea` `#e8dcc2` |
| Card ink: red / black / court gold | | `#b0263a` `#1e1824` `#a8823c` |
| Default card back | | `#2c1e48` → `#43306b` |

**Type**

- Display: **Rozha One** (game name, big moments like "Thulla!", winner banner).
- Body/UI: **Hanken Grotesk** (13–17 pt; 15 pt body). Tabular numerals for ratings, timers and counts.
- Card indices: **Libre Caslon Text**.
- Urdu: **Noto Nastaliq Urdu** (the ٹھلا wordmark and any Urdu accents).

**Shape and depth:** 4 pt spacing grid. Radii 6 / 10 / 16 / 24 / pill. Soft, deep shadows (the room is dark, so elevation reads as warm lamplight on raised surfaces, not grey drop shadows). Glassy plum panels at ~55% opacity over the room. Gold glow ring (`0 0 0 1px` gold + soft 24 px bloom) marks the active turn.

**Motion character:** cards slide with an ease-out; selections lift with a slight spring; a Thulla "slams" down (fast ease-in, small screen shake, ember flash). Respect reduced-motion: replace movement with fades.

**Avoid:** casino/gambling visuals (chips, slot glitter, neon, "jackpot"), generic purple-gradient SaaS look, cartoon mascots, emoji as icons, light mode.

## 3. Game rules the UI must express

Design for these exact rules; every one has a visible consequence on screen.

1. **Deck:** 52 cards, no jokers, A high to 2 low, no trump. Suits are called **shapes**.
2. **Deal:** cards are dealt one at a time, anti-clockwise, until the deck runs out. Hands may differ by one card. With 2 players each holds 26 cards; with 4, 13.
3. **First baari (round):** the player with the **A♠** must open with it. Everyone follows Spades if they can; anyone without Spades discards any card, and in this round that is never a Thulla. The whole pile is cleared. The A♠ holder leads next.
4. **Later baaris:** the leader plays any card; its shape must be followed by anyone who holds it (the UI must disable or dim illegal cards). The first player who cannot follow plays an off-shape card: a **Thulla**. The baari stops at once. The player with the highest card of the led shape **collects the whole pile** into their hand and leads next. If nobody gives Thulla, the pile is cleared for good and the highest card leads.
5. **Finishing:** a player who empties their hand finishes when the baari resolves (unless they must collect a pile). Places are 1st, 2nd, 3rd… The **last player holding cards loses**.
6. **Hand request:** from baari 2, the leader, before leading, may ask the next active player for their whole hand, once per turn. The other player chooses **Give** (all their cards move to the requester, they finish in the next place, and the whole table sees exactly those cards for a few seconds) or **Keep** (nothing happens). No answer in time counts as Keep.
7. **Timers:** every turn has a countdown (default 30 s). On timeout the server plays a sensible card for you. Three timeouts in a row mark you **away** (auto-play), and an **I'm back** button returns control.
8. **Forfeit:** the only way to end early. The forfeiter loses; everyone else shares the win. Shown with a white flag, a greyed seat and boos.
9. **Optional cleared counters:** for each shape, how many of its 13 cards have left play for good.

## 4. Information architecture

Bottom tab bar (5 tabs): **Play** (home) · **Rooms** (open tables / join) · **Friends** · **Ranks** (leaderboard) · **Me** (profile, shop, settings). Coins balance and avatar live in a slim top bar. When the user is already seated at a table, a persistent gold **"Return to your table"** banner sits above the tab bar on every screen (a person can be at only one table at a time).

The game table, lobby and results are full-screen flows without the tab bar.

## 5. Screens to design

For every screen show: default, loading (skeletons, not spinners), empty, and error states. Note where pull-to-refresh applies.

### 5.1 Onboarding and identity
1. **Splash:** Taash wordmark, a fanned hand of five cards (10♥ J♣ Q♦ K♥ A♠) on felt, lamplight vignette.
2. **Welcome:** "Pull up a chair." Three choices: **Play as guest** (just a display name), **Sign in**, **Create account**.
3. **Guest name sheet:** one field, "Shown at the table and in chat. No account or email needed."
4. **Sign in:** email + password, "Forgot password?".
5. **Register:** display name, unique handle (live availability check with inline ✓ / taken), email, password with strength hint.
6. **Forgot / reset password:** request email → "check your inbox" → set new password.

### 5.2 Play (home)
- Greeting card: avatar, name, "Welcome back" or "Playing as a guest" with an upsell to create an account.
- Stat strip (accounts only): Thulla rating with 30-day delta (+/−, mist or rose), winning streak, games played.
- **Featured game card: Thulla** with the ٹھلا wordmark, tagline "Follow the shape, or slap down a Thulla.", facts (2+ players, 4 is classic · 15–30 min · 52 cards), and actions: **Create table** (primary gold), **Join with code**, **How to play**.
- Friends online: avatar stack with green presence dots.
- **Open rooms** preview (3 rows, see 5.3).
- **In the workshop:** locked cards for Rung, Bluff, Seep with suit glyphs and a "Not yet playable" chip.
- Recent games (accounts) or recent public results (guests).

### 5.3 Rooms
- **Join with code:** large segmented code input `XXX-XXX`, auto-uppercase, paste support, "Watch this table instead" secondary action. Deep links (`/t/QAF-7R2`) land here pre-filled.
- **Open rooms list** (refreshes every 5 s): each row shows host avatar and name, table design swatch, seats filled `3/4`, ranked/unranked chip, guests allowed, spectator slots, and **Join** or **Watch** (if full or in progress).
- Empty state: "No open rooms right now. Start one and make it public."

### 5.4 Create table (bottom sheet)
- Hosting as {name}. Guest hosts see "You're hosting as a guest. No account needed."
- **Table options:** Ranked / Unranked toggle · Who can find it: Public / Private · Allow guests / Accounts only · Spectators stepper (0–20, default 4).
- **Game settings:** Seats (2–52, default 4) · Turn time (5 s – 10 min, default 30 s) · Baari pile display (1–10 s, half-second steps, default 3 s) · Hand reveal duration (2–20 s, default 5 s) · Cleared counters on/off.
- Explain each with one line of helper text. Locked fields show why (e.g. "Remove bots to make this table ranked").

### 5.5 Lobby (pre-game, full screen)
- Header: table code in a big tappable pill (**Copy code**), share row (**WhatsApp**, **Share link**, **Copy**), "Hosted by {name}" with gold host crown.
- **Mini table preview** in the centre: the felt in the chosen table design with seats arranged around it ("At the table"), each seat showing avatar, name, rating, and a Ready check. Empty seats say "Open seat" with **Invite** and (unranked only) **Bot** buttons.
- Bot personalities to illustrate: Bashir Chacha (cautious), Rani Apa (sharp), Pappu (reckless), Nano (steady), each with a small bot badge.
- **Spectators** strip; "Watch instead" / "Take a seat" for yourself; the host can long-press a player for **Move to spectators** or **Remove**.
- **Table design** line: e.g. "Truck art · Ali's table" (the most prestigious design owned by any seated player is used).
- **Invite friends** sheet: online friends with checkboxes, message preview, "Invites reach friends who are online on Taash."
- Host footer: **Start game** (gold, disabled until 2+ seated and ready, with the reason shown). Non-host footer: **Ready** toggle and **Leave table**.
- Short-of-players nudge: "Short of players? Make the table unranked and add a bot."
- Chat button with unread badge.

### 5.6 Game table: the core screen (design this with the most care)

**Orientation:** portrait first. Provide a landscape variant too.

**Layout, top to bottom (portrait):**
1. **Top strip (thin):** back/leave, table code, baari number ("Baari 4"), table-info button, sound-board button, chat button with unread dot.
2. **Opponents arc:** seats arranged anti-clockwise around the top and sides of an oval felt. Each seat: avatar, name, card-count badge on a small fanned stack of face-down cards in that player's card-back design, rating (small), status chips (Host crown, "Away · auto-play", "Finished 2nd", bot badge, disconnected). The **active seat** has a gold glow ring that drains as a circular timer, with seconds shown.
   - Show layouts for **2, 3, 4, 6 and 8 players**. For 9+ players (up to 52 are allowed), switch to a horizontally scrollable seat rail along the top with the active player auto-centred.
3. **Centre felt (the baari):** cards played this baari fan out toward the centre from each player's direction, each card showing the player's card-front design. A **"shape to follow"** indicator (large suit glyph with "Follow ♥") sits on the felt. Space for the highest card so far to be subtly marked. Optional cleared counters: four small suit chips showing `9/13` cleared.
4. **Your status line:** one sentence of guidance that changes with state, e.g. "Your lead.", "Follow Hearts.", "No Spades — play any card. It is cleared, not Thulla, in the first baari.", "You hold the A♠ — open the first baari with it.", "Waiting for Ayesha…".
5. **Your hand (bottom):** an overlapping fan, sorted toggle **By shape / By rank**, with per-shape counts. Must handle 1 to 26+ cards (after collecting piles a hand can exceed 30): overlap tightens, then the fan becomes horizontally scrollable with edge fades. Illegal cards are dimmed and pushed down slightly; legal ones stay bright. Minimum tap target 44 pt even when overlapped (tap the visible sliver).
6. **Action bar:** your turn timer bar (gold, drains), **Play card** (appears once a card is selected; alternatively tap a selected card again or flick it up to play), and **Request hand** when allowed (leader, before leading, from baari 2).

**Interaction:** tap to select (card lifts 16 pt with a spring and gets a gold edge), tap again or press Play to throw. Flick-up gesture plays. Haptics: light on select, medium on play, heavy on Thulla.

**In-game moments to design as separate frames (with motion notes):**
- **Dealing:** cards fly from the dealer one by one, anti-clockwise; "Dealing 13 cards…".
- **Your turn:** gold ring on your avatar, timer bar, "Your turn." toast, haptic.
- **Normal baari clear:** "Baari clears." The pile slides off the table edge and fades; "Clearing in 3…" countdown on the felt.
- **THULLA!:** the off-shape card slams in with an ember flash, short shake, the word "Thulla!" in Rozha One across the felt, the giver labelled "Gave Thulla", then the whole pile sweeps into the collector's seat with "+7" ("You eat the pile. +7" if it's you; "Collect your shame: +7" as flavour). The collector's card count bumps.
- **Hand request (requester):** confirmation sheet "Request Ayesha's hand?" with "If they give: …" / "If they keep: …" explanations; then "Waiting for an answer to the request."
- **Hand request (receiver):** a focused modal over the table with a countdown: **Give my 6 cards** vs **Keep my cards**, and "You decide. Either choice is fair play. If time runs out, you keep your cards."
- **Hand reveal (everyone):** the transferred cards are shown face-up in a centre spotlight to the whole table for 5 s with a progress bar: "Showing the cards that changed hands."
- **Player finishes:** their seat gets a "Finished 1st" medallion and dims gently; flavour shout "Bhaag gaya!".
- **Away:** banner "You are marked away — your turns are played for you." with a big **I'm back** button.
- **Reconnecting:** non-blocking top banner "Reconnecting…" with the table frozen underneath; on return "Welcome back — you are playing again."
- **Forfeit confirm:** "Forfeit this game?" with consequences; the forfeiter's seat greys with a white flag.
- **Spectator mode:** no hand area; a "Watching" chip and **Stop watching**; you see every card played, never anyone's hand.

**Overlays and drawers on the table:**
- **Table info drawer:** players list in playing order (anti-clockwise) with turn marker and away state, table design and owner, settings summary, **Mark me away**, **How to play**, **Forfeit the game**, **Leave table**.
- **Baari log:** finished baaris as compact rows (who led, shape, Thulla → who collected, or "Cleared for good").
- **Chat drawer** (bottom sheet, half height): messages, max 400 chars; new messages from others also pop as a speech bubble beside the sender's seat for a few seconds. Bots chat too.
- **Sound board** popover: a grid of short sound buttons (Air horn, Bruh, Drum roll, etc.); when someone plays one it pops by their seat and appears in a small feed ("Ali played Drum Roll"). Includes a **volume mixer**: master slider plus one slider and mute per player. One sound per player every 2.5 s, so show a cooldown ring on the buttons.
- **How to play** drawer (rules from section 3, illustrated).

### 5.7 Results (end of game)
- Hero: winner (gold), with the loser shown as "Holding the cards" (or "Everyone got out!" if nobody is left holding). Victory or defeat sound cue.
- **Finishing order** list: place, avatar, name, rating delta (+16 / −16) animating from the old to the new rating, coins earned (+40, +30, +20, +10, +5 for holding the cards), streak changes.
- "How the game went" stats: baaris played, Thullas given, most Thullas, biggest pile collected, hand requests, cleared for good.
- Notices: "Unranked game: ratings and coins don't change." / "Guests aren't rated and don't earn coins. Create an account to keep both." / "Updating your rating…".
- Actions: **Play again** (host), Ready for rematch (others), **Table settings** and **Manage players** (host), **Add friend** on each player row, **Leave table**.

### 5.8 Friends
- Tabs: Friends · Requests · Add.
- Friends list with presence (online / at a table / offline), "Invite to a table" when you're in a lobby.
- Requests: incoming (Accept / Decline) and outgoing ("Waiting for an answer", Cancel request).
- Add by handle with live lookup, **Send request**.
- **Incoming table invite**: a toast/sheet over any screen: "Ali invited you to a Thulla table" with **Join** / **Not now**.

### 5.9 Ranks (leaderboard)
- Title "Who rules the Thulla table". Scope toggle **Everyone / Friends**.
- Podium for the top 3, then a ranked list: rank, avatar, name, rating, games played, rank-tier badge. Your own row is pinned at the bottom if you're off-screen. Paged (50 per page, infinite scroll).

### 5.10 Me (profile)
- Header: avatar, display name, @handle, rank tier badge (Rising 1550, Skilled 1600, Expert 1650, Master 1700, Grandmaster 1800, Champion 1850, Legend 1900), member since.
- Stats grid: Thulla rating and peak, games played, finished 1st, held the cards, current winning and losing streaks.
- **Rating trend** sparkline / line chart over recent games.
- **Finishing history:** the last 20 games with when, table, baaris, finish place, rating change, and "Played with" avatars.
- Public profile variant (`/u/handle`) with **Add friend** instead of edit controls.
- Settings: edit profile, sound on/off, haptics, reduced motion, sign out, sign out everywhere, change password.
- Guest variant: stats empty-state with "Create an account to keep a rating and history."

### 5.11 Shop and rank rewards
- Coin balance header and "Win coins in ranked games."
- Two tabs: **Card designs** and **Table designs**. Every card design has a **back** (seen by everyone on your face-down hand) and a **front** (paper, watermark, frame and ink on every card you play). Each table design lays that card back's motif across the felt.
- Items: Classic plum / Classic baize (free), Indigo 200, Rose 200, Jade 300, Chequer 350, Noir & silver 450, Basant kites 450, Paisley 500, Truck art 550, Night sky 600.
- **Rank rewards** (cannot be bought, unlock by peak rating): Silver line 1550, Gilded 1650, Royal seal 1850, Diamond 1900. Show a progress bar to the next unlock.
- Item states: **Buy** (price in coins), **Equip**, **Equipped** (gold check), **Locked** (with the requirement), Not enough coins.
- Item detail sheet: large preview of card back + a fanned front + the felt, and a live preview "how it looks at a table".
- Design the visual motifs: Truck art (bold Pakistani truck-art florals and borders), Basant kites (diamond kites over a spring sky), Paisley (fine boteh pattern), Night sky (stars and constellations), Chequer, Noir & silver, Jade, Rose, Indigo, and the metallic rank sets.

## 6. Component library

Design these as reusable components with variants:

- **Playing card:** sizes XS (seat stack), S (baari pile), M (hand), L (reveal/detail). Face (all 52; court cards with a refined, slightly ornamental style, not stock clip-art), back, selected, illegal/dimmed, face-down stack with count badge. Card-design skins applied to both faces.
- **Seat:** avatar, name, count, status chips, timer ring, finished medallion, away, disconnected, bot, host, speaking bubble, sound pop.
- **Buttons:** primary (gold on gold ink), secondary (plum glass), ghost, destructive (rose), icon button; sizes S/M/L; loading and disabled states.
- **Chips/badges:** Host, Ranked, Unranked, Public, Private, Guests, Bot, Watching, Away, rank tiers, coin amount, rating delta.
- **Inputs:** text, code input, handle with availability, stepper, slider with half-steps, segmented control, toggle.
- **Sheets and modals:** bottom sheet (half / full), confirm dialog, focused decision modal (hand request), drawer.
- **Feedback:** toast, banner (reconnecting, away, return to table), skeletons, empty-state illustrations (felt + a few cards), error state with retry.
- **Timer:** circular ring (seat) and linear bar (your turn), both draining from gold to ember in the last 5 seconds.
- **Lists:** player row, room row, leaderboard row, history row, friend row.
- **Icons:** a custom line icon set (1.5 pt stroke, rounded) plus four suit glyphs; no emoji.

## 7. Accessibility and ergonomics

- All primary actions sit in the bottom third (thumb zone). Nothing important under the notch or home indicator.
- Text contrast ≥ 4.5:1 on its background; red suits must also differ by glyph, never colour alone. Offer a **4-colour deck** option (blue diamonds, green clubs) in settings.
- Tap targets ≥ 44 × 44 pt. Every timer has a number, not only a ring. Support Dynamic Type up to 130% without breaking the table.
- Screen-reader labels for cards ("Queen of Hearts, legal") and state changes ("Ali gave Thulla. Sara collects 7 cards.").
- Reduced motion: no shake, no flying cards; use fades and position changes.

## 8. Motion spec (include timings)

| Moment | Duration | Easing |
| --- | --- | --- |
| Card select lift | 140 ms | spring `cubic-bezier(.34,1.4,.64,1)` |
| Card play to centre | 260 ms | ease-out `cubic-bezier(.2,.8,.2,1)` |
| Thulla slam + shake | 180 ms slam, 240 ms shake | `cubic-bezier(.75,0,.95,.45)` |
| Pile sweep to collector | 480 ms | ease-in-out `cubic-bezier(.65,0,.35,1)` |
| Deal, per card | 60–90 ms stagger | ease-out |
| Screen transitions | 260 ms | ease-out |

The baari pile stays visible for the host's "pile display" setting (default 3 s) before clearing or sweeping; the hand reveal lasts the "hand reveal" setting (default 5 s). Show those countdowns.

## 9. Data contracts the UI binds to

The backend is being moved to explicit API endpoints. Design each screen around these shapes; field names may be adjusted later but the data available will not change. The client never sends results, ratings or coins and never sees another player's hand (except during a hand reveal).

**REST (proposed)**

| Endpoint | Used by | Returns |
| --- | --- | --- |
| `POST /auth/register`, `POST /auth/signin`, `POST /auth/guest`, `POST /auth/forgot`, `POST /auth/reset` | Onboarding | session / guest identity |
| `GET /me` | Top bar, Play, Me | `{id, kind: user|guest, name, handle, avatar, coins, createdAt, currentTable?}` |
| `GET /games` | Play | `[{id, name, urdu, status: playable|workshop, tagline, players:{min,ideal}, duration, deck}]` |
| `GET /me/rating` | Play, Me | `{rating, peak, change30d, played, firsts, losses, winStreak, loseStreak}` |
| `GET /rooms` | Rooms, Play | `[{code, host:{name,avatar}, seats:{taken,max}, ranked, guests, spectators:{taken,max}, status, design}]` |
| `POST /tables` | Create table | `{code}` |
| `GET /leaderboard?scope=all|friends&page=` | Ranks | `[{rank, user:{name,handle,avatar}, rating, played, tier}]` |
| `GET /users/:handle` | Profiles | profile, rating, `ratingTrend[]`, `history[]` (20) |
| `GET /friends`, `POST /friends/request`, `POST /friends/:id/accept|decline|remove` | Friends | `[{id, name, handle, avatar, status: online|at-table|offline, state: accepted|pending-in|pending-out}]` |
| `GET /shop`, `POST /shop/buy`, `POST /shop/equip` | Shop | `{coins, peak, items:[{id, kind: table|cards, name, price?, minPeak?, owned, equipped, usable}]}` |
| `GET /sounds` | Sound board | `[{id, label}]` |

**Realtime (WebSocket) events**

- Client → server: `table:join | sync | leave | unwatch {code}`, `table:ready {ready}`, `table:settings`, `table:kick`, `table:start`, `table:invite {userIds}`, `game:action {play {card} | request | answer {accept} | back}`, `chat:send {text}`, sound/emote.
- Server → client: `table:state` (seats, readiness, host, settings, status) · `game:snapshot` (public view + only your hand) · `game:events` (`{seq, now, events[]}`: deal, play, thulla, collect, clear, request, answer, transfer-reveal, finish, away, timeout) · `game:hand` (your hand changed) · `game:deadline` · `table:result` (finishing order, stats, rating and coin changes) · `chat:msg` · `table:closed` · `table:kicked` · `invite`.
- Deadlines are absolute server times; the UI shows countdowns from them. If an event gap is detected the client re-syncs, so design a brief "Syncing…" state.

## 10. Deliverables

1. **Design system page:** colour tokens, type scale, spacing, radii, elevation, icon set, all components with variants.
2. **Screens** (390 × 844 portrait): every screen in section 5 with its default, loading, empty and error states.
3. **Game table frames:** 2, 4, 6, 8 and 9+ player layouts; every in-game moment in 5.6 as its own frame; a landscape table.
4. **Card art:** the full 52-card face set and the default back, plus a sheet showing every shop and rank design (back, front, felt).
5. **Prototype flow:** Welcome → guest name → Play → Create table → Lobby (invite, add bot) → Start → Deal → your turn → play → Thulla → collect → hand request → reveal → finish → Results → Play again.
6. **Motion notes** next to the frames that animate.

Quality bar: it should feel like a premium, handcrafted card room you'd be proud to show your family, readable at a glance mid-game, and calm until a Thulla lands.

---

## Short version (for tools with a character limit)

Design a dark, premium mobile card-game app called **Taash** for the Pakistani card game **Thulla** (ٹھلا), portrait 390×844. Mood: a lamp-lit card room at night: aubergine walls `#120e1f`, green baize table `#0f3a31`, ivory paper cards `#fbf6ea`, gold `#d6b06a` only for host, active turn and winner, ember `#f07a52` for "Thulla!" impacts. Fonts: Rozha One (display), Hanken Grotesk (UI), Libre Caslon (card indices). No casino or neon look, no light mode. Screens: welcome (guest / sign in / register), home with featured Thulla card and open rooms, join by six-character code `QAF-7R2`, create-table sheet (ranked, public, seats, turn timer), lobby with seat ring, invite and bots, the **game table** (opponent seats around an oval felt with face-down card counts and gold timer rings, centre baari pile with "Follow ♥" indicator, overlapping scrollable hand at the bottom with illegal cards dimmed, Play and Request hand buttons), Thulla slam moment, hand-request Give/Keep modal, hand reveal spotlight, results with finishing order, rating deltas and coins, friends, leaderboard with podium, profile with rating chart and history, and a shop of card and table designs (Truck art, Basant kites, Paisley, Night sky) plus rank rewards. Include loading, empty, error and reconnecting states, a component library, and 2/4/6/8-player table layouts. Thumb-friendly, 44 pt targets, high contrast.
