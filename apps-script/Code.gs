/**
 * 北醫影創器材借還後端
 * 將私密資料庫與照片資料夾 ID 存在「指令碼屬性」；執行 setupDatabase；部署為網頁應用程式。
 */
const CONFIG = {
  requestsSheet: '借用申請',
  itemsSheet: '借用項目'
};

const REQUEST_HEADERS = ['申請編號', '申請時間', '狀態', '姓名', '學號', '電話', '器材項數', '領用照片資料夾', '歸還照片資料夾', '借用日期', '預計歸還日期', '電子信箱', '歸還驗證碼雜湊'];
const ITEM_HEADERS = ['申請編號', '財產編號', '器材名稱', '數量', '領用照片', '歸還照片', '歸還時間'];
const MAX_PHOTO_BYTES = 9 * 1024 * 1024;
const MAX_ITEMS_PER_REQUEST = 30;
const MAX_PHOTOS_PER_REQUEST = 60;

function setupDatabase() {
  const ss = requestSpreadsheet_();
  ensureSheet_(ss, CONFIG.requestsSheet, REQUEST_HEADERS);
  ensureSheet_(ss, CONFIG.itemsSheet, ITEM_HEADERS);
  const root = photoRoot_();
  if (!findFolder_(root, '領用照片')) root.createFolder('領用照片');
  if (!findFolder_(root, '歸還照片')) root.createFolder('歸還照片');
}

function doGet(e) {
  try {
    return json_({ ok: true, service: 'TMU equipment lending API' });
  } catch (err) {
    return apiError_(err);
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    // Cloudflare Worker 專用入口：密鑰只保存在 Worker Secret 與 Script Property，瀏覽器永遠不會拿到。
    if (String(data.action || '').indexOf('internal') === 0) return json_(handleCloudflareInternal_(data));
    // 確認 Cloudflare 新版上線後，將此 Script Property 設為 true，完全關閉舊有公開 API。
    if (PropertiesService.getScriptProperties().getProperty('CLOUDFLARE_ONLY') === 'true') throw new Error('此服務已改由安全後端處理。');
    if (data.action === 'request') return json_(createRequest_(data));
    if (data.action === 'lookup') return json_(lookupRequest_(data.requestId, data));
    if (data.action === 'return') return json_(returnItems_(data));
    if (data.action === 'manageSearch') return json_(manageSearch_(data));
    throw new Error('不支援的操作。');
  } catch (err) {
    return apiError_(err);
  }
}

