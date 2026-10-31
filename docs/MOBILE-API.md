# Mobile API

The React Native app in `../taash-app` uses this same process and database. It talks to `/api/mobile/*` over HTTP for everything durable (accounts, friends, history, shop) and to Socket.IO for live tables, exactly like the browser.

The routes are declared in one table in [`lib/mobile/router.js`](../lib/mobile/router.js). Handlers are grouped by area in `lib/mobile/` (`auth.js`, `account.js`, `social.js`, `play.js`) and call the same platform functions the web pages and server actions use. Tests are in [`tests/integration/mobile-api.test.js`](../tests/integration/mobile-api.test.js).

## Conventions

- **Auth.** Every session endpoint returns `{ token, expiresAt, viewer }`. Send `Authorization: Bearer <token>` on HTTP requests and `auth: { token }` in the Socket.IO handshake. Tokens are HMAC-signed with `AUTH_SECRET`, last 30 days, and are checked against the account's `sessionVersion`. That means a password change, a password reset, sign-out-everywhere and account deletion revoke every browser and phone session together. Call `auth/refresh` when `expiresAt` is near. Browser cookies are never accepted here.
- **Who is calling** comes only from the token. IDs in bodies (`userId`, request `id`) are targets, never the actor.
- **Bodies** are JSON objects, at most 16 KB. `GET` takes query strings.
- **Errors** are `{ error, code?, field? }` with an HTTP status. `error` is a sentence you can show the user. `field` names the form input it belongs to. `code` is stable and machine-readable:

  | Status | `code` | Meaning |
  | --- | --- | --- |
  | 400 | `invalid` | Input failed validation (`field` says which) |
  | 400 | `credentials` | Wrong current password |
  | 400 | `expired` | Reset link expired or already used |
  | 401 | `auth` | No valid session: sign in again |
  | 401 | `credentials` | Sign-in details don't match |
  | 403 | `account-required` | Guests can't use this; offer sign-up |
  | 403 | `origin` | Browser origin not allowed |
  | 404 | `not-found` | Unknown route, player or table |
  | 405 | `method` | Wrong HTTP method |
  | 409 | `taken` | Email or username already in use (`field`) |
  | 409 | `in-game` | Finish or forfeit the game first (`table`) |
  | 413 | — | Body too large |
  | 429 | `rate` | Slow down |

- **Access levels** in the tables below: *any* works signed out (a valid token personalises the answer), *session* needs a guest or an account, *user* needs an account.
- **Origins.** Native apps send no `Origin`. Browser origins must be `APP_URL` or listed in `MOBILE_WEB_ORIGINS` (comma-separated). In development, `http://localhost:8081` and `http://127.0.0.1:8081` (Expo web) are allowed.

## Endpoints

### App and game data

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| GET | `config` | any | `api` (version, currently 2), `minAppVersion`, `serverTime`, `appUrl`, `games`, `settings.thulla.{defaults,limits}`, `tableOptions.{defaults,spectatorsMax,chatMax}`, `bots.thulla[]`, `cosmetics.{kinds,defaults,tiers}`, `sounds`, `features.{push,accountDeletion}`. Load once per launch instead of hard-coding these. |
| GET | `home` | any | `board` (top 4; friends board when signed in), `recent`, `games`, `rooms`, `activeTable`, `rating`, `change`, `friendsOnline[]`, `friendTables[]` |
| GET | `rooms` | any | `rooms[]`: public tables with a free seat or room to watch |
| GET | `tables/:code` | any | `table`: a preview before joining (see below). 404 if no such table. Code may be `ABC-123` or `abc123`. |
| GET | `catalog` | any | `items`, `tiers` (all cosmetics) |
| GET | `sounds` | any | `sounds[]` `{id, label, url}` (URLs relative to the server) |

