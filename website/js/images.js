// js/images.js, BU Image + Card manager
const CACHE_VERSION   = 1;
const IMG_CACHE_KEY   = "bu_img_cache_v" + CACHE_VERSION;
const TRAIT_CACHE_KEY = "bu_trait_cache_v" + CACHE_VERSION;
const IMG_MEM    = new Map();
const TRAIT_MEM  = new Map();
const META_PEND  = new Map();
const QUEUE = [];
let RUNNING = 0;
const MAX_CONCURRENCY = 4;

function _loadCache() {
  try { const raw = localStorage.getItem(IMG_CACHE_KEY); if (raw) for (const [k,v] of Object.entries(JSON.parse(raw))) IMG_MEM.set(Number(k),v); } catch {}
  try { const raw = localStorage.getItem(TRAIT_CACHE_KEY); if (raw) for (const [k,v] of Object.entries(JSON.parse(raw))) TRAIT_MEM.set(Number(k),v); } catch {}
}
let _saveTimer = null;
function _saveCache() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const imgObj = {}, traitObj = {};
      for (const [k,v] of [...IMG_MEM.entries()].slice(-400))   imgObj[k]=v;
      for (const [k,v] of [...TRAIT_MEM.entries()].slice(-400)) traitObj[k]=v;
      localStorage.setItem(IMG_CACHE_KEY, JSON.stringify(imgObj));
      localStorage.setItem(TRAIT_CACHE_KEY, JSON.stringify(traitObj));
    } catch(e) { if(e.name==="QuotaExceededError") { try { localStorage.removeItem(IMG_CACHE_KEY); localStorage.removeItem(TRAIT_CACHE_KEY); } catch {} } }
  }, 600);
}

const LEGEND_SET = new Set(window.BU_CONFIG.collection.legends);
function rarityFor(tokenId) { return LEGEND_SET.has(Number(tokenId)) ? "legend" : "normal"; }

async function _processQueue() {
  while (RUNNING < MAX_CONCURRENCY && QUEUE.length > 0) {
    const job = QUEUE.shift(); RUNNING++;
    _fetchMeta(job.tokenId).then(m => job.resolve(m)).catch(e => job.reject(e)).finally(() => { RUNNING--; _processQueue(); });
  }
}
function _decodeBase64Json(uri) {
  const prefix = "data:application/json;base64,";
  if (!uri || !uri.startsWith(prefix)) return null;
  try { return JSON.parse(atob(uri.slice(prefix.length))); } catch { return null; }
}
async function _fetchMeta(tokenId) {
  if (!window.BU.configIsLive()) return { image: "", attributes: [] };
  const renderer = window.BU.readRenderer();
  const timeoutP = new Promise((_,rej) => setTimeout(() => rej(new Error("RPC timeout")), 15_000));
  let uri = "";
  try { uri = await Promise.race([renderer.tokenURI(tokenId), timeoutP]); }
  catch(e) { console.warn("[img] tokenURI failed for #"+tokenId, e.message); return { image:"", attributes:[] }; }
  const meta = _decodeBase64Json(uri);
  if (!meta) { IMG_MEM.set(tokenId,""); TRAIT_MEM.set(tokenId,[]); _saveCache(); return {image:"",attributes:[]}; }
  const image = meta.image||"", attrs = Array.isArray(meta.attributes)?meta.attributes:[];
  IMG_MEM.set(tokenId,image); TRAIT_MEM.set(tokenId,attrs); _saveCache();
  return { image, attributes: attrs };
}
async function _getMeta(tokenId) {
  tokenId = Number(tokenId);
  if (IMG_MEM.has(tokenId) && TRAIT_MEM.has(tokenId)) return { image: IMG_MEM.get(tokenId), attributes: TRAIT_MEM.get(tokenId) };
  if (META_PEND.has(tokenId)) return META_PEND.get(tokenId);
  const p = new Promise((resolve,reject) => { QUEUE.push({tokenId,resolve,reject}); _processQueue(); });
  META_PEND.set(tokenId,p);
  try { return await p; } finally { META_PEND.delete(tokenId); }
}

function get(tokenId)             { return _getMeta(tokenId).then(m => m.image); }
function getCached(tokenId)       { return IMG_MEM.get(Number(tokenId)); }
function getTraits(tokenId)       { return _getMeta(tokenId).then(m => m.attributes); }
function getTraitsCached(tokenId) { return TRAIT_MEM.get(Number(tokenId)); }

