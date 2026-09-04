const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 512 * 1024;
const MAX_ITEMS = 30;
const MAX_PHOTOS = 60;
const UPLOAD_TTL_MS = 12 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const requestOrigin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return corsPreflight_(requestOrigin, env);
    try {
      if (!isAllowedOrigin_(requestOrigin, env)) throw httpError_(403, '不允許此網站呼叫資料服務。');
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/health') return json_({ ok: true }, requestOrigin, env);
      if (request.method === 'GET' && url.pathname === '/api/inventory') return inventoryResponse_(requestOrigin, env);
      if (request.method !== 'POST') throw httpError_(405, '不支援此操作。');
      if (url.pathname === '/api/loan/start') return json_(await startLoan_(request, env), requestOrigin, env);
      if (url.pathname === '/api/loan/finalize') return json_(await finalizeLoan_(request, env, ctx), requestOrigin, env);
      if (url.pathname === '/api/return/lookup') return json_(await lookupReturn_(request, env), requestOrigin, env);
      if (url.pathname === '/api/return/start') return json_(await startReturn_(request, env), requestOrigin, env);
      if (url.pathname === '/api/return/finalize') return json_(await finalizeReturn_(request, env), requestOrigin, env);
      if (url.pathname === '/api/manage/search') return json_(await managerSearch_(request, env), requestOrigin, env);
      if (url.pathname === '/api/upload') return json_(await uploadPhoto_(request, env), requestOrigin, env);
      if (url.pathname === '/api/signature') return json_(await uploadSignature_(request, env), requestOrigin, env);
      if (url.pathname === '/api/assets') return json_(await uploadAssets_(request, env), requestOrigin, env);
      throw httpError_(404, '找不到服務。');
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error(error?.stack || error);
      return json_({ ok: false, message: status >= 500 ? '系統暫時無法處理，請稍後再試。' : String(error?.message || '操作失敗。') }, requestOrigin, env, status);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(drainEmailOutbox_(env));
  }
};

async function inventoryResponse_(origin, env) {
  const cache = caches.default;
  const cacheKey = new Request('https://tmu-internal-cache.invalid/inventory-v1');
  const cached = await cache.match(cacheKey);
  if (cached) return withCors_(cached, origin, env);

  const response = await callPrivateGas_(env, { action: 'internalGetInventory' });
  require_(Array.isArray(response.rows) && response.rows.length > 1 && response.rows.length <= 1000, 502, '器材清單服務回傳異常。');
  const rows = response.rows.map(row => {
    require_(Array.isArray(row) && row.length <= 40, 502, '器材清單欄位異常。');
    return row.map(value => String(value ?? '').slice(0, 500));
  });
  const stored = new Response(JSON.stringify({ ok: true, rows }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
  });
  await cache.put(cacheKey, stored.clone());
  return withCors_(stored, origin, env);
}

function withCors_(response, origin, env) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders_(origin, env)).forEach(([name, value]) => headers.set(name, value));
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(response.body, { status: response.status, headers });
}

async function startLoan_(request, env) {
  const data = await readJson_(request);
  await assertTurnstile_(data.turnstileToken, 'loan-request', request, env);
  const borrower = validateBorrower_(data.borrower);
  const loan = validateLoan_(data.loan);
  const items = validateItems_(data.items);
  // Read the completion quota before creating a request or uploading any files.
  // Finalization still checks atomically: concurrent tabs can consume quota later.
  await checkLoanCompletionQuota_(env, borrower.email, clientIp_(request));
  // 開始上傳可能因手機斷線、照片處理或雲端短暫錯誤而重試，
  // 因此這裡只做較寬鬆的「開始」限制；嚴格的申請額度改在真正完成時計算。
  await rateLimit_(env, `loan-start:${await digest_(borrower.email.toLowerCase())}`, 10, 60 * 60 * 1000);
  await rateLimit_(env, `ip-start:${clientIp_(request)}`, 20, 60 * 60 * 1000);

  const requestId = await nextRequestId_(env.DB);
  const returnCode = randomHex_(12);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO requests
      (request_id,status,borrower_name,student_id,phone,email,loan_start,expected_return,return_code_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(requestId, '上傳中', borrower.name, borrower.studentId, borrower.phone, borrower.email, loan.start, loan.expectedReturn, await returnCodeHash_(returnCode, env), now),
    ...items.map(item => env.DB.prepare('INSERT INTO request_items (request_id,equipment_code,equipment_name,quantity) VALUES (?,?,?,?)')
      .bind(requestId, item.code, item.name, item.quantity))
  ]);
  const session = await createUploadSession_(env, requestId, 'checkout', items, { returnCode });
  return { ok: true, requestId, returnCode, uploadToken: session.token, expectedPhotoCount: session.expectedPhotoCount };
}