function createRequest_(data) {
  require_(data.borrower, '請填寫申請人資料。');
  const borrower = {
    name: String(data.borrower.name || '').trim(),
    studentId: String(data.borrower.studentId || '').trim(),
    phone: String(data.borrower.phone || '').trim(),
    email: String(data.borrower.email || '').trim()
  };
  require_(borrower.name, '請填寫姓名。');
  require_(borrower.studentId, '請填寫學號。');
  require_(borrower.phone, '請填寫電話。');
  require_(borrower.email, '請填寫電子信箱。');
  require_(borrower.name.length <= 60 && borrower.studentId.length <= 40 && borrower.phone.length <= 24 && borrower.email.length <= 120, '申請人資料長度不正確。');
  require_(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(borrower.email), '電子信箱格式不正確。');
  require_(validTaiwanPhone_(borrower.phone), '電話格式不正確，請填寫有效的台灣電話號碼。');
  require_(Array.isArray(data.items) && data.items.length, '請至少選擇一項器材。');
  require_(data.items.length <= MAX_ITEMS_PER_REQUEST, '單次申請的器材項目過多，請分次申請。');
  const loan = validateLoan_(data.loan);
  let photoCount = 0;
  data.items.forEach(item => {
    require_(item.code && item.name && Number(item.quantity) > 0 && Number(item.quantity) <= MAX_PHOTOS_PER_REQUEST, '器材資料不完整。');
    require_(String(item.code).length <= 80 && String(item.name).length <= 160, '器材資料長度不正確。');
    require_(Array.isArray(item.checkOutPhotos) && item.checkOutPhotos.length === Number(item.quantity), '每一件器材都必須各附上一張領用照片。');
    photoCount += item.checkOutPhotos.length;
    item.checkOutPhotos.forEach(validatePhoto_);
  });
  require_(photoCount <= MAX_PHOTOS_PER_REQUEST, '單次上傳照片過多，請分次申請。');
  enforceRateLimit_('request:' + borrower.email.toLowerCase(), 3, 60 * 60);

  const ss = requestSpreadsheet_();
  const requestSheet = ss.getSheetByName(CONFIG.requestsSheet);
  const itemSheet = ss.getSheetByName(CONFIG.itemsSheet);
  require_(requestSheet && itemSheet, '資料庫尚未初始化，請先以管理者身分執行 setupDatabase。');
  const now = new Date();
  const lock = LockService.getScriptLock();
  let requestId, checkOutFolder, returnFolder;
  const returnCode = generateReturnCode_();
  try {
    lock.waitLock(30000);
    requestId = nextRequestId_(requestSheet, now);
    const root = photoRoot_();
    checkOutFolder = childFolder_(childFolder_(root, '領用照片'), requestId);
    returnFolder = childFolder_(childFolder_(root, '歸還照片'), requestId);
    requestSheet.appendRow([requestId, now, '待確認', borrower.name, borrower.studentId, borrower.phone, data.items.length, checkOutFolder.getUrl(), returnFolder.getUrl(), loan.start, loan.expectedReturn, borrower.email, hashText_(returnCode)]);
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
  const itemRows = data.items.map(item => {
    const photoUrls = item.checkOutPhotos.map((photo, index) => savePhoto_(checkOutFolder, photo, photoFileLabel_(item.name, '領用', index + 1)));
    return [requestId, item.code, item.name, Number(item.quantity), photoUrls.join('\n'), '', ''];
  });
  itemSheet.getRange(itemSheet.getLastRow() + 1, 1, itemRows.length, ITEM_HEADERS.length).setValues(itemRows);
  const emailSent = sendRequestEmail_(borrower.email, borrower.name, requestId, returnCode, loan, data.items);
  return { ok: true, requestId: requestId, returnCode: returnCode, emailSent: emailSent, message: emailSent ? '申請已送出，通知已寄到你的電子信箱。' : '申請已送出，但通知信寄送失敗。' };
}

function lookupRequest_(requestId, access) {
  validateRequestId_(requestId);
  if (!hasAdminAccess_(access && access.adminKey)) enforceRateLimit_('return:' + requestId, 12, 10 * 60);
  const ss = requestSpreadsheet_();
  const requestSheet = ss.getSheetByName(CONFIG.requestsSheet);
  const requestRows = requestSheet.getDataRange().getValues();
  const request = requestRows.slice(1).find(row => String(row[0]) === requestId);
  if (!request) throw new Error('找不到符合的借用紀錄。');
  requireReturnAccess_(request, access);
  const itemRows = ss.getSheetByName(CONFIG.itemsSheet).getDataRange().getValues().slice(1)
    .filter(row => String(row[0]) === requestId)
    .map(row => ({ code: row[1], name: row[2], quantity: row[3], returned: Boolean(row[5]) }));
  return { ok: true, requestId: requestId, items: itemRows };
}

function manageSearch_(data) {
  requireAdmin_(data.adminKey);
  const name = String(data.name || '').trim();
  require_(name, '請填寫借用人姓名。');
  const ss = requestSpreadsheet_();
  const itemRows = ss.getSheetByName(CONFIG.itemsSheet).getDataRange().getValues().slice(1);
  const pendingItemsByRequest = new Map();
  itemRows.forEach(item => {
    if (item[5]) return;
    const requestId = String(item[0]);
    if (!pendingItemsByRequest.has(requestId)) pendingItemsByRequest.set(requestId, []);
    pendingItemsByRequest.get(requestId).push({ code: String(item[1]), name: String(item[2]), quantity: item[3] });
  });
  const requests = ss.getSheetByName(CONFIG.requestsSheet).getDataRange().getValues().slice(1)
    .filter(row => String(row[2]) !== '已歸還' && String(row[3]).toLowerCase().indexOf(name.toLowerCase()) >= 0)
    .sort((a, b) => new Date(b[1]) - new Date(a[1]))
    .map(row => ({
      requestId: String(row[0]), status: String(row[2]), name: String(row[3]),
      loanStart: dateText_(row[9]), expectedReturn: dateText_(row[10]),
      items: pendingItemsByRequest.get(String(row[0])) || []
    }));
  return { ok: true, requests: requests };
}

function returnItems_(data) {
  validateRequestId_(data.requestId);
  require_(Array.isArray(data.items) && data.items.length, '請至少選擇一項器材。');
  require_(data.items.length <= MAX_ITEMS_PER_REQUEST, '單次歸還的器材項目過多。');
  if (!hasAdminAccess_(data.adminKey)) enforceRateLimit_('return:' + data.requestId, 12, 10 * 60);
  const ss = requestSpreadsheet_();
  const requestSheet = ss.getSheetByName(CONFIG.requestsSheet);
  const itemSheet = ss.getSheetByName(CONFIG.itemsSheet);
  require_(requestSheet && itemSheet, '資料庫尚未初始化，請先以管理者身分執行 setupDatabase。');
  const requestRows = requestSheet.getDataRange().getValues();
  const requestRowIndex = requestRows.findIndex((row, index) => index > 0 && String(row[0]) === String(data.requestId));
  require_(requestRowIndex > 0, '找不到符合的借用紀錄。');
  requireReturnAccess_(requestRows[requestRowIndex], data);
  const values = itemSheet.getDataRange().getValues();
  const itemRowsByCode = new Map();
  values.slice(1).forEach((row, index) => {
    if (String(row[0]) === String(data.requestId)) itemRowsByCode.set(String(row[1]), { row: row, rowIndex: index + 1 });
  });
  const seenCodes = new Set();
  let returnPhotoCount = 0;
  data.items.forEach(item => {
    require_(!seenCodes.has(String(item.code)), '同一器材不可重複送出歸還。');
    seenCodes.add(String(item.code));
    const borrowedItem = itemRowsByCode.get(String(item.code));
    require_(borrowedItem && !borrowedItem.row[5], '含有無法歸還的器材。');
    require_(Array.isArray(item.returnPhotos) && item.returnPhotos.length === Number(borrowedItem.row[3]), '每一件歸還器材都必須各附上一張照片。');
    returnPhotoCount += item.returnPhotos.length;
    item.returnPhotos.forEach(validatePhoto_);
  });
  require_(returnPhotoCount <= MAX_PHOTOS_PER_REQUEST, '單次上傳照片過多，請分次歸還。');

  const root = photoRoot_();
  const returnFolder = childFolder_(childFolder_(root, '歸還照片'), data.requestId);
  data.items.forEach(item => {
    const borrowedItem = itemRowsByCode.get(String(item.code));
    const equipmentName = borrowedItem.row[2];
    const photoUrls = item.returnPhotos.map((photo, index) => savePhoto_(returnFolder, photo, photoFileLabel_(equipmentName, '歸還', index + 1)));
    const returnedAt = new Date();
    borrowedItem.row[5] = photoUrls.join('\n');
    borrowedItem.row[6] = returnedAt;
    itemSheet.getRange(borrowedItem.rowIndex + 1, 6, 1, 2).setValues([[borrowedItem.row[5], returnedAt]]);
  });

  const remaining = values.slice(1)
    .filter(row => String(row[0]) === data.requestId).some(row => !row[5]);
  requestSheet.getRange(requestRowIndex + 1, 3).setValue(remaining ? '部分歸還' : '已歸還');
  return { ok: true, message: remaining ? '已記錄部分歸還。' : '所有器材已完成歸還。' };
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
  headers.forEach((header, index) => { if (!currentHeaders[index]) sheet.getRange(1, index + 1).setValue(header); });
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#dfeaff');
  return sheet;
}
function scriptProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  require_(value, '請先在 Apps Script 的「指令碼屬性」設定 ' + name + '。');
  return value;
}
function requestSpreadsheet_() { return SpreadsheetApp.openById(scriptProperty_('REQUEST_SPREADSHEET_ID')); }
function photoRoot_() {
  const folder = DriveApp.getFolderById(scriptProperty_('PHOTO_ROOT_FOLDER_ID'));
  const access = folder.getSharingAccess();
  require_(access !== DriveApp.Access.ANYONE && access !== DriveApp.Access.ANYONE_WITH_LINK, '照片資料夾不可設為公開或知道連結者可檢視。請改為「受限制」或僅限校內網域。');
  return folder;
}

