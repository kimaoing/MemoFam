CREATE TABLE user_profiles (
  google_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_user_profiles_email ON user_profiles (email);