async function finalizeLoan_(request, env, ctx) {
  const data = await readJson_(request);
  const ticket = await requireUploadTicket_(data.uploadToken, env, 'checkout');
  await requirePhotoCount_(env.DB, ticket.requestId, 'checkout', ticket.expectedPhotoCount);
  await requireSignature_(env.DB, ticket.requestId, 'checkout');
  const record = await env.DB.prepare('SELECT borrower_name,email,loan_start,expected_return,status FROM requests WHERE request_id=?').bind(ticket.requestId).first();
  if (!record || record.status !== '上傳中') throw httpError_(409, '這筆申請已完成或已失效。');
  await rateLimit_(env, `loan-complete:${await digest_(String(record.email).toLowerCase())}`, 3, 60 * 60 * 1000);
  await rateLimit_(env, `ip-complete:${clientIp_(request)}`, 8, 60 * 60 * 1000);
  const items = await env.DB.prepare('SELECT equipment_name,quantity FROM request_items WHERE request_id=?').bind(ticket.requestId).all();
  const finalizedAt = new Date().toISOString();
  const payload = await encryptEmailJob_(env, { record, returnCode: ticket.returnCode, items: items.results || [] });
  await env.DB.batch([
    env.DB.prepare("UPDATE requests SET status='待確認', finalized_at=? WHERE request_id=?").bind(finalizedAt, ticket.requestId),
    env.DB.prepare('UPDATE upload_sessions SET consumed_at=? WHERE session_id=?').bind(finalizedAt, ticket.sessionId),
    env.DB.prepare('INSERT INTO email_outbox (request_id,payload,next_attempt_at) VALUES (?,?,0)').bind(ticket.requestId, payload)
  ]);
  ctx.waitUntil(deliverEmailJob_(env, ticket.requestId));
  return { ok: true, requestId: ticket.requestId, returnCode: ticket.returnCode, emailQueued: true, emailSent: false, message: '申請已送出，確認信正在背景寄送。請記下借用編號與歸還驗證碼。' };
}

async function lookupReturn_(request, env) {
  const data = await readJson_(request);
  const requestId = validateRequestId_(data.requestId);
  const isAdmin = await hasAdminAccess_(request, env);
  if (!isAdmin) {
    await rateLimit_(env, `lookup:${clientIp_(request)}:${requestId}`, 8, 10 * 60 * 1000);
    await requireReturnCode_(env, requestId, data.returnCode);
  }
  const rows = await env.DB.prepare('SELECT equipment_code AS code,equipment_name AS name,quantity,returned_quantity FROM request_items WHERE request_id=? ORDER BY equipment_name').bind(requestId).all();
  if (!rows.results?.length) throw httpError_(404, '找不到符合的借用紀錄。');
  return { ok: true, requestId, items: rows.results.map(row => ({ ...row, returned: Number(row.returned_quantity) >= Number(row.quantity) })) };
}

async function startReturn_(request, env) {
  const data = await readJson_(request);
  const requestId = validateRequestId_(data.requestId);
  const isAdmin = await hasAdminAccess_(request, env);
  if (!isAdmin) {
    await assertTurnstile_(data.turnstileToken, 'equipment-return', request, env);
    await rateLimit_(env, `return:${clientIp_(request)}:${requestId}`, 5, 30 * 60 * 1000);
    await requireReturnCode_(env, requestId, data.returnCode);
  }
  const outstanding = await env.DB.prepare('SELECT equipment_code AS code,equipment_name AS name,quantity,returned_quantity FROM request_items WHERE request_id=? AND returned_quantity < quantity').bind(requestId).all();
  if (!outstanding.results?.length) throw httpError_(409, '這筆申請沒有待歸還的器材。');
  const items = outstanding.results.map(row => ({ code: row.code, name: row.name, quantity: Number(row.quantity) - Number(row.returned_quantity) }));
  const session = await createUploadSession_(env, requestId, 'return', items);
  return { ok: true, requestId, uploadToken: session.token, expectedPhotoCount: session.expectedPhotoCount, items };
}