function childFolder_(parent, name) { return findFolder_(parent, name) || parent.createFolder(name); }
function findFolder_(parent, name) { const folders = parent.getFoldersByName(name); return folders.hasNext() ? folders.next() : null; }
function photoFileLabel_(equipmentName, stage, index) {
  return String(equipmentName || '器材').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim() + '-' + stage + '-' + index;
}
function savePhoto_(folder, photo, label) {
  const matches = validatePhoto_(photo);
  const extension = (matches[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const blob = Utilities.newBlob(Utilities.base64Decode(matches[2]), matches[1], label + '-' + Date.now() + '.' + extension);
  return folder.createFile(blob).getUrl();
}
function validatePhoto_(photo) {
  const matches = String(photo && photo.dataUrl).match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!matches) throw new Error('照片格式無效，請使用 JPG、PNG、WebP 或 HEIC。');
  if (Math.floor(matches[2].length * 3 / 4) > MAX_PHOTO_BYTES) throw new Error('單張照片不可超過 9 MB。');
  return matches;
}
function validTaiwanPhone_(phone) {
  const compact = String(phone).replace(/[\s()\-]/g, '');
  return /^(?:\+8869\d{8}|008869\d{8}|09\d{8}|0\d{8,10})$/.test(compact);
}
function validateLoan_(loan) {
  require_(loan && loan.start && loan.expectedReturn, '請填寫借用日期與預計歸還日期。');
  const start = new Date(loan.start);
  const expectedReturn = new Date(loan.expectedReturn);
  require_(!isNaN(start.getTime()) && !isNaN(expectedReturn.getTime()), '借用日期格式無效。');
  require_(expectedReturn.getTime() > start.getTime(), '預計歸還日期必須晚於借用日期。');
  return { start: start, expectedReturn: expectedReturn };
}
function validateRequestId_(requestId) {
  require_(/^\d{11}$/.test(String(requestId || '').trim()), '申請編號格式不正確。');
}
function normalizeReturnCode_(value) { return String(value || '').replace(/\s+/g, '').toUpperCase(); }
function generateReturnCode_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(); }
function hashText_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}
function constantTimeEqual_(left, right) {
  left = String(left || ''); right = String(right || '');
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
function enforceRateLimit_(scope, maximum, seconds) {
  const cache = CacheService.getScriptCache();
  const key = 'rate:' + hashText_(scope).slice(0, 32);
  const attempts = Number(cache.get(key) || '0');
  require_(attempts < maximum, '嘗試次數過多，請稍後再試。');
  cache.put(key, String(attempts + 1), seconds);
}
function requireReturnAccess_(requestRow, data) {
  const adminKey = String(data && data.adminKey || '');
  if (adminKey) { requireAdmin_(adminKey); return; }
  const returnCode = normalizeReturnCode_(data && data.returnCode);
  const savedHash = String(requestRow[12] || '');
  require_(savedHash, '這筆舊申請沒有歸還驗證碼，請由管理者辦理歸還。');
  require_(returnCode, '請輸入確認信中的歸還驗證碼。');
  require_(constantTimeEqual_(hashText_(returnCode), savedHash), '歸還驗證碼不正確。');
}
function hasAdminAccess_(adminKey) {
  const configuredKey = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return Boolean(configuredKey && adminKey && constantTimeEqual_(String(adminKey), configuredKey));
}
function requireAdmin_(adminKey) {
  const configuredKey = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  require_(configuredKey, '管理功能尚未設定管理密碼。');
  require_(hasAdminAccess_(adminKey), '管理密碼不正確。');
}
function dateText_(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date.getTime()) ? String(value) : Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}
function nextRequestId_(requestSheet, now) {
  const prefix = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd');
  const lastRow = requestSheet.getLastRow();
  if (lastRow < 2) return prefix + '001';
  // 只讀取申請編號欄，不再為了流水號載入整份借用紀錄。
  const existing = requestSheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat();
  const latest = existing.filter(id => id.indexOf(prefix) === 0)
    .reduce((max, id) => Math.max(max, Number(id.slice(prefix.length)) || 0), 0);
  return prefix + String(latest + 1).padStart(3, '0');
}
function sendRequestEmail_(email, name, requestId, returnCode, loan, items) {
  try {
    const itemList = items.map(item => '<li>' + escapeHtml_(item.name) + ' × ' + Number(item.quantity) + '</li>').join('');
    MailApp.sendEmail({
      to: email,
      subject: '北醫影創器材借用申請｜' + requestId,
      htmlBody: '<p>' + escapeHtml_(name) + '，你的器材借用申請已送出。</p>' +
        '<p><b>借用編號：</b>' + requestId + '<br><b>借用日期：</b>' + dateText_(loan.start) +
        '<br><b>預計歸還日期：</b>' + dateText_(loan.expectedReturn) + '</p><p><b>器材：</b></p><ul>' + itemList + '</ul>' +
        '<p><b>歸還驗證碼：</b>' + returnCode + '</p><p>歸還時請同時輸入借用編號與歸還驗證碼。請勿將驗證碼分享給他人。</p>'
    });
    return true;
  } catch (err) {
    console.log('借用通知寄送失敗：' + err.message);
    return false;
  }
}
function escapeHtml_(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function require_(condition, message) { if (!condition) throw new Error(message); }
function json_(payload) { return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON); }
function apiError_(err) {
  console.log(err && err.stack ? err.stack : err);
  return json_({ ok: false, message: String(err && err.message || '系統暫時無法處理，請稍後再試。') });
}

