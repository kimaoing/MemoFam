CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  remember INTEGER NOT NULL CHECK (remember IN (0, 1))
);

CREATE INDEX auth_sessions_by_google_sub
  ON auth_sessions(google_sub, created_at DESC);

CREATE INDEX auth_sessions_by_expiry
  ON auth_sessions(expires_at);
