const LEGACY_API_URL = 'https://script.google.com/macros/s/AKfycbyUcZU0qOT-1wMUBvSy7iFepJGN4_3GZD87Ik7ilpzJFlThVydDteA0xFCUDf7FL4V53g/exec';
const CLOUDFLARE = window.TMU_CLOUDFLARE || {};
const CLOUDFLARE_API_URL = String(CLOUDFLARE.apiUrl || '').replace(/\/+$/, '');
const USING_CLOUDFLARE = Boolean(CLOUDFLARE_API_URL && CLOUDFLARE.turnstileSiteKey);
const API_URL = USING_CLOUDFLARE ? CLOUDFLARE_API_URL : LEGACY_API_URL;
const INVENTORY_CACHE_KEY = 'tmu-equipment-inventory-v2';
const INVENTORY_CACHE_MAX_AGE = 12 * 60 * 60 * 1000;

let items = [];
let activeCategory = '';
let inventoryFingerprint_ = '';
const cart = new Map();
const preparedPhotoData_ = new WeakMap();
const photoPreparationTokens_ = new WeakMap();
let managerAdminKey_ = '';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const categoryName = category => (category || '其他').replace(/^\d+/, '') || '其他';
function categoryIcon_(category) {
  const label = categoryName(category).toLowerCase();
  if (label.includes('相機')) return '📷';
  if (label.includes('鏡頭')) return '◉';
  if (label.includes('燈')) return '✦';
  if (label.includes('收音') || label.includes('錄音') || label.includes('麥')) return '◌';
  if (label.includes('腳架') || label.includes('穩定') || label.includes('滑軌')) return '⌇';
  if (label.includes('電池') || label.includes('供電') || label.includes('充電')) return 'ϟ';
  if (label.includes('記憶') || label.includes('儲存')) return '▣';
  if (label.includes('收納') || label.includes('箱') || label.includes('包')) return '▱';
  return '✳';
}
const DESIGN_STORAGE_KEY = 'tmu-equipment-design-v2';
const DAYPAY_DESIGN = Object.freeze({
  eyebrow: 'TMU Filmmaking',
  title: '北醫影片創作社器材借用目錄',
  subtitle: '快速找器材、確認數量與收納位置',
  night: '#0b1d4d',
  accent: '#7fc7ff',
  paper: '#f7f9ff',
  card: '#ffffff',
  border: '#dce3f2',
  itemFrameRadius: 14,
  controlRadius: 14,
  chipRadius: 12,
  buttonRadius: 10,
  imageRadius: 0,
  modalRadius: 22,
  imageHeight: 156,
  gridGap: 22,
  artOpacity: 60,
  density: 'normal'
});
let design = { ...DAYPAY_DESIGN };

