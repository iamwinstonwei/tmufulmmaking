CREATE TABLE IF NOT EXISTS daily_counters (
  day TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('上傳中', '待確認', '部分歸還', '已歸還')),
  borrower_name TEXT NOT NULL,
  student_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  loan_start TEXT NOT NULL,
  expected_return TEXT NOT NULL,
  return_code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  returned_at TEXT
);

CREATE TABLE IF NOT EXISTS request_items (
  request_id TEXT NOT NULL,
  equipment_code TEXT NOT NULL,
  equipment_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0 AND quantity <= 30),
  returned_quantity INTEGER NOT NULL DEFAULT 0 CHECK(returned_quantity >= 0),
  PRIMARY KEY (request_id, equipment_code),
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  session_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('checkout', 'return')),
  allowed_codes_json TEXT NOT NULL,
  expected_photo_count INTEGER NOT NULL CHECK(expected_photo_count > 0 AND expected_photo_count <= 60),
  expires_at INTEGER NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);

CREATE TABLE IF NOT EXISTS photos (
  request_id TEXT NOT NULL,
  equipment_code TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('checkout', 'return')),
  photo_index INTEGER NOT NULL CHECK(photo_index > 0 AND photo_index <= 30),
  provider_ref TEXT NOT NULL UNIQUE,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (request_id, equipment_code, stage, photo_index),
  FOREIGN KEY (request_id) REFERENCES requests(request_id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_name ON requests(borrower_name, status);
CREATE INDEX IF NOT EXISTS idx_photos_request_stage ON photos(request_id, stage);