`tables/:code` → `table`: `code, gameId, status ('lobby'|'playing'|…), settings, options, gamesPlayed, host {name, handle, guest}, players[] {name, handle, guest, bot, isHost}, seated, seats, watching, you ('player'|'spectator'|null), canSit, canWatch, reason`. `reason` is null or one of `no-guests`, `elsewhere` (the caller is at another table), `in-progress`, `full`. Joining still goes through the `table:join` socket event, which enforces the same rules.

### Sessions

| Method | Path | Access | Body → result |
| --- | --- | --- | --- |
| POST | `auth/guest` | any | `{name}` → session. Sending an existing guest token keeps the same identity (and table seat) under the new name. |
| POST | `auth/register` | any | `{name, handle, email, password, confirm?}` → session. 409 `taken` with `field: 'email'` or `'handle'`. |
| POST | `auth/signin` | any | `{login, password}` → session. `login` is an email, a username or `@username`. |
| POST | `auth/refresh` | session | `{}` → a new session for the same identity. 401 if the session was revoked. |
| POST | `auth/signout` | any | `{pushToken?}` → `{ok}`. Tokens are stateless, so this only stops push notifications to this phone; then delete the token locally. |
| POST | `auth/forgot` | any | `{login}` → `{ok, message}`. Same answer whether or not the account exists. The email links to `APP_URL/reset?token=…`, which the app opens through its reset deep link. |
| POST | `auth/reset` | any | `{token, password, confirm}` → `{ok}`. Revokes every existing session and push device. |
| GET | `auth/handle?handle=` | any | `{available, handle}`. Your own username counts as available. |
| GET | `me` | session | `viewer, activeTable, table, rooms`; for accounts also `user` (includes email), `rating, change, trend, history, cosmetics, relations, friendsCount` |

`viewer` is `{kind: 'user'|'guest', playerId, userId, name, handle, guest}`. `playerId` is the ID used at tables (`u:<userId>` or `g:<guestId>`).

### Account (user)

| Method | Path | Body → result |
| --- | --- | --- |
| POST | `profile` | `{name?, handle?}` (at least one) → `{ok, viewer}`. Open sockets pick up the new name straight away. |
| POST | `password` | `{current, next}` → `{ok, token, expiresAt, viewer}`. Other devices are signed out and every registered push device is removed. **Store the returned token** (the old one no longer works), then register this phone's push token again. |
| POST | `logout-everywhere` | `{keepThisDevice?}` → `{ok}`, plus a fresh session when `keepThisDevice` is true. Removes every registered push device. |
| POST | `account/delete` | `{password}` → `{ok}`. Permanent. 409 `in-game` while seated in a game in progress. Leaves any lobby, closes the user's sockets, deletes friendships, ratings, wallet, purchases and devices. Past games stay in other players' histories under "Former player". Required for App Store and Play Store apps that allow sign-up. |
| GET | `wallet` | `{coins, earned, events[] {id, amount, reason ('match'|'purchase'), matchId, itemId, itemName, at}}` (latest 50) |
| POST | `devices` | `{token, platform: 'ios'|'android', appVersion?}` → `{ok}`. Register an Expo push token after sign-in and whenever it changes. A token moves to whoever registered it last; each account keeps at most 10 devices. |
| POST | `devices/remove` | `{token}` → `{ok}` |

### Players, friends and leaderboards

| Method | Path | Access | Body / query → result |
| --- | --- | --- | --- |
| GET | `players/search?q=` | any | `players[] {id, name, handle, rating, online, relation}`. At least 2 characters; matches usernames by prefix and display names anywhere; at most 20; never includes the caller. |
| GET | `players/:handle` | any | `user {id, name, handle, createdAt, online}, rating, change, trend, history (20), hasMoreHistory, relation`. No email. |
| GET | `players/:handle/history?page=` | any | `{history, page, pageSize: 20, hasMore}`. Page 0 is the same as the profile's `history`. |
| GET | `leaderboard?scope=all\|friends&sort=rating\|firsts&page=` | any | `{rows[] {rank, id, name, handle, rating, firsts, played, losses, online, relation}, page, pageSize: 50, hasMore, tiers}`. The friends scope needs an account; it is empty for guests. |
| GET | `friends` | user | `{friends[] (+online), incoming[], outgoing[], tables[]}`. `tables` are friends' open lobbies. |
| POST | `friends/add` | user | `{handle}` → `{ok, status: 'pending'|'accepted', name, requestId, message}`. Adding someone who already asked you accepts their request. |
| POST | `friends/respond` | user | `{id, accept}` → `{ok}` |
| POST | `friends/cancel` | user | `{id}` → `{ok}` |
| POST | `friends/remove` | user | `{userId}` → `{ok}` |