function loadDesign_() {
  try {
    const saved = JSON.parse(localStorage.getItem(DESIGN_STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') design = { ...DAYPAY_DESIGN, ...saved };
    if (design.title === '器材借用目錄') design.title = DAYPAY_DESIGN.title;
  } catch (_) { /* A malformed local preference should never stop the catalogue. */ }
}

function applyDesign_(shouldRemember = false) {
  const root = document.documentElement.style;
  root.setProperty('--night', design.night);
  root.setProperty('--accent', design.accent);
  root.setProperty('--paper', design.paper);
  root.setProperty('--card-bg', design.card);
  root.setProperty('--card-border', design.border);
  root.setProperty('--line', design.border);
  root.setProperty('--item-frame-radius', `${Number(design.itemFrameRadius)}px`);
  root.setProperty('--control-radius', `${Number(design.controlRadius)}px`);
  root.setProperty('--chip-radius', `${Number(design.chipRadius)}px`);
  root.setProperty('--button-radius', `${Number(design.buttonRadius)}px`);
  root.setProperty('--image-radius', `${Number(design.imageRadius)}px`);
  root.setProperty('--modal-radius', `${Number(design.modalRadius)}px`);
  root.setProperty('--product-height', `${Number(design.imageHeight)}px`);
  root.setProperty('--grid-gap', `${Number(design.gridGap)}px`);
  root.setProperty('--header-art-opacity', `${Number(design.artOpacity) / 100}`);
  document.body.dataset.density = design.density;
  $('#siteEyebrow').textContent = design.eyebrow || DAYPAY_DESIGN.eyebrow;
  $('#siteTitle').textContent = design.title || DAYPAY_DESIGN.title;
  $('#siteSubtitle').textContent = design.subtitle || DAYPAY_DESIGN.subtitle;
  if (shouldRemember) localStorage.setItem(DESIGN_STORAGE_KEY, JSON.stringify(design));
}

function fillDesignForm_() {
  $('#designEyebrow').value = design.eyebrow;
  $('#designTitle').value = design.title;
  $('#designSubtitle').value = design.subtitle;
  $('#designNight').value = design.night;
  $('#designAccent').value = design.accent;
  $('#designPaper').value = design.paper;
  $('#designCard').value = design.card;
  $('#designBorder').value = design.border;
  $('#designItemFrameRadius').value = design.itemFrameRadius;
  $('#designControlRadius').value = design.controlRadius;
  $('#designChipRadius').value = design.chipRadius;
  $('#designButtonRadius').value = design.buttonRadius;
  $('#designImageRadius').value = design.imageRadius;
  $('#designModalRadius').value = design.modalRadius;
  $('#designImageHeight').value = design.imageHeight;
  $('#designGridGap').value = design.gridGap;
  $('#designArtOpacity').value = design.artOpacity;
  $('#designDensity').value = design.density;
}

function readDesignForm_() {
  design = {
    eyebrow: $('#designEyebrow').value.trim() || DAYPAY_DESIGN.eyebrow,
    title: $('#designTitle').value.trim() || DAYPAY_DESIGN.title,
    subtitle: $('#designSubtitle').value.trim() || DAYPAY_DESIGN.subtitle,
    night: $('#designNight').value,
    accent: $('#designAccent').value,
    paper: $('#designPaper').value,
    card: $('#designCard').value,
    border: $('#designBorder').value,
    itemFrameRadius: Number($('#designItemFrameRadius').value),
    controlRadius: Number($('#designControlRadius').value),
    chipRadius: Number($('#designChipRadius').value),
    buttonRadius: Number($('#designButtonRadius').value),
    imageRadius: Number($('#designImageRadius').value),
    modalRadius: Number($('#designModalRadius').value),
    imageHeight: Number($('#designImageHeight').value),
    gridGap: Number($('#designGridGap').value),
    artOpacity: Number($('#designArtOpacity').value),
    density: $('#designDensity').value
  };
  applyDesign_(true);
}

function exportDesign_() {
  const blob = new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'tmu-equipment-design.json';
  link.click();
  URL.revokeObjectURL(url);
  toast('已下載設計設定檔。');
}

function itemNameParts_(itemOrName) {
  const rawName = String(typeof itemOrName === 'string' ? itemOrName : itemOrName?.name || '').trim();
  const divider = rawName.lastIndexOf('_');
  const suffixOwner = divider > 0 ? rawName.slice(divider + 1).trim() : '';
  return {
    name: divider > 0 ? rawName.slice(0, divider).trim() : rawName,
    owner: suffixOwner || (typeof itemOrName === 'object' ? String(itemOrName?.owner || '').trim() : '')
  };
}
const displayItemName_ = itemOrName => itemNameParts_(itemOrName).name.replace(/_/g, ' ');
const displayOwner_ = itemOrName => itemNameParts_(itemOrName).owner;
const SPRITE_OFFSETS = ['0%', '33.333%', '66.667%', '100%'];
const MODEL_CUTOUTS = Object.freeze({
  'Sony_FX3_課外組': 'https://www.sony.jp/products/picture/ILME-FX3_Gallery_02.jpg',
  'Sony_FX30_課外組': 'https://www.sony.co.nz/content/dam/sony/contents/global/cameras/alpha-interchangeable-lens-cameras/year2022/fx30/overview/Primary_Image.png',
  'Sony_A7M4_課外組': 'https://www.dxomark.com/wp-content/uploads/drafts/post-107409/Sony-A7-IV.png',
  'Sony_ZV-E10 II_課外組': 'https://prophotosupply.com/cdn/shop/files/ZV-E10II_front_black.png?v=1720649422&width=1445',
  'Sony_a6400_課外組': 'assets/sony-a6400-body.png',
  'Sony_RX10M4_課外組': 'https://www.kindpng.com/picc/m/52-529449_transparent-canon-80d-png-sony-cyber-shot-rx10.png',
  'Sony_A7S3_魏廷翔': 'assets/sony-a7s3-body-photo.jpg',
  'Sony_ZV-E1': 'https://store.sony.com.au/dw/image/v2/ABBC_PRD/on/demandware.static/-/Sites-sony-master-catalog/default/dw3ee9036e/images/ZVE1B/ZVE1B.png?sh=442&sm=fit&sw=442'
});
// Sony 官方 α5100（ILCE-5100Y）產品圖；以名稱包含 a5100 判斷，支援試算表不同所有者尾碼。
const SONY_A5100_OFFICIAL = 'https://www.sony.jp/products/picture/ILCE-5100.jpg';
const LENS_CUTOUTS = Object.freeze({
  // Sony、Sigma 官方產品頁的透明產品圖；每個品項各自對應，不共用通用鏡頭示意圖。
  'SONY_1635G_FE/16-35mm/F4/全片幅_鏡頭_課外組': 'https://sony.scene7.com/is/image/sonyglobalsolutions/m-Product-Intro-Plate-2-2?$productIntroPlatemobile$&fmt=png-alpha',
  'SONY_2470GMII_FE/24-70mm/F2.8/全片幅_鏡頭_課外組': 'https://www.sony.jp/products/picture/SEL2470GM2.jpg',
  'SONY_24105G_FE/24-105mm/F4/全片幅_鏡頭_課外組': 'https://www.sony.jp/products/picture/SEL24105G.jpg',
  'SONY_70200GMII_FE/70-200mm/F2.8/全片幅_鏡頭_課外組': 'https://sony.scene7.com/is/image/sonyglobalsolutions/m-02_sel70200gm2?$productIntroPlatemobile$&fmt=png-alpha',
  'Sigma_100400_FE/100-400mm/F5.6-6.3/全片幅_鏡頭_課外組': 'assets/sigma-100400-official.png',
  'SONY_2470GMI_FE/24-70mm/F2.8/全片幅_鏡頭_魏廷翔': 'https://www.sony.co.uk/image/5c7b904cc145e3dd935a46aad33ac8ba?fmt=png-alpha&wid=1578&hei=1050&bgcolor=F6F9FF'
});

function normalise(rows) {
  const grouped = new Map();
  rows.slice(1).filter(row => row[1] && row[2]).forEach(row => {
    const category = row[0] || '其他';
    const key = [category, row[2], row[3]].join('\u0000');
    const listedQuantity = Number(row[4]);
    if (grouped.has(key)) {
      const item = grouped.get(key);
      item.codes.push(row[1]);
      if (listedQuantity > 0) item.available = Math.max(item.available, listedQuantity);
      return;
    }
    grouped.set(key, {
      category: category, code: row[1], codes: [row[1]], name: row[2], owner: row[3],
      // 清單把多件同品項的數量只寫在第一列；沒有填數量的單件預設為 1。
      available: listedQuantity > 0 ? listedQuantity : 1,
      note: row[12], purpose: row[13], dispatch: row[14], storage: row[15]
    });
  });
  return [...grouped.values()].map(item => ({
    ...item,
    // 搜尋字串只在讀取清單時建立一次，輸入關鍵字時不必重複拼接 167 筆資料。
    searchText: [item.name, ...item.codes, item.owner, item.note, item.purpose, item.storage]
      .join(' ').toLowerCase()
  }));
}

function setInventory_(nextItems) {
  const fingerprint = nextItems.map(item => [item.category, item.codes.join('、'), item.name, item.owner, item.available, item.note, item.purpose, item.dispatch, item.storage].join('\u0001')).join('\u0002');
  items = nextItems;
  // 初始清單與背景更新相同時不重建卡片，避免第一次畫面剛出現又閃動一次。
  if (fingerprint === inventoryFingerprint_) return;
  inventoryFingerprint_ = fingerprint;
  setup();
}

function setup() {
  const categories = [...new Set(items.map(item => item.category))];
  const ownerSelect = $('#owner');
  const selectedOwner = ownerSelect.value;
  if (activeCategory && !categories.includes(activeCategory)) activeCategory = '';
  $('#itemCount').textContent = items.length;
  $('#categoryCount').textContent = categories.length;
  $('#categories').innerHTML = `<button class="chip${activeCategory ? '' : ' active'}" data-cat="" title="全部器材"><span class="category-icon category-all-icon" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span>全部</span></button>` + categories.map(category => {
    const sample = items.find(item => item.category === category);
    const visual = sample ? categoryPreviewMarkup_(sample) : `<span class="category-icon" aria-hidden="true">${categoryIcon_(category)}</span>`;
    return `<button class="chip${category === activeCategory ? ' active' : ''}" data-cat="${esc(category)}" title="${esc(categoryName(category))}">${visual}<span>${esc(categoryName(category))}</span></button>`;
  }).join('');
  $('#categories').onclick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    activeCategory = button.dataset.cat;
    document.querySelectorAll('.chip').forEach(chip => chip.classList.toggle('active', chip === button));
    render();
  };
  ownerSelect.innerHTML = '<option value="">所有借用單位</option>';
  [...new Set(items.map(item => item.owner).filter(Boolean))].sort().forEach(owner =>
    ownerSelect.insertAdjacentHTML('beforeend', `<option value="${esc(owner)}">${esc(owner)}</option>`));
  if ([...ownerSelect.options].some(option => option.value === selectedOwner)) ownerSelect.value = selectedOwner;
  render();
}

function filtered() {
  const query = $('#search').value.toLowerCase();
  const owner = $('#owner').value;
  return items.filter(item => (!activeCategory || item.category === activeCategory) && (!owner || item.owner === owner) &&
    (!query || item.searchText.includes(query)));
}

function cutoutCell_(item) {
  const category = categoryName(item.category);
  const name = item.name.toLowerCase();
  if (category.includes('相機')) return 1;
  if (category.includes('鏡頭')) return 2;
  if (category.includes('電池供電') || name.includes('充電')) return 4;
  if (category.includes('電池')) return 3;
  if (category.includes('記憶')) return 5;
  if (name.includes('燈管') || name.includes('棒燈') || name.includes('fiveray')) return 7;
  if (name.includes('燈架') || name.includes('腳架') || name.includes('單腳架') || name.includes('滑軌')) return 9;
  if (category.includes('燈具')) return 6;
  if (category.includes('穩定')) return 10;
  if (category.includes('腳架')) return 11;
  if (name.includes('錄音') || name.includes('h5') || name.includes('圖傳') || name.includes('螢幕') || name.includes('擷取')) return 14;
  if (name.includes('無線') || name.includes('lark') || name.includes('對講')) return 12;
  if (category.includes('收音')) return 13;
  if (category.includes('收納') || name.includes('箱') || name.includes('包')) return 15;
  return 0;
}

function displayImageScale_(item) {
  const name = item.name.toLowerCase();
  // 以 A7M4 的視覺比例為基準，再依使用者指定的展示倍率校正。
  if (name.includes('fx3') || name.includes('fx30')) return 1.22; // .94 × 1.3
  if (name.includes('zv-e10') || name.includes('zve-10') || name.includes('a5100')) return 1.41; // .94 × 1.5
  if (name.includes('a7m4') || name.includes('a6400') || name.includes('a7s3')) return .94;
  if (name.includes('24105g')) return 1.42;
  if (name.includes('2470gmii')) return 1.12;
  if (name.includes('2470gmi')) return 1.42;
  if (name.includes('70200') || name.includes('100400')) return .92;
  return 1;
}

function productImage_(item) {
  const modelImage = MODEL_CUTOUTS[item.name] || (item.name.toLowerCase().includes('a5100') ? SONY_A5100_OFFICIAL : '');
  const lensImage = LENS_CUTOUTS[item.name];
  return modelImage || lensImage || (categoryName(item.category).includes('鏡頭') ? 'assets/lens-cutout-clean-optimized.png' : '');
}

function categoryPreviewMarkup_(item) {
  // 分類列一律使用透明底器材剪影，避免原始產品圖的灰／白底出現在玻璃背景上。
  if (categoryName(item.category).includes('鏡頭')) return `<img class="category-photo category-lens-photo" src="assets/lens-cutout-clean-optimized.png" alt="" loading="lazy" decoding="async">`;
  const cell = cutoutCell_(item);
  const x = SPRITE_OFFSETS[cell % 4];
  const y = SPRITE_OFFSETS[Math.floor(cell / 4)];
  // 原圖的相機本體在格內略偏右，微調三像素讓縮圖視覺置中。
  const xNudge = categoryName(item.category).includes('相機') ? '-3px' : '0px';
  return `<span class="category-sprite" aria-hidden="true" style="--sprite-x:${x};--sprite-y:${y};--category-nudge-x:${xNudge}"></span>`;
}

function cutoutMarkup_(item) {
  const cell = cutoutCell_(item);
  const x = SPRITE_OFFSETS[cell % 4];
  const y = SPRITE_OFFSETS[Math.floor(cell / 4)];
  const modelImage = MODEL_CUTOUTS[item.name] || (item.name.toLowerCase().includes('a5100') ? SONY_A5100_OFFICIAL : '');
  const isLens = categoryName(item.category).includes('鏡頭');
  const lensImage = LENS_CUTOUTS[item.name];
  const image = productImage_(item);
  const imageClass = (modelImage || lensImage) ? 'has-model-image' : (isLens ? 'has-clean-lens' : '');
  const imageMarkup = image
    ? `<img src="${image}" alt="${esc(item.name)}" loading="lazy" decoding="async" fetchpriority="low" style="--image-scale:${displayImageScale_(item)}" onerror="this.remove();this.parentElement.classList.remove('${imageClass}')">`
    : '';
  // 有指定型號的相機或鏡頭時，CSS 會隱藏分類示意圖，避免兩張圖片重疊。
  return `<div class="product-visual ${imageClass}" role="img" aria-label="${esc(item.name)}"><span aria-hidden="true" style="--sprite-x:${x};--sprite-y:${y}"></span>${imageMarkup}</div>`;
}

function render() {
  const list = filtered();
  $('#resultText').innerHTML = `找到 <b>${list.length}</b> 項器材`;
  $('#grid').innerHTML = list.length ? list.map((item, index) => {
    const quantityOptions = Array.from({ length: item.available }, (_, quantity) => `<option value="${quantity + 1}">${quantity + 1}</option>`).join('');
    return `<article class="card" style="--reveal-index:${Math.min(index, 12)}">
    <div class="card-top"><span class="tag">${esc(categoryName(item.category))}</span>${displayOwner_(item) ? `<span class="owner-tag">所有者：${esc(displayOwner_(item))}</span>` : ''}</div>
    ${cutoutMarkup_(item)}
    <h2>${esc(displayItemName_(item))}</h2><div class="code">${esc(item.code)}</div>
    <div class="info"><span></span><span class="qty">可借 ${item.available}</span></div>
    <div class="pick"><select aria-label="${esc(displayItemName_(item))} 借用數量" data-quantity="${index}">${quantityOptions}</select><button class="action" data-add="${index}" type="button">加入借用</button></div>
    <button class="details" data-detail="${index}" type="button">查看細節 →</button></article>`;
  }).join('') : `<div class="empty">找不到符合條件的器材<br>請換個關鍵字或篩選條件。</div>`;
  $('#grid').onclick = event => {
    const add = event.target.closest('[data-add]');
    const detail = event.target.closest('[data-detail]');
    if (add) {
      playSelection_(add.closest('.card'));
      addToCart(list[Number(add.dataset.add)], Number($(`[data-quantity="${add.dataset.add}"]`).value));
    }
    if (detail) {
      playSelection_(detail.closest('.card'));
      openDetail(list[Number(detail.dataset.detail)]);
    }
  };
}

function playSelection_(element, className = 'is-selected') {
  if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.classList.remove(className);
  // 重新觸發同一個短動畫，讓每次選取都有立即且一致的回饋。
  void element.offsetWidth;
  element.classList.add(className);
  window.setTimeout(() => element.classList.remove(className), 560);
}

function openDetail(item) {
  $('#dCategory').textContent = categoryName(item.category);
  $('#dName').textContent = displayItemName_(item);
  const fields = [['所有者', displayOwner_(item)], ['財產編號', item.codes.join('、')], ['可借數量', item.available], ['檢查配件／備註', item.note], ['用途', item.purpose], ['出班收納位置', item.dispatch], ['庫藏位置', item.storage]].filter(field => field[1] !== '' && field[1] !== undefined);
  $('#detailList').innerHTML = fields.map(([label, value]) => `<div class="detail"><label>${label}</label><div>${esc(value)}</div></div>`).join('');
  $('#dialog').showModal();
}

function addToCart(item, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) return toast('請輸入有效數量。');
  if (quantity > item.available) return toast(`${displayItemName_(item)} 目前最多可借 ${item.available} 件。`);
  cart.set(item.code, { ...item, quantity });
  updateCart();
  toast(`已加入：${displayItemName_(item)}`);
}