async function finalizeReturn_(request, env) {
  const data = await readJson_(request);
  const ticket = await requireUploadTicket_(data.uploadToken, env, 'return');
  await requirePhotoCount_(env.DB, ticket.requestId, 'return', ticket.expectedPhotoCount);
  await requireSignature_(env.DB, ticket.requestId, 'return');
  const returnedAt = new Date().toISOString();
  const codes = Object.keys(ticket.allowedCodes);
  await env.DB.batch([
    ...codes.map(code => env.DB.prepare('UPDATE request_items SET returned_quantity=quantity WHERE request_id=? AND equipment_code=?').bind(ticket.requestId, code)),
    env.DB.prepare('UPDATE upload_sessions SET consumed_at=? WHERE session_id=?').bind(returnedAt, ticket.sessionId)
  ]);
  const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM request_items WHERE request_id=? AND returned_quantity < quantity').bind(ticket.requestId).first();
  const complete = Number(remaining?.count || 0) === 0;
  await env.DB.prepare('UPDATE requests SET status=?, returned_at=? WHERE request_id=?').bind(complete ? '已歸還' : '部分歸還', complete ? returnedAt : null, ticket.requestId).run();
  return { ok: true, message: complete ? '所有器材已完成歸還。' : '已記錄部分歸還。' };
}

async function managerSearch_(request, env) {
  require_(await hasAdminAccess_(request, env), 401, '管理權限驗證失敗。');
  const data = await readJson_(request);
  const name = String(data.name || '').trim();
  require_(name && name.length <= 60, 400, '請填寫借用人姓名。');
  const found = await env.DB.prepare(`SELECT request_id,status,borrower_name AS name,loan_start,expected_return
    FROM requests WHERE status <> '已歸還' AND borrower_name LIKE ? ORDER BY created_at DESC LIMIT 30`).bind(`%${name}%`).all();
  const requests = [];
  for (const row of found.results || []) {
    const items = await env.DB.prepare('SELECT equipment_code AS code,equipment_name AS name,quantity,returned_quantity FROM request_items WHERE request_id=? AND returned_quantity<quantity').bind(row.request_id).all();
    requests.push({ requestId: row.request_id, status: row.status, name: row.name, loanStart: row.loan_start, expectedReturn: row.expected_return, items: items.results || [] });
  }
  return { ok: true, requests };
}

