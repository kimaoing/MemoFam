CREATE TABLE group_characters (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL,
  owner_email TEXT NOT NULL COLLATE NOCASE,
  nickname TEXT NOT NULL COLLATE NOCASE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, google_sub, nickname),
  FOREIGN KEY (google_sub, nickname) REFERENCES characters(google_sub, nickname) ON DELETE CASCADE
);

CREATE INDEX group_characters_by_owner ON group_characters(group_id, google_sub);

CREATE TABLE group_boss_participants (
  group_id TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  nickname TEXT NOT NULL COLLATE NOCASE,
  boss_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, google_sub, nickname, boss_id),
  FOREIGN KEY (group_id, google_sub, nickname)
    REFERENCES group_characters(group_id, google_sub, nickname) ON DELETE CASCADE
);

CREATE UNIQUE INDEX one_difficulty_per_character_family
  ON group_boss_participants(group_id, google_sub, nickname, family_id);

CREATE TABLE group_invites (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX group_invites_by_group ON group_invites(group_id, expires_at);