function updateCart() {
  const count = [...cart.values()].reduce((sum, item) => sum + item.quantity, 0);
  $('#cartCount').textContent = count;
  $('#cartButton').disabled = count === 0;
}

function openCheckout() {
  if (!cart.size) return;
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  $('#checkoutForm').elements.loanStart.value = localDateValue(now);
  $('#checkoutForm').elements.expectedReturn.value = localDateValue(tomorrow);
  $('#checkoutItems').innerHTML = [...cart.values()].map(item => `<div class="photo-row">
    <strong>${esc(displayItemName_(item))} × ${item.quantity}</strong><span>${esc(item.code)}｜每一件器材各拍一張領用照片</span>
    ${photoPickers_(item, 'checkout')}
  </div>`).join('');
  clearSignature_('checkout');
  $('#checkoutDialog').showModal();
  keepModalAtTop_('checkoutDialog');
  resetTurnstile_('checkoutSecurity');
  mountTurnstile_('checkoutSecurity', 'loan-request');
}

function keepModalAtTop_(dialogId) {
  const dialog = $(`#${dialogId}`);
  const scrollArea = dialog?.querySelector('.modal-scroll');
  if (!dialog || !scrollArea) return;
  const reset = () => {
    dialog.scrollTop = 0;
    scrollArea.scrollTop = 0;
  };
  // iOS 會在顯示原生自動填寫選單後才調整捲動位置，因此要跨過幾個繪製週期再校正一次。
  reset();
  requestAnimationFrame(reset);
  [140, 420].forEach(delay => window.setTimeout(reset, delay));

  if (dialog.dataset.autofillScrollGuard === 'ready') return;
  dialog.dataset.autofillScrollGuard = 'ready';
  const restoreAfterAutofill = () => {
    requestAnimationFrame(reset);
    window.setTimeout(reset, 80);
  };
  // Safari 的聯絡人／密碼自動填寫通常會以 replacement text 事件送入欄位。
  dialog.addEventListener('input', event => {
    if (event.inputType === 'insertReplacementText') restoreAfterAutofill();
  });
  // 部分 iOS 版本不送出 inputType，改由 -webkit-autofill 動畫作為備援訊號。
  dialog.addEventListener('animationstart', event => {
    if (event.animationName === 'autofill-detected') restoreAfterAutofill();
  });
}