async function uploadPhoto_(request, env) {
  const ticket = await requireUploadTicket_(request.headers.get('X-Upload-Ticket'), env);
  const stage = String(request.headers.get('X-Photo-Stage') || '');
  const code = String(request.headers.get('X-Equipment-Code') || '').trim();
  const index = Number(request.headers.get('X-Photo-Index'));
  require_(stage === ticket.stage && ticket.allowedCodes[code] && Number.isInteger(index) && index >= 1 && index <= ticket.allowedCodes[code], 400, '照片上傳資料不正確。');
  const contentType = String(request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
  require_(['image/jpeg', 'image/png', 'image/webp'].includes(contentType), 415, '只支援 JPG、PNG 或 WebP 相片。');
  const length = Number(request.headers.get('Content-Length') || 0);
  require_(!length || length <= MAX_PHOTO_BYTES, 413, '單張照片不可超過 3 MB。');
  const existing = await env.DB.prepare('SELECT provider_ref FROM photos WHERE request_id=? AND equipment_code=? AND stage=? AND photo_index=?').bind(ticket.requestId, code, stage, index).first();
  if (existing) return { ok: true, message: '照片已上傳。' };
  const equipment = await env.DB.prepare('SELECT equipment_name FROM request_items WHERE request_id=? AND equipment_code=?').bind(ticket.requestId, code).first();
  require_(equipment?.equipment_name, 400, '找不到對應的器材。');
  const bytes = await request.arrayBuffer();
  require_(bytes.byteLength > 100 && bytes.byteLength <= MAX_PHOTO_BYTES && looksLikeImage_(new Uint8Array(bytes), contentType), 415, '照片檔案格式不正確。');
  const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM photos WHERE request_id=? AND stage=?').bind(ticket.requestId, stage).first();
  require_(Number(total?.count || 0) < ticket.expectedPhotoCount, 409, '此筆申請的照片數量已達上限。');
  const uploaded = await uploadToPrivateDrive_(env, { requestId: ticket.requestId, equipmentCode: code, equipmentName: equipment.equipment_name, stage, photoIndex: index, contentType, bytes });
  await env.DB.prepare('INSERT INTO photos (request_id,equipment_code,stage,photo_index,provider_ref,uploaded_at) VALUES (?,?,?,?,?,?)').bind(ticket.requestId, code, stage, index, uploaded.reference, new Date().toISOString()).run();
  return { ok: true, message: '已上傳。' };
}

async function uploadSignature_(request, env) {
  const ticket = await requireUploadTicket_(request.headers.get('X-Upload-Ticket'), env);
  const stage = String(request.headers.get('X-Signature-Stage') || '');
  require_(stage === ticket.stage && (stage === 'checkout' || stage === 'return'), 400, '電子簽名階段不正確。');
  const contentType = String(request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
  require_(contentType === 'image/png', 415, '電子簽名只支援 PNG 格式。');
  const length = Number(request.headers.get('Content-Length') || 0);
  require_(!length || length <= MAX_SIGNATURE_BYTES, 413, '電子簽名檔案過大。');
  const existing = await env.DB.prepare('SELECT provider_ref FROM signatures WHERE request_id=? AND stage=?').bind(ticket.requestId, stage).first();
  if (existing) return { ok: true, message: '電子簽名已上傳。' };
  const bytes = await request.arrayBuffer();
  require_(bytes.byteLength > 100 && bytes.byteLength <= MAX_SIGNATURE_BYTES && looksLikeImage_(new Uint8Array(bytes), 'image/png'), 415, '電子簽名檔案格式不正確。');
  const uploaded = await uploadSignatureToPrivateDrive_(env, { requestId: ticket.requestId, stage, contentType, bytes });
  await env.DB.prepare('INSERT INTO signatures (request_id,stage,provider_ref,uploaded_at) VALUES (?,?,?,?)')
    .bind(ticket.requestId, stage, uploaded.reference, new Date().toISOString()).run();
  return { ok: true, message: '電子簽名已上傳。' };
}

async function uploadAssets_(request, env) {
  const startedAt = Date.now();
  const ticket = await requireUploadTicket_(request.headers.get('X-Upload-Ticket'), env);
  const stage = String(request.headers.get('X-Asset-Stage') || '');
  require_(stage === ticket.stage, 400, '批次上傳階段不正確。');
  const form = await request.formData();
  let metadata;
  try { metadata = JSON.parse(String(form.get('metadata') || '[]')); } catch (_) { throw httpError_(400, '照片清單格式不正確。'); }
  require_(Array.isArray(metadata) && metadata.length > 0 && metadata.length <= 6, 400, '每批照片數量不正確。');
  const itemRows = await env.DB.prepare('SELECT equipment_code,equipment_name FROM request_items WHERE request_id=?').bind(ticket.requestId).all();
  const names = Object.fromEntries((itemRows.results || []).map(row => [String(row.equipment_code), String(row.equipment_name)]));
  const existingRows = await env.DB.prepare('SELECT equipment_code,photo_index FROM photos WHERE request_id=? AND stage=?').bind(ticket.requestId, stage).all();
  const existing = new Set((existingRows.results || []).map(row => `${row.equipment_code}:${row.photo_index}`));
  const photos = [];
  const batchKeys = new Set();
  for (const entry of metadata) {
    const code = String(entry.code || '').trim();
    const index = Number(entry.index);
    require_(names[code] && ticket.allowedCodes[code] && Number.isInteger(index) && index >= 1 && index <= ticket.allowedCodes[code], 400, '照片器材資料不正確。');
    const batchKey = `${code}:${index}`;
    require_(!batchKeys.has(batchKey), 400, '批次照片不可重複。');
    batchKeys.add(batchKey);
    if (existing.has(batchKey)) continue;
    const file = form.get(String(entry.field || ''));
    require_(file && typeof file.arrayBuffer === 'function', 400, '批次照片內容遺失。');
    const contentType = String(file.type || '').toLowerCase();
    require_(['image/jpeg', 'image/png', 'image/webp'].includes(contentType) && file.size > 100 && file.size <= MAX_PHOTO_BYTES, 415, '批次照片格式或大小不正確。');
    const bytes = await file.arrayBuffer();
    require_(looksLikeImage_(new Uint8Array(bytes), contentType), 415, '批次照片檔案格式不正確。');
    photos.push({ equipmentCode: code, equipmentName: names[code], photoIndex: index, contentType, bytes });
  }
  const signatureFile = form.get('signature');
  const signatureExisting = await env.DB.prepare('SELECT provider_ref FROM signatures WHERE request_id=? AND stage=?').bind(ticket.requestId, stage).first();
  let signature = null;
  if (!signatureExisting && signatureFile && typeof signatureFile.arrayBuffer === 'function') {
    require_(signatureFile.type === 'image/png' && signatureFile.size > 100 && signatureFile.size <= MAX_SIGNATURE_BYTES, 415, '電子簽名格式或大小不正確。');
    const bytes = await signatureFile.arrayBuffer();
    require_(looksLikeImage_(new Uint8Array(bytes), 'image/png'), 415, '電子簽名檔案格式不正確。');
    signature = { contentType: 'image/png', bytes };
  }
  const uploaded = await uploadAssetsToPrivateDrive_(env, { requestId: ticket.requestId, stage, photos, signature });
  const now = new Date().toISOString();
  const statements = uploaded.photos.map(photo => env.DB.prepare('INSERT OR IGNORE INTO photos (request_id,equipment_code,stage,photo_index,provider_ref,uploaded_at) VALUES (?,?,?,?,?,?)').bind(ticket.requestId, photo.equipmentCode, stage, photo.photoIndex, photo.reference, now));
  if (uploaded.signatureReference) statements.push(env.DB.prepare('INSERT OR IGNORE INTO signatures (request_id,stage,provider_ref,uploaded_at) VALUES (?,?,?,?)').bind(ticket.requestId, stage, uploaded.signatureReference, now));
  if (statements.length) await env.DB.batch(statements);
  return { ok: true, uploaded: uploaded.photos.length, serverMs: Date.now() - startedAt };
}

async function createUploadSession_(env, requestId, stage, items, extraTicketFields = {}) {
  const allowedCodes = Object.fromEntries(items.map(item => [item.code, Number(item.quantity)]));
  const expectedPhotoCount = Object.values(allowedCodes).reduce((sum, quantity) => sum + quantity, 0);
  require_(expectedPhotoCount > 0 && expectedPhotoCount <= MAX_PHOTOS, 400, '照片數量不正確。');
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + UPLOAD_TTL_MS;
  await env.DB.prepare('INSERT INTO upload_sessions (session_id,request_id,stage,allowed_codes_json,expected_photo_count,expires_at) VALUES (?,?,?,?,?,?)')
    .bind(sessionId, requestId, stage, JSON.stringify(allowedCodes), expectedPhotoCount, expiresAt).run();
  const token = await signTicket_({ sessionId, requestId, stage, expiresAt, ...extraTicketFields }, env);
  return { token, expectedPhotoCount };
}

async function requireUploadTicket_(token, env, expectedStage = '') {
  const payload = await verifyTicket_(token, env);
  require_(!expectedStage || payload.stage === expectedStage, 403, '上傳憑證不適用於這個操作。');
  const session = await env.DB.prepare('SELECT session_id,request_id,stage,allowed_codes_json,expected_photo_count,expires_at,consumed_at FROM upload_sessions WHERE session_id=?').bind(payload.sessionId).first();
  require_(session && session.request_id === payload.requestId && session.stage === payload.stage && !session.consumed_at && Number(session.expires_at) > Date.now(), 410, '上傳憑證已失效，請重新開始。');
  const returnCode = payload.returnCode || '';
  return { sessionId: session.session_id, requestId: session.request_id, stage: session.stage, allowedCodes: JSON.parse(session.allowed_codes_json), expectedPhotoCount: Number(session.expected_photo_count), returnCode };
}

async function requirePhotoCount_(db, requestId, stage, expected) {
  const count = await db.prepare('SELECT COUNT(*) AS count FROM photos WHERE request_id=? AND stage=?').bind(requestId, stage).first();
  require_(Number(count?.count || 0) === expected, 409, '照片尚未全部上傳完成。');
}

async function requireSignature_(db, requestId, stage) {
  const signature = await db.prepare('SELECT provider_ref FROM signatures WHERE request_id=? AND stage=?').bind(requestId, stage).first();
  require_(Boolean(signature?.provider_ref), 409, '電子簽名尚未上傳完成。');
}

async function nextRequestId_(db) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = key => parts.find(part => part.type === key)?.value || '';
  const day = `${value('year')}${value('month')}${value('day')}`;
  const counter = await db.prepare(`INSERT INTO daily_counters (day,last_number) VALUES (?,1)
    ON CONFLICT(day) DO UPDATE SET last_number=last_number+1 RETURNING last_number`).bind(day).first();
  const serial = Number(counter?.last_number);
  require_(Number.isInteger(serial) && serial > 0 && serial <= 999, 503, '今日申請編號已達上限，請聯絡管理者。');
  return day + String(serial).padStart(3, '0');
}

async function assertTurnstile_(token, action, request, env) {
  require_(typeof token === 'string' && token.length > 0 && token.length <= 2048, 400, '請先完成安全驗證。');
  require_(env.TURNSTILE_SECRET, 500, '安全驗證尚未設定。');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  form.set('remoteip', clientIp_(request));
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const result = await response.json();
  const hostname = originHost_(request.headers.get('Origin'));
  require_(result.success && result.action === action && (!hostname || result.hostname === hostname), 403, '安全驗證失敗或已過期，請重新驗證後再送出。');
}

async function requireReturnCode_(env, requestId, returnCode) {
  const row = await env.DB.prepare('SELECT return_code_hash FROM requests WHERE request_id=?').bind(requestId).first();
  require_(row, 404, '找不到符合的借用紀錄。');
  const supplied = String(returnCode || '').replace(/\s+/g, '').toUpperCase();
  require_(/^[A-F0-9]{12}$/.test(supplied) && constantTimeEqual_(await returnCodeHash_(supplied, env), String(row.return_code_hash || '')), 403, '歸還驗證碼不正確。');
}

async function hasAdminAccess_(request, env) {
  const supplied = String(request.headers.get('X-Admin-Key') || '');
  return Boolean(env.ADMIN_KEY && supplied && constantTimeEqual_(supplied, env.ADMIN_KEY));
}

function rateLimitMessage_(resetAt) {
  const time = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(resetAt));
  return `嘗試次數已達限制，請於 ${time}（台灣時間）後再試。請勿連續重送。`;
}

