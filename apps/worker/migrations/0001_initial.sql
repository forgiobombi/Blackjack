CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT 'spade',
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin','superadmin')),
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  private_stats INTEGER NOT NULL DEFAULT 0 CHECK (private_stats IN (0,1)),
  preferences TEXT NOT NULL CHECK (json_valid(preferences)),
  created_at INTEGER NOT NULL
);
CREATE TABLE system_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  starting_chips INTEGER NOT NULL DEFAULT 10000 CHECK (starting_chips BETWEEN 100 AND 100000),
  refill_chips INTEGER NOT NULL DEFAULT 1000 CHECK (refill_chips BETWEEN 100 AND 10000),
  refill_below INTEGER NOT NULL DEFAULT 100 CHECK (refill_below BETWEEN 0 AND 10000),
  refill_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (refill_minutes BETWEEN 60 AND 10080),
  table_defaults TEXT CHECK (table_defaults IS NULL OR json_valid(table_defaults))
);
INSERT INTO system_settings (id) VALUES (1);
CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY REFERENCES profiles(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (typeof(balance) = 'integer' AND balance BETWEEN 0 AND 1000000000000),
  last_refill INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES wallets(user_id),
  table_id TEXT,
  round_id TEXT,
  delta INTEGER NOT NULL CHECK (typeof(delta) = 'integer'),
  kind TEXT NOT NULL CHECK (kind IN ('initial','bet','double','split','insurance','clear','settlement','refund','refill','adjustment')),
  created_at INTEGER NOT NULL
);
CREATE INDEX ledger_owner_idx ON wallet_ledger(user_id, created_at DESC);
CREATE TRIGGER apply_ledger AFTER INSERT ON wallet_ledger BEGIN
  UPDATE wallets
  SET balance = balance + NEW.delta, last_refill = CASE WHEN NEW.kind = 'refill' THEN NEW.created_at ELSE last_refill END
  WHERE user_id = NEW.user_id;
END;