function photoPickers_(item, stage) {
  const attribute = stage === 'checkout' ? 'data-checkout-photo' : 'data-return-photo';
  const description = stage === 'checkout' ? '領用現況' : '歸還現況';
  return Array.from({ length: Number(item.quantity) }, (_, index) => `<label class="photo-picker"><span class="photo-picker-label">${description}照片 ${index + 1}／${item.quantity}（必填）</span><input type="file" accept="image/*" required ${attribute}="${esc(item.code)}"></label>`).join('');
}

const signaturePads_ = new Map();

function signaturePad_(stage) {
  if (signaturePads_.has(stage)) return signaturePads_.get(stage);
  const canvas = $(`#${stage}Signature`);
  const block = $(`#${stage}SignatureBlock`);
  const status = $(`#${stage}SignatureStatus`);
  const context = canvas.getContext('2d', { alpha: true });
  let drawing = false;
  let signed = false;
  let pointerId = null;

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#17243b';
  context.lineWidth = 6;

  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / Math.max(rect.width, 1),
      y: (event.clientY - rect.top) * canvas.height / Math.max(rect.height, 1)
    };
  };
  const updateState = () => {
    block.classList.toggle('is-signed', signed);
    block.classList.remove('has-error');
    status.textContent = signed ? '已完成簽名。' : '請在上方以手指或滑鼠簽名。';
  };
  const begin = event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const current = point(event);
    drawing = true;
    signed = true;
    pointerId = event.pointerId;
    if (canvas.setPointerCapture && pointerId !== undefined) canvas.setPointerCapture(pointerId);
    context.beginPath();
    context.moveTo(current.x, current.y);
    context.lineTo(current.x + 0.01, current.y + 0.01);
    context.stroke();
    updateState();
  };
  const move = event => {
    if (!drawing || (pointerId !== null && event.pointerId !== pointerId)) return;
    event.preventDefault();
    const current = point(event);
    context.lineTo(current.x, current.y);
    context.stroke();
  };
  const end = event => {
    if (!drawing || (pointerId !== null && event.pointerId !== pointerId)) return;
    drawing = false;
    if (canvas.releasePointerCapture && pointerId !== null && canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId = null;
  };
  const clear = () => {
    drawing = false;
    signed = false;
    pointerId = null;
    context.clearRect(0, 0, canvas.width, canvas.height);
    updateState();
  };
  const dataUrl = () => {
    if (!signed) {
      block.classList.add('has-error');
      status.textContent = '電子簽名為必填，請先完成簽名。';
      throw new Error('請先完成電子簽名。');
    }
    const output = document.createElement('canvas');
    output.width = canvas.width;
    output.height = canvas.height;
    const outputContext = output.getContext('2d');
    outputContext.fillStyle = '#ffffff';
    outputContext.fillRect(0, 0, output.width, output.height);
    outputContext.drawImage(canvas, 0, 0);
    return output.toDataURL('image/png');
  };

  canvas.addEventListener('pointerdown', begin);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  const api = { clear, dataUrl, isSigned: () => signed };
  signaturePads_.set(stage, api);
  updateState();
  return api;
}