async function checkLoanCompletionQuota_(env, email, ip) {
  const limits = [
    { scope: `loan-complete:${await digest_(String(email).toLowerCase())}`, maximum: 3 },
    { scope: `ip-complete:${ip}`, maximum: 8 }
  ];
  const now = Date.now();
  const rows = await Promise.all(limits.map(limit => env.DB.prepare('SELECT count,reset_at FROM rate_limits WHERE scope=?').bind(limit.scope).first()));
  let blockedUntil = 0;
  rows.forEach((row, index) => {
    if (row && Number(row.reset_at) > now && Number(row.count) >= limits[index].maximum) blockedUntil = Math.max(blockedUntil, Number(row.reset_at));
  });
  if (blockedUntil) throw httpError_(429, rateLimitMessage_(blockedUntil));
}

async function rateLimit_(env, scope, maximum, windowMs) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const result = await env.DB.prepare(`INSERT INTO rate_limits (scope,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(scope) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,
    reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END RETURNING count,reset_at`).bind(scope, resetAt, now, now).first();
  require_(Number(result?.count || maximum + 1) <= maximum, 429, rateLimitMessage_(Number(result?.reset_at) || resetAt));
}

// Encrypt temporary email data so the return code is not stored in plaintext.
async function emailJobKey_(env) {
  require_(env.UPLOAD_TICKET_SECRET, 500, '寄信安全設定尚未完成。');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('email-outbox-v1:' + env.UPLOAD_TICKET_SECRET));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptEmailJob_(env, job) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await emailJobKey_(env), new TextEncoder().encode(JSON.stringify(job)));
  return JSON.stringify({ iv: Array.from(iv), bytes: Array.from(new Uint8Array(encrypted)) });
}