CREATE TABLE auth_transfers (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX auth_transfer_expiry ON auth_transfers(expires_at);
CREATE TABLE revoked_sessions (
  id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
);
CREATE INDEX revoked_session_expiry ON revoked_sessions(expires_at);

CREATE TABLE game_tables (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES profiles(id),
  settings TEXT NOT NULL CHECK (json_valid(settings)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','closed')),
  private INTEGER NOT NULL CHECK (private IN (0,1)),
  join_enabled INTEGER NOT NULL DEFAULT 1 CHECK (join_enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT
);
CREATE INDEX tables_browse_idx ON game_tables(status, private, created_at DESC);
CREATE INDEX tables_owner_idx ON game_tables(owner_id, status, created_at DESC);

CREATE TABLE table_invites (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES game_tables(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES profiles(id),
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  recipient_id TEXT REFERENCES profiles(id),
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 32),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses BETWEEN 0 AND max_uses),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX invites_table_idx ON table_invites(table_id, created_at DESC);
CREATE INDEX invites_expiry_idx ON table_invites(expires_at);
CREATE TABLE friend_invites (
  id TEXT PRIMARY KEY REFERENCES table_invites(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES profiles(id),
  secret TEXT NOT NULL
);
CREATE INDEX friend_invites_recipient_idx ON friend_invites(recipient_id);
CREATE TABLE table_memberships (
  table_id TEXT NOT NULL REFERENCES game_tables(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  joined_at INTEGER NOT NULL,
  sponsor TEXT REFERENCES table_invites(id) ON DELETE SET NULL,
  PRIMARY KEY(table_id,user_id)
);
CREATE INDEX table_memberships_user_idx ON table_memberships(user_id, joined_at DESC);
CREATE TRIGGER count_invite_uses AFTER INSERT ON table_memberships WHEN NEW.sponsor IS NOT NULL BEGIN
  UPDATE table_invites SET uses = uses + 1 WHERE id = NEW.sponsor;
END;
CREATE TABLE table_restrictions (
  table_id TEXT NOT NULL REFERENCES game_tables(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0,1)),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1)),
  PRIMARY KEY (table_id,user_id)
);

CREATE TABLE replays (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES game_tables(id),
  table_name TEXT NOT NULL,
  settings TEXT NOT NULL CHECK (json_valid(settings)),
  dealer TEXT NOT NULL CHECK (json_valid(dealer)),
  frames TEXT NOT NULL CHECK (json_valid(frames)),
  finished_at INTEGER NOT NULL
);
CREATE INDEX replay_time_idx ON replays(finished_at);
CREATE TABLE round_history (
  round_id TEXT NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  finished_at INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('win','loss','push','refund')),
  hands TEXT NOT NULL CHECK (json_valid(hands)),
  blackjacks INTEGER NOT NULL,
  double_wins INTEGER NOT NULL,
  split_wins INTEGER NOT NULL,
  social INTEGER NOT NULL,
  PRIMARY KEY(round_id,user_id)
);
CREATE INDEX history_user_idx ON round_history(user_id, finished_at DESC);
CREATE TABLE statistics (
  user_id TEXT PRIMARY KEY REFERENCES profiles(id),
  rounds INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL, pushes INTEGER NOT NULL,
  blackjacks INTEGER NOT NULL, streak INTEGER NOT NULL, longest INTEGER NOT NULL,
  double_wins INTEGER NOT NULL, split_wins INTEGER NOT NULL, social INTEGER NOT NULL
);
CREATE INDEX stats_rounds_idx ON statistics(rounds DESC);
CREATE INDEX stats_blackjacks_idx ON statistics(blackjacks DESC);
CREATE INDEX stats_streak_idx ON statistics(longest DESC);
CREATE INDEX stats_wins_idx ON statistics((1.0 * wins / rounds) DESC) WHERE rounds >= 10;
CREATE TRIGGER add_round_stats AFTER INSERT ON round_history WHEN NEW.outcome != 'refund' BEGIN
  INSERT INTO statistics(user_id, rounds, wins, losses, pushes, blackjacks, streak, longest, double_wins, split_wins, social)
  VALUES(NEW.user_id, 1, NEW.outcome='win', NEW.outcome='loss', NEW.outcome='push',
         NEW.blackjacks, NEW.outcome='win', NEW.outcome='win', NEW.double_wins, NEW.split_wins, NEW.social)
  ON CONFLICT(user_id) DO UPDATE SET
    rounds = rounds + 1, wins = wins + excluded.wins, losses = losses + excluded.losses,
    pushes = pushes + excluded.pushes, blackjacks = blackjacks + excluded.blackjacks,
    longest = max(longest, (streak + 1) * excluded.wins), streak = (streak + 1) * excluded.wins,
    double_wins = double_wins + excluded.double_wins, split_wins = split_wins + excluded.split_wins,
    social = social + excluded.social;
END;

CREATE TABLE relationships (
  low_id TEXT NOT NULL REFERENCES profiles(id),
  high_id TEXT NOT NULL REFERENCES profiles(id),
  requested_by TEXT NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL CHECK (status IN ('requested','friends')),
  updated_at INTEGER NOT NULL,
  CHECK (low_id < high_id AND requested_by IN (low_id, high_id)),
  PRIMARY KEY(low_id,high_id)
);
CREATE INDEX relationships_high_idx ON relationships(high_id,status);
CREATE TABLE blocks (
  actor_id TEXT NOT NULL REFERENCES profiles(id),
  target_id TEXT NOT NULL REFERENCES profiles(id),
  PRIMARY KEY(actor_id,target_id)
);
CREATE TABLE user_reports (
  id TEXT PRIMARY KEY,
  reporter TEXT NOT NULL REFERENCES profiles(id),
  target TEXT NOT NULL REFERENCES profiles(id),
  table_id TEXT NOT NULL REFERENCES game_tables(id),
  message_id TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed')),
  created_at INTEGER NOT NULL,
  UNIQUE(reporter,table_id,message_id)
);
CREATE INDEX open_reports_idx ON user_reports(status,created_at DESC);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES profiles(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_time_idx ON audit_logs(created_at DESC);