function clearSignature_(stage) { signaturePad_(stage).clear(); }
function signatureDataUrl_(stage) { return signaturePad_(stage).dataUrl(); }

function localDateValue(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function openReturn(requestId = '', adminKey = '') {
  const form = $('#returnForm');
  // 直接綁定 click 時瀏覽器會傳入 PointerEvent；它不是申請編號。
  const cleanRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  const cleanAdminKey = typeof adminKey === 'string' ? adminKey : '';
  form.reset();
  $('#returnItems').innerHTML = '';
  $('#returnSignatureBlock').hidden = true;
  clearSignature_('return');
  $('#returnSubmit').hidden = true;
  $('#returnProgress').hidden = true;
  form.elements.requestId.value = cleanRequestId;
  form.elements.adminKey.value = cleanAdminKey;
  $('#returnCodeField').hidden = Boolean(cleanAdminKey);
  form.elements.returnCode.required = !cleanAdminKey;
  $('#returnDialog').showModal();
  keepModalAtTop_('returnDialog');
  if (!cleanAdminKey) {
    resetTurnstile_('returnSecurity');
    mountTurnstile_('returnSecurity', 'equipment-return');
  }
  if (cleanRequestId) lookupReturn();
}

async function fileAsDataUrl(input, profile = 'checkout') {
  const prepared = preparedPhotoData_.get(input);
  const file = input.files?.[0];
  if (prepared?.file === file && prepared.profile === profile) return prepared.task;
  const task = preparePhotoData_(input, profile);
  const entry = { file, profile, task };
  preparedPhotoData_.set(input, entry);
  try {
    return await task;
  } catch (error) {
    if (preparedPhotoData_.get(input) === entry) preparedPhotoData_.delete(input);
    throw error;
  }
}

async function preparePhotoData_(input, profile = 'checkout') {
  const file = input.files[0];
  if (!file) throw new Error('請拍攝或選擇每項器材的照片。');
  if (file.size > 20 * 1024 * 1024) throw new Error('單張原始照片請小於 20 MB。');
  // 驗收照以足夠辨識器材狀態為準；較小的檔案可明顯縮短手機上傳與 Drive 儲存時間。
  const options = profile === 'return'
    ? { longestEdge: 1024, quality: 0.62, maxBytes: 1200 * 1024 }
    : { longestEdge: 1280, quality: 0.68, maxBytes: 1800 * 1024 };
  const blob = await compressPhoto_(file, options);
  if (blob.size > options.maxBytes) throw new Error('照片壓縮後仍過大，請重新拍攝或選擇較小的照片。');
  return { blob };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
}

async function compressPhoto_(file, options) {
  if (!/^image\//i.test(file.type)) throw new Error('照片格式不正確，請重新選擇。');
  const objectUrl = URL.createObjectURL(file);
  try {
    // 直接解碼檔案，不先把原始相片轉為巨大 Base64 字串，能避免手機短暫卡住與記憶體暴增。
    const image = await new Promise((resolve, reject) => { const element = new Image(); element.onload = () => resolve(element); element.onerror = reject; element.src = objectUrl; });
    const scale = Math.min(1, options.longestEdge / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('照片壓縮失敗。')), 'image/jpeg', options.quality));
  } catch (error) {
    if (/^image\/(?:jpeg|png|webp)$/i.test(file.type) && file.size <= options.maxBytes) return file;
    throw new Error('無法處理這張照片，請改用相機重新拍攝。');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

let turnstileScript_;
const turnstileWidgets_ = new Map();

function secureApiUrl_(path) { return `${CLOUDFLARE_API_URL}${path}`; }

function loadTurnstile_() {
  if (!USING_CLOUDFLARE) return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (turnstileScript_) return turnstileScript_;
  turnstileScript_ = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('安全驗證載入失敗，請確認網路後重試。'));
    document.head.appendChild(script);
  });
  return turnstileScript_;
}

async function mountTurnstile_(elementId, action) {
  if (!USING_CLOUDFLARE) return;
  const host = $(`#${elementId}`);
  if (!host) return;
  host.hidden = false;
  await loadTurnstile_();
  if (turnstileWidgets_.has(elementId)) return;
  const id = window.turnstile.render(host, {
    sitekey: CLOUDFLARE.turnstileSiteKey,
    action,
    theme: 'light',
    size: 'flexible'
  });
  turnstileWidgets_.set(elementId, id);
}

async function turnstileToken_(elementId, action) {
  if (!USING_CLOUDFLARE) return '';
  await mountTurnstile_(elementId, action);
  const id = turnstileWidgets_.get(elementId);
  const token = id === undefined ? '' : window.turnstile.getResponse(id);
  if (!token) throw new Error('請先完成安全驗證。');
  return token;
}

function resetTurnstile_(elementId) {
  const id = turnstileWidgets_.get(elementId);
  if (USING_CLOUDFLARE && id !== undefined && window.turnstile) window.turnstile.reset(id);
}

async function secureJson_(path, body, adminKey = '') {
  const response = await fetch(secureApiUrl_(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(adminKey ? { 'X-Admin-Key': adminKey } : {}) },
    body: JSON.stringify(body)
  });
  let result;
  try { result = await response.json(); } catch (_) { throw new Error('安全資料服務回應格式錯誤。'); }
  if (!response.ok || !result.ok) throw new Error(result.message || '送出失敗。');
  return result;
}

function dataUrlBlob_(dataUrl) {
  const [header, payload] = String(dataUrl || '').split(',', 2);
  const match = header.match(/^data:(image\/(?:jpeg|png|webp));base64$/i);
  if (!match || !payload) throw new Error('照片格式不正確，請重新選擇照片。');
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1].toLowerCase() });
}

async function secureUploadPhotos_(uploadToken, stage, items) {
  let completed = 0;
  const jobs = items.flatMap(item => {
    const photos = stage === 'checkout' ? item.checkOutPhotos : item.returnPhotos;
    return photos.map((photo, index) => ({ item, photo, index }));
  });
  const total = jobs.length;
  const upload = async ({ item, photo, index }) => {
      const response = await fetch(secureApiUrl_('/api/upload'), {
        method: 'POST',
        headers: {
          'Content-Type': photo.blob.type,
          'X-Upload-Ticket': uploadToken,
          'X-Photo-Stage': stage,
          'X-Equipment-Code': item.code,
          'X-Photo-Index': String(index + 1)
        },
        body: photo.blob
      });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('照片上傳服務回應格式錯誤。'); }
      if (!response.ok || !result.ok) throw new Error(result.message || '照片上傳失敗。');
      completed++;
      const progress = stage === 'checkout' ? $('#checkoutProgress span') : $('#returnProgress span');
      if (progress) progress.textContent = `正在安全上傳照片 ${completed}／${total}，請勿關閉此頁面。`;
  };
  // 先完成第一張，確保雲端專屬資料夾已建立；其餘最多兩張並行，兼顧速度與 Drive 穩定性。
  if (jobs.length) await upload(jobs[0]);
  for (let index = 1; index < jobs.length; index += 2) await Promise.all(jobs.slice(index, index + 2).map(upload));
}