`relation` is `self`, `friend`, `sent`, `received` or `none`, from the caller's point of view (`none` for guests and signed-out callers).

### Shop (user)

| Method | Path | Body → result |
| --- | --- | --- |
| GET | `shop` | `{items, tiers, coins, earned, owned[], peak, equipped {table, cards}}` |
| POST | `shop/buy` | `{itemId}` → `{ok, coins}` |
| POST | `shop/equip` | `{itemId}` → `{ok, coins, earned, owned, peak, equipped}` (the updated state) |

## Push notifications

When something happens to a signed-in player **who has no open connection** (no app socket and no browser tab), the server sends an Expo push to each registered device:

| `data.type` | When | Other `data` |
| --- | --- | --- |
| `friend:request` | Someone sends a request | `id` (request), `handle` |
| `friend:accepted` | Someone accepts yours | `handle` |
| `invite` | A friend invites you to a table (expires after 15 minutes) | `code`, `gameId`, `url` |

When the app is in the foreground, the same events arrive over the socket instead. So the app should disconnect its socket when it goes to the background; otherwise pushes are held back until the OS suspends the app. Tokens Expo reports as `DeviceNotRegistered` are removed automatically. Environment variables: `PUSH_NOTIFICATIONS=off` disables pushes; `EXPO_ACCESS_TOKEN` is needed only if the Expo project enforces push security.

## Realtime (Socket.IO)

Path `/socket.io`, WebSocket transport, handshake `auth: { token }`. The server first emits `session` `{kind, playerId, name}` (`kind: 'anon'` means the token was missing or invalid). Requests use acknowledgements and answer `{ok, …}` or `{error, code?}`. The protocol is shared with the browser and described in `ARCHITECTURE.md`. In summary:

- **Client → server:** `table:create {gameId, settings, options}`, `table:join {code, as?}`, `table:sync {code}`, `table:unwatch {code}`, `table:leave`, `table:ready {ready}`, `table:settings {settings?, options?}`, `table:addBot {botId?}`, `table:kick {playerId}`, `table:move {playerId, to}`, `table:start`, `table:lobby`, `table:forfeit`, `table:emote {sound}`, `table:invite {userIds}`, `game:action {actionId, action}`, `chat:send {text}`, `me:table`. Every table event also carries `code`.
- **Server → client:** `table:state`, `table:lobby`, `table:result`, `table:closed`, `table:kicked`, `table:moved`, `table:forfeit`, `table:emote`, `game:snapshot`, `game:events`, `game:hand` (only your own hand), `game:deadline`, `chat:msg`, `invite`, `friend:request`, `friend:accepted`.

## Deployment

Migration `0004_push_devices` adds the `push_devices` table. `npm run db:migrate` applies it, as on every deploy. Nothing else in the deployment changes: same process, same port, same `AUTH_SECRET`.

HTTPS app association endpoints are `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. Configure `IOS_APP_ID` (Apple team ID + bundle ID), `ANDROID_CERT_SHA256` (comma-separated release certificate fingerprints), and optionally `ANDROID_APP_PACKAGE` (default `com.nezden.taash`). Without signing values they return empty associations.

Integration tests need `--conditions=react-server` (already in `npm run test:integration`) so that `server-only` modules load outside Next.