async function deliverEmailJob_(env, requestId) {
  // Lease makes immediate delivery and scheduled retries mutually exclusive.
  const job = await env.DB.prepare("UPDATE email_outbox SET attempts=attempts+1,next_attempt_at=? WHERE request_id=? AND status='pending' AND next_attempt_at<=? AND attempts<5 RETURNING *")
    .bind(Date.now() + 10 * 60 * 1000, requestId, Date.now()).first();
  if (!job) return;
  try {
    const encrypted = JSON.parse(job.payload);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(encrypted.iv) }, await emailJobKey_(env), new Uint8Array(encrypted.bytes));
    const { record, returnCode, items } = JSON.parse(new TextDecoder().decode(plain));
    if (!await sendBorrowerEmail_(env, record, requestId, returnCode, items)) throw new Error('Email delivery failed');
    await env.DB.prepare('DELETE FROM email_outbox WHERE request_id=?').bind(requestId).run();
  } catch (_) {
    // Do not put borrower details, return codes or provider errors in logs.
    console.error('Email outbox delivery needs retry');
    if (Number(job.attempts) >= 5) {
      await env.DB.prepare("UPDATE email_outbox SET status='failed',payload='' WHERE request_id=?").bind(requestId).run();
    }
  }
}

async function drainEmailOutbox_(env) {
  // Also handle the final attempt being terminated before its catch handler ran.
  await env.DB.prepare("UPDATE email_outbox SET status='failed',payload='' WHERE status='pending' AND attempts>=5 AND next_attempt_at<=?").bind(Date.now()).run();
  const jobs = await env.DB.prepare("SELECT request_id FROM email_outbox WHERE status='pending' AND attempts<5 AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 5").bind(Date.now()).all();
  for (const job of jobs.results || []) await deliverEmailJob_(env, job.request_id);
}

