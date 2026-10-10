CREATE TABLE group_character_exclusions (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL,
  ocid TEXT NOT NULL,
  excluded_at TEXT NOT NULL,
  PRIMARY KEY (group_id, google_sub, ocid)
);

CREATE INDEX group_character_exclusions_by_owner
  ON group_character_exclusions(group_id, google_sub);