/**
 * 僅由 Cloudflare Worker 呼叫的私有橋接：保存照片與寄確認信。
 * 新版正式上線後，doPost 會拒絕舊 action；此處仍必須先驗證內部密鑰。
 */
function handleCloudflareInternal_(data) {
  const expected = PropertiesService.getScriptProperties().getProperty('CLOUDFLARE_INTERNAL_TOKEN');
  require_(expected, '尚未設定 Cloudflare 內部驗證。');
  require_(constantTimeEqual_(String(data.internalToken || ''), expected), '內部驗證失敗。');
  if (data.action === 'internalUploadPhoto') return internalUploadPhoto_(data);
  if (data.action === 'internalSendEmail') return internalSendEmail_(data);
  throw new Error('不支援的內部操作。');
}

function internalUploadPhoto_(data) {
  validateRequestId_(data.requestId);
  const code = String(data.equipmentCode || '').trim();
  const name = String(data.equipmentName || '').trim();
  const stage = String(data.stage || '');
  const index = Number(data.photoIndex);
  require_(code && code.length <= 80 && name && name.length <= 160, '照片器材資料不正確。');
  require_(stage === 'checkout' || stage === 'return', '照片階段不正確。');
  require_(Number.isInteger(index) && index >= 1 && index <= 30, '照片序號不正確。');
  validatePhoto_(data.photo);
  const folderName = stage === 'checkout' ? '領用照片' : '歸還照片';
  const label = photoFileLabel_(name, stage === 'checkout' ? '領用' : '歸還', index);
  const folder = childFolder_(childFolder_(photoRoot_(), folderName), String(data.requestId));
  const reference = savePhoto_(folder, data.photo, label);
  return { ok: true, reference: reference };
}

function internalSendEmail_(data) {
  validateRequestId_(data.requestId);
  const borrower = data.borrower || {};
  const loan = data.loan || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const email = String(borrower.email || '').trim();
  const code = normalizeReturnCode_(data.returnCode);
  require_(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), '電子信箱格式不正確。');
  require_(String(borrower.name || '').trim() && /^[A-F0-9]{12}$/.test(code), '確認信資料不正確。');
  require_(items.length > 0 && items.length <= MAX_ITEMS_PER_REQUEST, '確認信器材資料不正確。');
  const emailSent = sendRequestEmail_(email, String(borrower.name).trim(), String(data.requestId), code, loan, items);
  return { ok: true, emailSent: emailSent };
}
