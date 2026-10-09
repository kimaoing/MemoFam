DROP INDEX IF EXISTS one_difficulty_per_character_family;

CREATE TABLE group_boss_parties (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  boss_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (group_id, boss_id, id)
);

INSERT INTO group_boss_parties (id, group_id, boss_id, family_id, created_at)
SELECT group_id || ':' || boss_id, group_id, boss_id, family_id, MIN(joined_at)
FROM group_boss_participants
GROUP BY group_id, boss_id, family_id;

ALTER TABLE group_boss_participants RENAME TO group_boss_participants_v0006;

CREATE TABLE group_boss_participants (
  party_id TEXT NOT NULL REFERENCES group_boss_parties(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  nickname TEXT NOT NULL COLLATE NOCASE,
  family_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (party_id, google_sub, nickname),
  UNIQUE (group_id, google_sub, nickname, family_id),
  FOREIGN KEY (group_id, google_sub, nickname)
    REFERENCES group_characters(group_id, google_sub, nickname) ON DELETE CASCADE
);

INSERT INTO group_boss_participants (party_id, group_id, google_sub, nickname, family_id, joined_at)
SELECT old.group_id || ':' || old.boss_id, old.group_id, old.google_sub,
  old.nickname, old.family_id, old.joined_at
FROM group_boss_participants_v0006 AS old;

DROP TABLE group_boss_participants_v0006;

CREATE INDEX group_boss_participants_by_party ON group_boss_participants(party_id);
CREATE INDEX group_boss_participants_by_character
  ON group_boss_participants(group_id, google_sub, nickname COLLATE NOCASE);
CREATE UNIQUE INDEX one_difficulty_per_character_family
  ON group_boss_participants(group_id, google_sub, nickname, family_id);
