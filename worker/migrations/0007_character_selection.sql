CREATE TABLE character_preferences (
  google_sub TEXT PRIMARY KEY,
  active_character_ocids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);