async function sendBorrowerEmail_(env, record, requestId, returnCode, items) {
  try {
    const response = await callPrivateGas_(env, {
      action: 'internalSendEmail', requestId, returnCode,
      borrower: { name: record.borrower_name, email: record.email },
      loan: { start: record.loan_start, expectedReturn: record.expected_return },
      items: items.map(item => ({ name: item.equipment_name, quantity: Number(item.quantity) }))
    });
    return Boolean(response.emailSent);
  } catch (error) {
    console.error('Email delivery failed');
    return false;
  }
}

async function uploadToPrivateDrive_(env, photo) {
  const dataUrl = `data:${photo.contentType};base64,${base64_(new Uint8Array(photo.bytes))}`;
  const response = await callPrivateGas_(env, {
    action: 'internalUploadPhoto', requestId: photo.requestId, equipmentCode: photo.equipmentCode, equipmentName: photo.equipmentName,
    stage: photo.stage, photoIndex: photo.photoIndex, photo: { dataUrl }
  });
  require_(typeof response.reference === 'string' && response.reference.length > 0, 502, '照片儲存服務沒有回傳結果。');
  return response;
}

async function uploadSignatureToPrivateDrive_(env, signature) {
  const dataUrl = `data:${signature.contentType};base64,${base64_(new Uint8Array(signature.bytes))}`;
  const response = await callPrivateGas_(env, {
    action: 'internalUploadSignature', requestId: signature.requestId, stage: signature.stage, signature: { dataUrl }
  });
  require_(typeof response.reference === 'string' && response.reference.length > 0, 502, '電子簽名儲存服務沒有回傳結果。');
  return response;
}

async function uploadAssetsToPrivateDrive_(env, batch) {
  const response = await callPrivateGas_(env, {
    action: 'internalUploadAssets', requestId: batch.requestId, stage: batch.stage,
    photos: batch.photos.map(photo => ({
      equipmentCode: photo.equipmentCode, equipmentName: photo.equipmentName, photoIndex: photo.photoIndex,
      photo: { dataUrl: `data:${photo.contentType};base64,${base64_(new Uint8Array(photo.bytes))}` }
    })),
    signature: batch.signature ? { dataUrl: `data:${batch.signature.contentType};base64,${base64_(new Uint8Array(batch.signature.bytes))}` } : null
  });
  require_(Array.isArray(response.photos), 502, '批次照片服務沒有回傳結果。');
  return response;
}

async function callPrivateGas_(env, payload) {
  require_(env.GAS_INTERNAL_URL && env.GAS_INTERNAL_TOKEN, 500, '私有照片服務尚未設定。');
  const response = await fetch(env.GAS_INTERNAL_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, internalToken: env.GAS_INTERNAL_TOKEN })
  });
  let result;
  try { result = await response.json(); } catch (_) { throw httpError_(502, '私有照片服務回應格式錯誤。'); }
  require_(response.ok && result?.ok, 502, result?.message || '私有照片服務暫時無法處理。');
  return result;
}

function validateBorrower_(input) {
  const borrower = { name: String(input?.name || '').trim(), studentId: String(input?.studentId || '').trim(), phone: String(input?.phone || '').trim(), email: String(input?.email || '').trim() };
  require_(borrower.name && borrower.studentId && borrower.phone && borrower.email, 400, '請填寫所有必填的申請人資料。');
  require_(borrower.name.length <= 60 && borrower.studentId.length <= 40 && borrower.phone.length <= 24 && borrower.email.length <= 120, 400, '申請人資料長度不正確。');
  require_(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(borrower.email), 400, '電子信箱格式不正確。');
  require_(/^(?:\+8869\d{8}|008869\d{8}|09\d{8}|0\d{8,10})$/.test(borrower.phone.replace(/[\s()\-]/g, '')), 400, '電話格式不正確。');
  return borrower;
}