async function secureUploadSignature_(uploadToken, stage, signatureDataUrl) {
  const signature = dataUrlBlob_(signatureDataUrl);
  if (signature.type !== 'image/png') throw new Error('電子簽名格式不正確，請清除後重新簽名。');
  const progress = stage === 'checkout' ? $('#checkoutProgress span') : $('#returnProgress span');
  if (progress) progress.textContent = '正在安全上傳電子簽名，請勿關閉此頁面。';
  const response = await fetch(secureApiUrl_('/api/signature'), {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Upload-Ticket': uploadToken,
      'X-Signature-Stage': stage
    },
    body: signature
  });
  let result;
  try { result = await response.json(); } catch (_) { throw new Error('簽名上傳服務回應格式錯誤。'); }
  if (!response.ok || !result.ok) throw new Error(result.message || '電子簽名上傳失敗。');
}

async function secureUploadAssets_(uploadToken, stage, items, signatureDataUrl) {
  const jobs = items.flatMap(item => {
    const photos = stage === 'checkout' ? item.checkOutPhotos : item.returnPhotos;
    return photos.map((photo, index) => ({ item, photo, index }));
  });
  const signature = dataUrlBlob_(signatureDataUrl);
  if (signature.type !== 'image/png') throw new Error('電子簽名格式不正確，請清除後重新簽名。');
  const batches = [];
  for (let offset = 0; offset < jobs.length; offset += 6) batches.push(jobs.slice(offset, offset + 6));
  let completed = 0;
  const startedAt = performance.now();
  const uploadBatch = async (batch, batchIndex) => {
    const body = new FormData();
    body.set('metadata', JSON.stringify(batch.map(({ item, photo, index }, fileIndex) => ({
      field: `photo${fileIndex}`, code: item.code, index: index + 1, contentType: photo.blob.type
    }))));
    batch.forEach(({ photo }, index) => body.set(`photo${index}`, photo.blob, `photo-${index}.jpg`));
    if (batchIndex === 0) body.set('signature', signature, 'signature.png');
    const response = await fetch(secureApiUrl_('/api/assets'), {
      method: 'POST', headers: { 'X-Upload-Ticket': uploadToken, 'X-Asset-Stage': stage }, body
    });
    let result;
    try { result = await response.json(); } catch (_) { throw new Error('批次上傳服務回應格式錯誤。'); }
    if (!response.ok || !result.ok) throw new Error(result.message || '照片與簽名上傳失敗。');
    completed += batch.length;
    const progress = stage === 'checkout' ? $('#checkoutProgress span') : $('#returnProgress span');
    if (progress) progress.textContent = `正在安全儲存照片 ${completed}／${jobs.length}，請勿關閉此頁面。`;
  };
  for (let index = 0; index < batches.length; index += 2) {
    await Promise.all(batches.slice(index, index + 2).map((batch, relativeIndex) => uploadBatch(batch, index + relativeIndex)));
  }
  return Math.round(performance.now() - startedAt);
}

async function secureRequest_(data) {
  const totalStartedAt = performance.now();
  const turnstileToken = await turnstileToken_('checkoutSecurity', 'loan-request');
  const startStartedAt = performance.now();
  const started = await secureJson_('/api/loan/start', {
    borrower: data.borrower,
    loan: data.loan,
    items: data.items.map(item => ({ code: item.code, name: item.name, quantity: item.quantity })),
    turnstileToken
  });
  const startMs = Math.round(performance.now() - startStartedAt);
  const uploadMs = await secureUploadAssets_(started.uploadToken, 'checkout', data.items, data.signature);
  const finalizeStartedAt = performance.now();
  const result = await secureJson_('/api/loan/finalize', { uploadToken: started.uploadToken });
  const timings = { startMs, uploadMs, finalizeMs: Math.round(performance.now() - finalizeStartedAt), totalMs: Math.round(performance.now() - totalStartedAt) };
  console.info('[TMU upload timing]', timings);
  return { ...result, timings };
}

async function secureReturn_(data) {
  const totalStartedAt = performance.now();
  const isAdmin = Boolean(data.adminKey);
  const startStartedAt = performance.now();
  const started = await secureJson_('/api/return/start', {
    requestId: data.requestId,
    returnCode: data.returnCode,
    ...(isAdmin ? {} : { turnstileToken: await turnstileToken_('returnSecurity', 'equipment-return') })
  }, data.adminKey);
  const startMs = Math.round(performance.now() - startStartedAt);
  const uploadMs = await secureUploadAssets_(started.uploadToken, 'return', data.items, data.signature);
  const finalizeStartedAt = performance.now();
  const result = await secureJson_('/api/return/finalize', { uploadToken: started.uploadToken }, data.adminKey);
  const timings = { startMs, uploadMs, finalizeMs: Math.round(performance.now() - finalizeStartedAt), totalMs: Math.round(performance.now() - totalStartedAt) };
  console.info('[TMU upload timing]', timings);
  return { ...result, timings };
}

async function post(data) {
  if (USING_CLOUDFLARE) {
    if (data.action === 'request') return secureRequest_(data);
    if (data.action === 'lookup') return secureJson_('/api/return/lookup', { requestId: data.requestId, returnCode: data.returnCode }, data.adminKey);
    if (data.action === 'return') return secureReturn_(data);
    if (data.action === 'manageSearch') return secureJson_('/api/manage/search', { name: data.name }, data.adminKey);
    throw new Error('不支援的資料操作。');
  }
  if (!API_URL) throw new Error('系統尚未連接資料庫。請先依 apps-script/README.md 部署後端，並把 Web App /exec 網址填入 app.js 的 API_URL。');
  const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(data) });
  const body = await response.text();
  let result;
  try { result = JSON.parse(body); } catch (error) {
    if (data.action === 'manageSearch') throw new Error('管理功能的後端尚未更新。請依 apps-script/README.md 貼上新版 Code.gs、設定 ADMIN_KEY，並重新部署。');
    throw new Error('系統回應格式錯誤，請確認 Apps Script 已重新部署。');
  }
  if (!result.ok) throw new Error(result.message || '送出失敗。');
  return result;
}

