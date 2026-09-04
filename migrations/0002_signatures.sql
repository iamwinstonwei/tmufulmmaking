CREATE TABLE IF NOT EXISTS signatures (
  request_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('checkout', 'return')),
  provider_ref TEXT NOT NULL UNIQUE,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (request_id, stage),
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);
