# Architecture and operation

## Ownership

GitHub Pages hosts React and static assets. The Worker serves credential forms and forwards requests to Supabase Auth. A two-minute one-time return code can be exchanged only with the original browser verifier. Encrypted session material in D1 is deleted on redemption or expiry cleanup. Protected requests verify identity using Supabase. Application roles are stored in D1.

A SQLite Durable Object owns each table's shuffle, shoe position, turn, bets and pending operations. It accepts a 30-second, single-use WebSocket ticket tied to the user, table and session. Dealer hole cards are represented as face-down markers in live and replay projections until reveal. The frontend receives sequenced projections and recovers gaps from an authoritative snapshot. Each table keeps a single alarm for its next deadline.

The first connected window controls a seat. A second window can watch or explicitly take over. Disconnected players retain their cards and turn deadlines. Between rounds, abandoned seats expire after two minutes. Socket leases last up to 12 minutes and are bounded by authentication expiry. Reconnecting obtains a fresh ticket.

## Game rules

- Each shuffle uses distinct card IDs and unbiased Fisher–Yates with cryptographic randomness. The shoe and its cursor remain private and survive restarts.
- Each chip has ten integer units. Wagers use whole chips. Blackjack payouts, surrender and insurance are stored exactly.
- American tables deal the dealer hole card face down. Early surrender happens before insurance and dealer peek. Late surrender is available as the first unsplit action following a non-blackjack peek. Split 21 is an ordinary 21.
- European tables draw the second dealer card after player decisions. **All wagers at risk** loses every non-natural wager against dealer blackjack. **Original bet only** returns extra stakes, including split and double stakes on busted hands, and charges the original stake once. Late surrender is conditional on the dealer having no natural. Early surrender retains its half return.
- Insurance stakes half the initial bet and returns the insurance stake plus 2:1 profit if the dealer has blackjack. A missed insurance or early surrender decision declines the option. A timed-out turn stands the active hand.
- A cut point or low card count triggers the next shuffle between rounds. If a shoe is exhausted mid-round, the server returns all funded wagers.
- Hosts can change rules or pause between hands. Closing before the deal refunds confirmed bets. A dealt round finishes normally before closure. New admission stops once closing begins.

## Wallet consistency and replay

D1 maintains one wallet per user and one immutable ledger. A guarded insert and SQLite trigger debit only when sufficient units remain. Changes spanning D1 and the table are recorded as durable intents before D1 is written. A rejected reserve records a receipt without committing the successor state. After a crash, retrying the same operation IDs cannot produce duplicate debits, payouts or round records.

Payouts, replay frames, hands and statistics are committed in the same D1 batch. An alarm retries pending operations with bounded backoff. Wallet-changing commands wait while reconciliation is pending.

The replay player uses completed, redacted frames and provides play, pause, next event, restart and speed controls. Replays are accessible to players in that round and retained for 90 days. Table chat is limited to the latest 60 messages and one hour. Moderation reports retain the reported excerpt as evidence. Ledger entries remain available for balance auditing.

## Inactivity and capacity

Accepted gameplay, the first seat or readiness change by a player in a round or lobby, and authorized administrative changes refresh inactivity. Presence, browser traffic, messages, reactions and passive timeouts do not. At 25 and 29 minutes the table issues warnings. At 30 minutes it closes and resolves outstanding commitments. If D1 is unavailable, the closing table keeps its recovery data until settlement and cleanup succeed.

Default limits are seven seats, 24 extra connection slots, three sockets per user and eight simultaneous tables per administrator. The application renders visuals locally. Reduced motion skips effects and hidden tabs pause nonessential motion and sound. Friend presence is sampled on demand in shared tables. Blocking removes social links and targeted invitations. The separate mute and moderation controls manage table chat.

Engineering targets include landing JS below 105 KiB gzip, artwork below 110 KiB total, a typical seven-seat projection below 16 KiB, and Worker CPU inside the Free tier limit. Local load tests measure application operations and timing. Use the Cloudflare dashboard for billed edge CPU, usage and index writes.