async function lookupReturn() {
  if (!API_URL) return toast('請先完成 Apps Script 後端部署。');
  const form = new FormData($('#returnForm'));
  const requestId = String(form.get('requestId') || '').trim();
  const returnCode = String(form.get('returnCode') || '').trim();
  const adminKey = String(form.get('adminKey') || '');
  if (!requestId) return toast('請先填寫申請編號。');
  if (!adminKey && !returnCode) return toast('請輸入確認信中的歸還驗證碼。');
  try {
    const result = await post({ action: 'lookup', requestId, returnCode, adminKey });
    const outstanding = result.items.filter(item => !item.returned);
    if (!outstanding.length) return toast('這筆申請沒有待歸還的器材。');
    $('#returnItems').innerHTML = outstanding.map(item => `<div class="photo-row"><strong>${esc(displayItemName_(item))} × ${item.quantity}</strong><span>${esc(item.code)}｜每一件器材各拍一張歸還照片</span>${photoPickers_(item, 'return')}</div>`).join('');
    $('#returnSignatureBlock').hidden = false;
    clearSignature_('return');
    $('#returnSubmit').hidden = false;
    keepModalAtTop_('returnDialog');
  } catch (error) { toast(error.message); }
}

function openManager() {
  managerAdminKey_ = '';
  $('#managerResults').innerHTML = '';
  $('#manageDialog').showModal();
  keepModalAtTop_('manageDialog');
}

function showSuccess(result, borrowerEmail, requestedItems) {
  const emailNote = result.emailSent ? `確認信已寄到 <b>${esc(borrowerEmail)}</b>。` : result.emailQueued ? `申請已儲存，確認信正在背景寄送至 <b>${esc(borrowerEmail)}</b>；請先記下以下資料。` : '申請已儲存，但確認信寄送失敗；請立即記下以下資料。';
  $('#successContent').innerHTML = `<p class="note">申請資料已完成儲存，${emailNote}</p>
    <div class="manager-result"><h3>借用編號：${esc(result.requestId)}</h3><p><b>歸還驗證碼：${esc(result.returnCode)}</b></p><p>歸還時須同時輸入借用編號與驗證碼，請勿分享給他人。</p>
    <p>${requestedItems.map(item => `${esc(displayItemName_(item))} × ${item.quantity}`).join('、')}</p></div>`;
  $('#successDialog').showModal();
}

async function searchManager() {
  const form = new FormData($('#manageForm'));
  const adminKey = String(form.get('adminKey') || '');
  const name = String(form.get('name') || '').trim();
  if (!adminKey || !name) return toast('請填寫管理密碼與借用人姓名。');
  const results = $('#managerResults');
  results.innerHTML = '<p class="note">正在搜尋借用紀錄…</p>';
  try {
    const result = await post({ action: 'manageSearch', adminKey, name });
    managerAdminKey_ = adminKey;
    const requests = result.requests || [];
    results.innerHTML = requests.length ? requests.map(request => `<article class="manager-result">
      <h3>${esc(request.name)} <span class="tag">${esc(request.status)}</span></h3>
      <p>借用日期：${esc(request.loanStart || '未填')}</p>
      <p>預計歸還日期：${esc(request.expectedReturn || '未填')}</p>
      <p>${request.items.map(item => `${esc(displayItemName_(item))} × ${esc(item.quantity)}`).join('、')}</p>
      <button class="action" type="button" data-managed-return="${esc(request.requestId)}">辦理這筆歸還</button>
    </article>`).join('') : '<p class="note">找不到尚未歸還、姓名符合的借用紀錄。</p>';
  } catch (error) {
    results.innerHTML = '';
    toast(error.message);
  }
}

function toast(message) { const element = $('#toast'); element.textContent = message; element.hidden = false; clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => element.hidden = true, 5000); }

let searchRenderTimer_;
$('#search').oninput = event => {
  window.clearTimeout(searchRenderTimer_);
  // 避免每打一個字就重建全部卡片；清空搜尋時仍立即回到完整清單。
  if (!event.target.value) return render();
  searchRenderTimer_ = window.setTimeout(render, 120);
};
$('#owner').onchange = render;
document.addEventListener('change', event => {
  const select = event.target.closest('[data-quantity], #owner');
  if (!select) return;
  select.classList.remove('is-selected');
  requestAnimationFrame(() => select.classList.add('is-selected'));
  window.setTimeout(() => select.classList.remove('is-selected'), 240);
});
$('.close').onclick = () => $('#dialog').close();
$('#dialog').onclick = event => { if (event.target === $('#dialog')) $('#dialog').close(); };
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(`#${button.dataset.close}`).close());
$('#cartButton').onclick = openCheckout;
$('#returnButton').onclick = () => openReturn();
$('#lookupButton').onclick = lookupReturn;
$('#manageButton').onclick = openManager;
$('#manageSearchButton').onclick = searchManager;
$('#designButton').onclick = () => {
  fillDesignForm_();
  $('#designDialog').showModal();
};
document.querySelectorAll('#designDialog input, #designDialog select').forEach(control => {
  control.addEventListener('input', readDesignForm_);
  control.addEventListener('change', readDesignForm_);
});
$('#designReset').onclick = () => {
  design = { ...DAYPAY_DESIGN };
  fillDesignForm_();
  applyDesign_(true);
  toast('已恢復 DayPay 參考預設。');
};
$('#designExport').onclick = exportDesign_;
$('#managerResults').onclick = event => {
  const button = event.target.closest('[data-managed-return]');
  if (!button) return;
  $('#manageDialog').close();
  openReturn(button.dataset.managedReturn, managerAdminKey_);
};

document.addEventListener('click', event => {
  const clearButton = event.target.closest('[data-clear-signature]');
  if (clearButton) clearSignature_(clearButton.dataset.clearSignature);
});

let lastScrollPosition_ = window.scrollY;
window.addEventListener('scroll', () => {
  const categories = $('#categories');
  const currentPosition = window.scrollY;
  if (Math.abs(currentPosition - lastScrollPosition_) < 8) return;
  // 分類列尚未吸附到頂端時不可提前向上位移，否則手機會蓋住搜尋控制區。
  const isPinnedToTop = categories.getBoundingClientRect().top <= 1;
  if (currentPosition > lastScrollPosition_ && currentPosition > 120 && isPinnedToTop) categories.classList.add('is-hidden');
  else categories.classList.remove('is-hidden');
  lastScrollPosition_ = currentPosition;
}, { passive: true });