function validateLoan_(input) {
  const start = String(input?.start || ''); const expectedReturn = String(input?.expectedReturn || '');
  require_(/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(expectedReturn) && expectedReturn > start, 400, '借用日期或預計歸還日期不正確。');
  return { start, expectedReturn };
}

function validateItems_(input) {
  require_(Array.isArray(input) && input.length > 0 && input.length <= MAX_ITEMS, 400, '請至少選擇一項器材。');
  const codes = new Set();
  return input.map(item => {
    const code = String(item?.code || '').trim(); const name = String(item?.name || '').trim(); const quantity = Number(item?.quantity);
    require_(code && name && code.length <= 80 && name.length <= 160 && Number.isInteger(quantity) && quantity > 0 && quantity <= 30 && !codes.has(code), 400, '器材資料不正確。');
    codes.add(code); return { code, name, quantity };
  });
}

function validateRequestId_(value) { const requestId = String(value || '').trim(); require_(/^\d{11}$/.test(requestId), 400, '申請編號格式不正確。'); return requestId; }
function looksLikeImage_(bytes, type) { return (type === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) || (type === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) || (type === 'image/webp' && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50); }
function clientIp_(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }
function originHost_(origin) { try { return origin ? new URL(origin).hostname : ''; } catch { return ''; } }
function isAllowedOrigin_(origin, env) { return Boolean(origin && String(env.PUBLIC_ORIGINS || '').split(',').map(value => value.trim()).includes(origin)); }
function corsPreflight_(origin, env) { return isAllowedOrigin_(origin, env) ? new Response(null, { status: 204, headers: corsHeaders_(origin, env) }) : new Response(null, { status: 403 }); }
function corsHeaders_(origin, env) { return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Ticket, X-Photo-Stage, X-Equipment-Code, X-Photo-Index, X-Signature-Stage, X-Asset-Stage, X-Admin-Key', 'Access-Control-Max-Age': '600', Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }; }
function json_(value, origin, env, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders_(origin, env) } }); }
async function readJson_(request) { const length = Number(request.headers.get('Content-Length') || 0); require_(!length || length <= 200_000, 413, '送出資料過大。'); try { return await request.json(); } catch { throw httpError_(400, '送出資料格式不正確。'); } }
function require_(condition, status, message) { if (!condition) throw httpError_(status, message); }
function httpError_(status, message) { const error = new Error(message); error.status = status; return error; }
function html_(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function randomHex_(length) { const bytes = new Uint8Array(Math.ceil(length / 2)); crypto.getRandomValues(bytes); return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length).toUpperCase(); }
function constantTimeEqual_(left, right) { if (left.length !== right.length) return false; let diff = 0; for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index); return diff === 0; }
async function digest_(value) { const data = new TextEncoder().encode(String(value)); const hash = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function returnCodeHash_(value, env) {
  require_(env.UPLOAD_TICKET_SECRET, 500, '歸還驗證設定尚未完成。');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.UPLOAD_TICKET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`return-code:${String(value)}`));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64Url_(bytes) { let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function base64_(bytes) { let raw = ''; const block = 0x8000; for (let offset = 0; offset < bytes.length; offset += block) raw += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + block))); return btoa(raw); }
function decodeBase64Url_(value) { const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(raw, char => char.charCodeAt(0)); }
async function signTicket_(payload, env) { require_(env.UPLOAD_TICKET_SECRET, 500, '上傳安全設定尚未完成。'); const encoded = base64Url_(new TextEncoder().encode(JSON.stringify(payload))); const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.UPLOAD_TICKET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const signature = base64Url_(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded)))); return `${encoded}.${signature}`; }
async function verifyTicket_(token, env) { try { const [encoded, signature] = String(token || '').split('.'); require_(encoded && signature, 403, '上傳憑證不正確。'); const expected = (await signTicket_(JSON.parse(new TextDecoder().decode(decodeBase64Url_(encoded))), env)).split('.')[1]; require_(constantTimeEqual_(signature, expected), 403, '上傳憑證不正確。'); const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url_(encoded))); require_(Number(payload.expiresAt) > Date.now(), 410, '上傳憑證已逾時。'); return payload; } catch (error) { if (error?.status) throw error; throw httpError_(403, '上傳憑證不正確。'); } }
