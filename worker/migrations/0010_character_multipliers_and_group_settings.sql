CREATE TABLE legacy_group_multipliers (
  group_id TEXT NOT NULL,
  nickname TEXT NOT NULL COLLATE NOCASE,
  boss_id TEXT NOT NULL,
  multiplier REAL NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (group_id, nickname, boss_id)
);

INSERT INTO legacy_group_multipliers (group_id, nickname, boss_id, multiplier, updated_at, updated_by)
SELECT group_id, nickname, boss_id, multiplier, updated_at, updated_by FROM multipliers;

DROP TABLE multipliers;

CREATE TABLE character_multipliers (
  google_sub TEXT NOT NULL,
  nickname TEXT NOT NULL COLLATE NOCASE,
  boss_id TEXT NOT NULL,
  multiplier REAL NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (google_sub, nickname, boss_id),
  FOREIGN KEY (google_sub, nickname) REFERENCES characters(google_sub, nickname) ON DELETE CASCADE
);

CREATE INDEX character_multipliers_by_character
  ON character_multipliers(google_sub, nickname COLLATE NOCASE);

WITH ranked_multipliers AS (
  SELECT candidates.google_sub, candidates.nickname, candidates.boss_id,
    candidates.multiplier, candidates.updated_at, candidates.updated_by,
    ROW_NUMBER() OVER (
      PARTITION BY candidates.google_sub, candidates.nickname, candidates.boss_id
      ORDER BY candidates.updated_at DESC, candidates.group_id ASC
    ) AS row_number
  FROM (
    SELECT gc.google_sub, gc.nickname, m.boss_id, m.multiplier, m.updated_at, m.updated_by, m.group_id
    FROM legacy_group_multipliers m
    JOIN group_characters gc
      ON gc.group_id = m.group_id AND lower(gc.nickname) = lower(m.nickname)
    UNION ALL
    SELECT c.google_sub, c.nickname, m.boss_id, m.multiplier, m.updated_at, m.updated_by, m.group_id
    FROM legacy_group_multipliers m
    JOIN group_members gm ON gm.group_id = m.group_id
    JOIN auth_sessions s ON lower(s.email) = lower(gm.email)
    JOIN characters c ON c.google_sub = s.google_sub AND lower(c.nickname) = lower(m.nickname)
  ) candidates
)
INSERT INTO character_multipliers (google_sub, nickname, boss_id, multiplier, updated_at, updated_by)
SELECT google_sub, nickname, boss_id, multiplier, updated_at, updated_by
FROM ranked_multipliers
WHERE row_number = 1;

ALTER TABLE groups ADD COLUMN main_image_boss_id TEXT;