let _observer = null;
function _ensureObserver() {
  if (_observer) return _observer;
  if (typeof IntersectionObserver === "undefined") return null;
  _observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const card = e.target, id = Number(card.dataset.tokenId);
      if (!id) continue;
      _observer.unobserve(card); _hydrateCard(card, id);
    }
  }, { rootMargin: "250px" });
  return _observer;
}
async function _hydrateCard(card, id) {
  try {
    const meta = await _getMeta(id);
    if (Number(card.dataset.tokenId) !== id) return;
    if (meta.image) { const img = card.querySelector(".nft-card-image img"); if (img) { img.src=meta.image; img.classList.add("loaded"); } }
    if (meta.attributes && meta.attributes.length > 0) _renderTraitsInto(card, meta.attributes);
  } catch {}
}
function _renderTraitsInto(card, attrs) {
  const container = card.querySelector(".nft-card-traits"); if (!container) return;
  const pairs = attrs.map(a => ({label:a.trait_type||"",value:String(a.value||"")})).filter(p=>p.label&&p.value);
  if (pairs.length === 0) { container.innerHTML = `<div class="muted">No traits</div>`; return; }
  container.classList.remove("empty");
  container.innerHTML = pairs.slice(0,6).map(p=>`<div class="nft-card-trait"><span class="t-name">${escapeHtml(p.label)}</span><span class="t-value">${escapeHtml(p.value)}</span></div>`).join("");
}
function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

function card(tokenId, opts = {}) {
  tokenId = Number(tokenId);
  const state = opts.state||"idle", rarity = opts.rarity||rarityFor(tokenId);
  const hideId = !!opts.hideId, openOnClick = !!opts.openOnClick;
  const rarityLabelOverride = opts.rarityLabel;
  const node = document.createElement("div");
  node.className = `nft-card ${rarity}`; node.dataset.tokenId = String(tokenId);
  if (state==="staked") node.classList.add("locked");
  const rarityLabel = rarityLabelOverride || (rarity==="legend" ? "Legendary" : "Common");
  const idLine = hideId ? `<div class="nft-card-id muted">Unrevealed</div>` : `<div class="nft-card-id">#${String(tokenId).padStart(4,"0")}</div>`;
  node.innerHTML = `${state==="staked"?`<span class="lock-mark">⛓</span>`:""}
    <div class="nft-card-image">
      <div class="placeholder"><svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 8 L48 18 L48 38 L32 56 L16 38 L16 18 Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="25" cy="28" r="3.5" fill="currentColor"/><circle cx="39" cy="28" r="3.5" fill="currentColor"/><path d="M24 40 L32 36 L40 40" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg></div>
      <img alt="BasedUndead #${tokenId}" loading="lazy" decoding="async">
    </div>
    <div class="nft-card-body">
      <div class="nft-card-header">${idLine}<span class="nft-card-rarity">${rarityLabel}</span></div>
      <div class="nft-card-traits empty"><div class="muted">Loading traits…</div></div>
    </div>`;
  const img = node.querySelector(".nft-card-image img");
  const cachedImg = IMG_MEM.get(tokenId);
  if (cachedImg) { img.src=cachedImg; img.classList.add("loaded"); }
  else if (cachedImg !== "") { const obs = _ensureObserver(); if (obs) obs.observe(node); else _hydrateCard(node,tokenId); }
  const cachedTraits = TRAIT_MEM.get(tokenId);
  if (cachedTraits && cachedTraits.length > 0) _renderTraitsInto(node, cachedTraits);
  node.addEventListener("click", () => {
    if (opts.selectable) {
      const selected = !node.classList.contains("selected");
      if (selected) node.classList.add("selected"); else node.classList.remove("selected");
      if (opts.onSelect) opts.onSelect(tokenId, selected);
    } else if (openOnClick && !hideId) { if (window.BUUI?.openNFTModal) window.BUUI.openNFTModal(tokenId); }
    else if (openOnClick && hideId) { node.animate([{transform:"translateY(-6px) scale(1.02)"},{transform:"translateY(0) scale(1)"}],{duration:320,easing:"cubic-bezier(.4,0,.2,1)"}); }
  });
  return node;
}

function randomTokenIds(count, excludeLegends = false) {
  const supply = window.BU_CONFIG.collection.totalSupply, out = new Set();
  while (out.size < count) { const id = Math.floor(Math.random()*supply)+1; if (excludeLegends && LEGEND_SET.has(id)) continue; out.add(id); }
  return [...out];
}
function legendIds() { return [...window.BU_CONFIG.collection.legends]; }

_loadCache();
window.BUImages = { get, getCached, getTraits, getTraitsCached, card, rarityFor, randomTokenIds, legendIds };