document.addEventListener('change', event => {
  const input = event.target;
  if (!input.matches('[data-checkout-photo], [data-return-photo]')) return;
  const picker = input.closest('.photo-picker');
  const label = picker?.querySelector('.photo-picker-label');
  if (!input.files?.length) {
    photoPreparationTokens_.delete(input);
    preparedPhotoData_.delete(input);
    if (label) label.textContent = '請選擇照片（必填）';
    picker?.classList.remove('is-uploaded');
    return;
  }
  const profile = input.matches('[data-return-photo]') ? 'return' : 'checkout';
  const token = Symbol('photo-preparation');
  photoPreparationTokens_.set(input, token);
  preparedPhotoData_.delete(input);
  if (label) label.textContent = '正在準備照片…';
  picker?.classList.remove('is-uploaded');
  fileAsDataUrl(input, profile).then(() => {
    if (photoPreparationTokens_.get(input) !== token) return;
    if (label) label.textContent = '照片已準備好，送出時上傳';
    if (picker) {
      picker.classList.remove('is-uploaded');
      requestAnimationFrame(() => picker.classList.add('is-uploaded'));
    }
  }).catch(error => {
    if (photoPreparationTokens_.get(input) !== token) return;
    if (label) label.textContent = '請重新選擇照片（必填）';
    toast(error.message);
  });
});

$('#checkoutForm').onsubmit = async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  if (!validateBorrower_(formElement)) return;
  let signature;
  try { signature = signatureDataUrl_('checkout'); } catch (error) { toast(error.message); return; }
  const submit = $('#checkoutSubmit');
  submit.disabled = true;
  submit.textContent = '正在整理照片並送出…';
  $('#checkoutProgress').hidden = false;
  try {
    const form = new FormData(formElement);
    const selectedItems = [...cart.values()];
    const requestItems = await Promise.all(selectedItems.map(async item => ({ ...item, checkOutPhotos: await Promise.all([...document.querySelectorAll(`[data-checkout-photo="${CSS.escape(item.code)}"]`)].map(input => fileAsDataUrl(input, 'checkout'))) })));
    const result = await post({ action: 'request', borrower: { name: form.get('name').trim(), studentId: form.get('studentId').trim(), phone: form.get('phone').trim(), email: form.get('email').trim() }, loan: { start: form.get('loanStart'), expectedReturn: form.get('expectedReturn') }, items: requestItems, signature });
    const email = form.get('email').trim();
    cart.clear(); updateCart(); $('#checkoutDialog').close(); formElement.reset(); clearSignature_('checkout'); showSuccess(result, email, selectedItems);
  } catch (error) { resetTurnstile_('checkoutSecurity'); toast(error.message); }
  finally { $('#checkoutProgress').hidden = true; submit.disabled = false; submit.textContent = '送出借用申請'; }
};

$('#returnForm').onsubmit = async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  if (!formElement.checkValidity()) return formElement.reportValidity();
  let signature;
  try { signature = signatureDataUrl_('return'); } catch (error) { toast(error.message); return; }
  const submit = $('#returnSubmit');
  submit.disabled = true;
  submit.textContent = '處理中…';
  $('#returnProgress').hidden = false;
  try {
    const form = new FormData(formElement);
    const photoInputs = new Map();
    document.querySelectorAll('[data-return-photo]').forEach(input => {
      const code = input.dataset.returnPhoto;
      if (!photoInputs.has(code)) photoInputs.set(code, []);
      photoInputs.get(code).push(input);
    });
    const returnItems = await Promise.all([...photoInputs].map(async ([code, inputs]) => ({ code, returnPhotos: await Promise.all(inputs.map(input => fileAsDataUrl(input, 'return'))) })));
    const result = await post({ action: 'return', requestId: form.get('requestId'), returnCode: form.get('returnCode'), adminKey: form.get('adminKey'), items: returnItems, signature });
    $('#returnDialog').close(); formElement.reset(); clearSignature_('return'); toast(result.message);
  } catch (error) { if (!formElement.elements.adminKey.value) resetTurnstile_('returnSecurity'); toast(error.message); }
  finally {
    $('#returnProgress').hidden = true;
    submit.disabled = false;
    submit.textContent = '完成歸還登記';
  }
};

function validateBorrower_(formElement) {
  if (!formElement.checkValidity()) {
    formElement.reportValidity();
    return false;
  }
  const phone = formElement.elements.phone;
  const compactPhone = phone.value.replace(/[\s()\-]/g, '');
  const validTaiwanPhone = /^(?:\+8869\d{8}|008869\d{8}|09\d{8}|0\d{8,10})$/.test(compactPhone);
  phone.setCustomValidity(validTaiwanPhone ? '' : '請填寫有效的台灣電話號碼，例如 0912-345-678。');
  if (!validTaiwanPhone) {
    phone.reportValidity();
    return false;
  }
  return true;
}

$('#checkoutForm').elements.phone.addEventListener('input', event => event.target.setCustomValidity(''));

loadDesign_();
applyDesign_();

let hasInventoryCache_ = false;

function saveInventoryCache_(inventory) {
  try {
    localStorage.setItem(INVENTORY_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: inventory }));
  } catch (_) { /* 儲存空間不足時仍可直接讀取線上資料。 */ }
}

function loadInventoryCache_() {
  try {
    const cached = JSON.parse(localStorage.getItem(INVENTORY_CACHE_KEY) || 'null');
    if (!cached || !Array.isArray(cached.items) || Date.now() - Number(cached.savedAt) > INVENTORY_CACHE_MAX_AGE) return null;
    return cached.items;
  } catch (_) { return null; }
}

function loadError() {
  if (hasInventoryCache_) return toast('暫時無法更新器材資料，已先顯示最近一次資料。');
  $('#grid').innerHTML = '<div class="empty">目前無法載入器材資料，請稍後重新整理。</div>';
  $('#resultText').textContent = '載入失敗';
}

const cachedInventory = loadInventoryCache_();
const seededInventory = Array.isArray(window.INVENTORY_SEED_ROWS)
  ? normalise([[], ...window.INVENTORY_SEED_ROWS])
  : null;
const initialInventory = cachedInventory || seededInventory;
if (initialInventory) {
  hasInventoryCache_ = true;
  setInventory_(initialInventory);
}

async function refreshInventory_() {
  if (!USING_CLOUDFLARE) return;
  try {
    const response = await fetch(secureApiUrl_('/api/inventory'), { headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok || !result.ok || !Array.isArray(result.rows)) throw new Error(result.message || '器材清單回應異常。');
    const inventoryRows = result.rows.filter(row => row[1] && row[2] && row[1] !== '財產編號' && row[2] !== '器材');
    const latestInventory = normalise([[], ...inventoryRows]);
    saveInventoryCache_(latestInventory);
    setInventory_(latestInventory);
  } catch (error) {
    loadError();
  }
}

refreshInventory_();
