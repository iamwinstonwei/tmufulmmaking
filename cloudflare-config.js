/*
 * 這個檔案可以公開：siteKey 與 Worker 網址不是密碼。
 * Cloudflare 部署完成後，才將兩個空字串填入正式值；所有真正的密鑰只放在 Worker 的 Secrets。
 */
window.TMU_CLOUDFLARE = Object.freeze({
  apiUrl: 'https://tmu-filmmaking-lending-api.winstonwei1960.workers.dev',
  turnstileSiteKey: '0x4AAAAAAEmDCDBiIRnhPafo'
});
