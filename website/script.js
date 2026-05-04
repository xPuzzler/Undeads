/* ==========================================================
   BASED UNDEADS — script.js (upgraded)
   Powers: index.html
   - Sales tracker (1d / 7d / 30d via OpenSea events API)
   - Floor listings
   - Featured NFT scroller
   - About visual grid
   - Custom cursor + scroll progress
   - Mobile nav
   ========================================================== */

// Network info comes from config.js (window.NETWORK). Set ACTIVE_NETWORK there.
const NET = window.NETWORK || {};
const CONFIG = {
  OPENSEA_API_KEY: null,
  ALCHEMY_API_KEY: null,
  CONTRACT: NET.NFT_ADDRESS,
  OPENSEA_SLUG: NET.collectionSlug || 'basedundeads',
  OPENSEA_API_HOST: NET.openseaApiHost || 'https://api.opensea.io',
  OPENSEA_WEB_BASE: NET.openseaWebBase || 'https://opensea.io/assets/base',
  CHAIN_SLUG: NET.openseaChain || 'base',
};

// ===========================================================
// RENDERER IMAGE CACHE
// Every token is fetched from the renderer exactly once.
// All three sections (featured, floor, sales) share this cache.
// ===========================================================
const _imgCache   = {};  // tokenId → image data-url
const _imgPending = {};  // dedup: parallel requests share one RPC call

async function getRendererImage(tokenId) {
  const id = Number(tokenId);
  if (_imgCache[id])   return _imgCache[id];
  if (_imgPending[id]) return _imgPending[id];

  _imgPending[id] = (async () => {
    const useFallback = !NET.rendererAddress && window.FEATURED_FALLBACK;
    const renderer = useFallback ? window.FEATURED_FALLBACK.rendererAddress : NET.rendererAddress;
    const rpcUrl   = useFallback ? window.FEATURED_FALLBACK.rpcUrl          : NET.rpcUrl;
    if (!renderer || !rpcUrl) throw new Error('no renderer');

    const data = '0xc87b56dd' + u256(id);
    const raw  = await rpcCallTo(rpcUrl, 'eth_call', [{ to: renderer, data }, 'latest']);
    const uri  = abiDecodeString(raw);
    const b64  = uri.replace(/^data:application\/json;base64,/, '');
    const json = JSON.parse(atob(b64));
    _imgCache[id] = json.image || '';
    delete _imgPending[id];
    return _imgCache[id];
  })();

  return _imgPending[id];
}

// Call after innerHTML is set. Finds every img[data-token] and
// replaces its src with the renderer image, one at a time (150ms gap).
async function injectRendererImages(container) {
  const imgs = Array.from(container.querySelectorAll('img[data-token]'));
  for (const img of imgs) {
    const tid = img.dataset.token;
    if (!tid) continue;
    getRendererImage(tid)
      .then(src => { if (src && img.isConnected) img.src = src; })
      .catch(() => {});
    await new Promise(r => setTimeout(r, 150));
  }
}

// ===========================================================
// 1. API KEY LOADER
// ===========================================================
async function initializeAPIKeys() {
  try {
    const r = await fetch('/.netlify/functions/api-keys');
    if (!r.ok) throw new Error('key fetch failed');
    const d = await r.json();
    if (d.apiKeys) {
      CONFIG.OPENSEA_API_KEY = Array.isArray(d.apiKeys.opensea) ? d.apiKeys.opensea[0] : d.apiKeys.opensea;
      CONFIG.ALCHEMY_API_KEY = d.apiKeys.alchemy;
    }
    if (d.rpcUrl) {
      NET.rpcUrl = d.rpcUrl;
      console.log('[script] RPC upgraded to Alchemy:', d.rpcUrl.split('/v2/')[0]);
    }
    console.log('✓ API keys loaded');
    return true;
  } catch (e) {
    console.warn('⚠ API keys not available — some features degraded.', e.message);
    return false;
  }
}

// ===========================================================
// 2. NOTIFICATIONS
// ===========================================================
function notify(msg, type = 'info') {
  const old = document.querySelector('.notification');
  if (old) old.remove();
  const n = document.createElement('div');
  n.className = `notification ${type}`;
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3500);
}

// ===========================================================
// 3. CUSTOM CURSOR
// ===========================================================
(function cursorInit() {
  const cursor = document.querySelector('.cursor');
  const dot = document.querySelector('.cursor-dot');
  if (!cursor || !dot) return;

  let mx = 0, my = 0, cx = 0, cy = 0;
  (function loop() {
    cx += (mx - cx) * 0.12;
    cy += (my - cy) * 0.12;
    cursor.style.transform = `translate(${cx - 10}px, ${cy - 10}px)`;
    requestAnimationFrame(loop);
  })();
  document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    dot.style.transform = `translate(${mx - 2}px, ${my - 2}px)`;
  }, { passive: true });
  document.addEventListener('mouseover', e => {
    if (e.target.closest('a, button, input, .sales-tab, .sale-card, .floor-item'))
      cursor.classList.add('hover');
  }, { passive: true });
  document.addEventListener('mouseout', e => {
    if (e.target.closest('a, button, input, .sales-tab, .sale-card, .floor-item'))
      cursor.classList.remove('hover');
  }, { passive: true });
})();

// ===========================================================
// 4. SCROLL PROGRESS
// ===========================================================
(function scrollProgress() {
  const bar = document.querySelector('.scroll-progress');
  if (!bar) return;
  window.addEventListener('scroll', () => {
    const h = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    bar.style.width = ((window.pageYOffset / h) * 100) + '%';
  });
})();

// ===========================================================
// 5. UTILITIES
// ===========================================================
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts * 1000) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function proxyImage(url) {
  if (!url) return '';
  if (url.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + url.slice(7);
  if (url.startsWith('ar://'))   return 'https://arweave.net/' + url.slice(5);
  return url;
}

// ===========================================================
// 6. SALES TRACKER (NEW FEATURE)
// ===========================================================
async function fetchOpenSeaEvents(eventType, occurredAfter, limit = 50) {
  // OpenSea v2: /api/v2/events/collection/{slug}?event_type=sale&after=unixts
  const params = new URLSearchParams();
  params.append('event_type', eventType);
  if (occurredAfter) params.append('after', occurredAfter);
  params.append('limit', limit);

  const url = `${CONFIG.OPENSEA_API_HOST}/api/v2/events/collection/${CONFIG.OPENSEA_SLUG}?${params}`;
  try {
    const r = await fetch(url, {
      headers: { 'accept': 'application/json', 'x-api-key': CONFIG.OPENSEA_API_KEY }
    });
    if (!r.ok) throw new Error(`OpenSea events ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error('Event fetch error:', e);
    return null;
  }
}

async function loadSalesForRange(days) {
  const after = Math.floor((Date.now() / 1000) - days * 86400);
  const allEvents = [];
  let next = null;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      event_type: 'sale',
      after: after.toString(),
      limit: '50',
    });
    if (next) params.append('next', next);
    const url = `${CONFIG.OPENSEA_API_HOST}/api/v2/events/collection/${CONFIG.OPENSEA_SLUG}?${params}`;
    try {
      const r = await fetch(url, {
        headers: { 'accept': 'application/json', 'x-api-key': CONFIG.OPENSEA_API_KEY }
      });
      if (!r.ok) break;
      const d = await r.json();
      if (d.asset_events) allEvents.push(...d.asset_events);
      next = d.next;
      if (!next) break;
      await new Promise(res => setTimeout(res, 250));
    } catch (e) { break; }
  }

  return allEvents;
}

function renderSaleCard(ev) {
  const nft = ev.nft || {};
  const tokenId = nft.identifier || '?';
  const img = proxyImage(nft.image_url || nft.display_image_url || '');
  const name = nft.name || 'Undead #' + tokenId;
  const payment = ev.payment || {};
  const price = payment.quantity
    ? (parseFloat(payment.quantity) / Math.pow(10, payment.decimals || 18)).toFixed(4)
    : '—';
  const symbol = payment.symbol || 'ETH';
  const openseaUrl = `${CONFIG.OPENSEA_WEB_BASE}/${CONFIG.CONTRACT}/${tokenId}`;
  const ts = ev.event_timestamp || ev.closing_date || Math.floor(Date.now()/1000);

  return `
    <a href="${openseaUrl}" target="_blank" class="sale-card">
      <img src="https://placehold.co/220x220/0a0a0a/00ff88/png?text=%23${tokenId}" alt="${name}" data-token="${tokenId}" loading="lazy">
      <span class="sale-card-badge">SOLD</span>
      <div class="sale-card-body">
        <div class="sale-card-id">#${tokenId}</div>
        <div class="sale-card-price">${price} ${symbol}</div>
        <div class="sale-card-time">${timeAgo(ts)}</div>
      </div>
    </a>
  `;
}

async function renderSalesForRange(days) {
  const containerId = `salesPanel-${days}`;
  const panel = document.getElementById(containerId);
  if (!panel) return;

  // If 1-day, render the scroller + stats
  const isOneDay = days === 1;

  if (isOneDay) {
    const scroller = document.getElementById('salesScroller1d');
    if (scroller) scroller.innerHTML = '<div class="sales-loading"><i class="fas fa-spinner fa-spin"></i> Loading sales...</div>';
  }

  const events = await loadSalesForRange(days);

  let totalVolume = 0;
  const uniqueBuyers = new Set();
  (events || []).forEach(ev => {
    const p = ev.payment || {};
    if (p.quantity) {
      totalVolume += parseFloat(p.quantity) / Math.pow(10, p.decimals || 18);
    }
    if (ev.buyer) uniqueBuyers.add(ev.buyer.toLowerCase());
  });

  const count = events ? events.length : 0;

  if (days === 1) {
    document.getElementById('stat-1d-count').textContent = count;
    document.getElementById('stat-1d-volume').textContent = totalVolume.toFixed(3);
    document.getElementById('stat-1d-avg').textContent = count > 0 ? (totalVolume / count).toFixed(4) + ' Ξ' : '—';
    // Floor loaded separately
    const scroller = document.getElementById('salesScroller1d');
    if (scroller) {
      if (count === 0) {
        scroller.innerHTML = '<div class="sales-loading" style="width:100%">No sales in the last 24 hours yet.</div>';
      } else {
        scroller.innerHTML = events.slice(0, 30).map(renderSaleCard).join('');
        injectRendererImages(scroller);
      }
    }
  } else if (days === 7) {
    document.getElementById('stat-7d-count').textContent = count;
    document.getElementById('stat-7d-volume').textContent = totalVolume.toFixed(2) + ' Ξ';
    document.getElementById('stat-7d-unique').textContent = uniqueBuyers.size;
  } else if (days === 30) {
    document.getElementById('stat-30d-count').textContent = count;
    document.getElementById('stat-30d-volume').textContent = totalVolume.toFixed(2) + ' Ξ';
    document.getElementById('stat-30d-unique').textContent = uniqueBuyers.size;
  }
}

async function loadCollectionStats() {
  try {
    const r = await fetch(`${CONFIG.OPENSEA_API_HOST}/api/v2/collections/${CONFIG.OPENSEA_SLUG}/stats`, {
      headers: { 'accept': 'application/json', 'x-api-key': CONFIG.OPENSEA_API_KEY }
    });
    if (!r.ok) return;
    const d = await r.json();
    const floor = d.total?.floor_price ?? d.intervals?.[0]?.floor_price;
    if (floor) {
      const el = document.getElementById('stat-1d-floor');
      if (el) el.textContent = parseFloat(floor).toFixed(4) + ' Ξ';
    }
  } catch (e) { console.error(e); }
}

async function loadFloorListings() {
  const grid = document.getElementById('floorGrid');
  if (!grid) return;
  try {
    const r = await fetch(
      `${CONFIG.OPENSEA_API_HOST}/api/v2/listings/collection/${CONFIG.OPENSEA_SLUG}/all?limit=20`,
      { headers: { 'accept': 'application/json', 'x-api-key': CONFIG.OPENSEA_API_KEY } }
    );
    if (!r.ok) throw new Error('floor fetch');
    const d = await r.json();
    const listings = d.listings || [];
    if (listings.length === 0) {
      grid.innerHTML = '<div class="sales-loading" style="grid-column:1/-1">No active listings.</div>';
      return;
    }

    // Sort by price ascending; pull NFT metadata in parallel
    const withPrices = listings.map(l => {
      const offer = l.protocol_data?.parameters?.offer?.[0];
      const tokenId = offer?.identifierOrCriteria;
      const consideration = l.protocol_data?.parameters?.consideration || [];
      let totalWei = 0n;
      for (const c of consideration) {
        try { totalWei += BigInt(c.startAmount); } catch (e) {}
      }
      return { tokenId, priceEth: Number(totalWei) / 1e18, rawListing: l };
    }).filter(x => x.tokenId).sort((a, b) => a.priceEth - b.priceEth).slice(0, 12);

    grid.innerHTML = withPrices.map(item => {
      const url = `${CONFIG.OPENSEA_WEB_BASE}/${CONFIG.CONTRACT}/${item.tokenId}`;
      return `
        <a href="${url}" target="_blank" class="floor-item" data-token="${item.tokenId}">
          <img src="https://placehold.co/300x300/0a0a0a/00ff88/png?text=%23${item.tokenId}" alt="Undead #${item.tokenId}" data-token="${item.tokenId}" loading="lazy">
          <div class="floor-item-arrow"><i class="fas fa-external-link-alt"></i></div>
          <div class="floor-item-body">
            <div class="floor-item-id">#${item.tokenId}</div>
            <div class="floor-item-price">${item.priceEth.toFixed(4)} Ξ</div>
          </div>
        </a>`;
    }).join('');

    // Load images from the on-chain renderer
    injectRendererImages(grid);
  } catch (e) {
    grid.innerHTML = '<div class="sales-loading" style="grid-column:1/-1">Could not load listings.</div>';
  }
}

// Tabs
function initSalesTabs() {
  const tabs = document.querySelectorAll('.sales-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const range = tab.dataset.range;
      document.querySelectorAll('.sales-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('salesPanel-' + range);
      if (panel) panel.classList.add('active');
    });
  });
}
// ===========================================================
// TESTNET FALLBACK — direct RPC (mirrors validator.html logic)
// ===========================================================
let _rpcId = 1;
async function rpcCall(method, params) {
  const res = await fetch(NET.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

function u256(n) { return BigInt(n).toString(16).padStart(64, '0'); }

function abiDecodeString(hex) {
  hex = hex.replace(/^0x/, '');
  const offset = parseInt(hex.slice(0, 64), 16) * 2;
  const len    = parseInt(hex.slice(offset, offset + 64), 16);
  const bytes  = hex.slice(offset + 64, offset + 64 + len * 2);
  let out = '';
  for (let i = 0; i < bytes.length; i += 2)
    out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return out;
}

// Like rpcCall but lets us pass a different RPC URL (used for Sepolia fallback).
// Retries on HTTP 429 (rate limit) with exponential backoff up to 3 tries.
async function rpcCallTo(url, method, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    if (res.status === 429) {
      // Honor Retry-After if the server sent one, else exponential backoff
      const ra = parseInt(res.headers.get('retry-after')) || 0;
      const wait = ra > 0 ? ra * 1000 : 500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }
  throw new Error('RPC rate-limited after 3 retries');
}

async function fetchTokenViaRPC(id) {
  // Mirror the same fallback logic loadFeaturedUndeadsFromRenderer uses,
  // so the modal works on both mainnet and the Sepolia preview.
  const useFallback = !NET.rendererAddress && window.FEATURED_FALLBACK;
  const renderer = useFallback ? window.FEATURED_FALLBACK.rendererAddress : NET.rendererAddress;
  const url      = useFallback ? window.FEATURED_FALLBACK.rpcUrl          : NET.rpcUrl;
  if (!renderer || !url) throw new Error('No renderer/rpc configured');

  const data = '0xc87b56dd' + u256(id);
  const raw  = await rpcCallTo(url, 'eth_call', [{ to: renderer, data }, 'latest']);
  const uri  = abiDecodeString(raw);
  const b64  = uri.replace(/^data:application\/json;base64,/, '');
  return JSON.parse(atob(b64));
}

async function loadFeaturedUndeadsFromRenderer() {
  const scroller = document.getElementById('nftScroller');
  if (!scroller) return;

  // Use mainnet renderer if set; otherwise fall back to Sepolia for previews.
  const useFallback = !NET.rendererAddress && window.FEATURED_FALLBACK;
  const renderer    = useFallback ? window.FEATURED_FALLBACK.rendererAddress : NET.rendererAddress;
  const nftContract = useFallback ? window.FEATURED_FALLBACK.NFT_ADDRESS     : NET.NFT_ADDRESS;

  // Read rpcUrl as a getter so it always reflects the latest value —
  // initializeAPIKeys() upgrades NET.rpcUrl to Alchemy before this
  // function does any real work, so by the time RPC calls fire the
  // key is already in place. No hardcoding needed anywhere.
  const getRpcUrl = () => useFallback ? window.FEATURED_FALLBACK.rpcUrl : NET.rpcUrl;

  if (!renderer) {
    scroller.innerHTML = '<div class="sales-loading">Featured preview unavailable.</div>';
    return;
  }

  scroller.innerHTML = '<div class="sales-loading"><i class="fas fa-spinner fa-spin"></i> Summoning the horde…</div>';

  // Get total supply so we know how many tokens exist
  let totalSupply = 0;
  try {
    const raw = await rpcCallTo(getRpcUrl(), 'eth_call', [{ to: nftContract, data: '0x18160ddd' }, 'latest']);
    totalSupply = parseInt(raw, 16);
  } catch { totalSupply = 0; }

  if (totalSupply === 0) {
    scroller.innerHTML = '<div class="sales-loading">No tokens minted yet.</div>';
    return;
  }

  // Fisher-Yates shuffle so display order is random every page load
  const allIds = Array.from({ length: totalSupply }, (_, i) => i + 1);
  for (let i = allIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
  }
  // Cap total tokens fetched. Scroller shows ~80 max, about/staking grids use 9 each.
  // Loading 150 random tokens covers all displays with variety + room for retries.
  // Bump this to 500+ once you're on Alchemy/private RPC; on public RPC it kills you.
  const MAX_LOAD = 250;
  const ids = allIds.slice(0, Math.min(MAX_LOAD, totalSupply));

  const collected = [];
  let firstPaintDone = false;
  const BATCH = 20;         // controls first-paint trigger point only
  const BATCH_DELAY = 0;   // sequential loop below handles pacing

  function paintScroller(nfts) {
    const half = Math.floor(nfts.length / 2);
    scroller.innerHTML = '';
    scroller.appendChild(createScrollRow(nfts.slice(0, half), 'left'));
    scroller.appendChild(createScrollRow(nfts.slice(half),    'right'));
    populateAboutImages(nfts);
    populateStakingVisual(nfts);
  }

  for (let b = 0; b < ids.length; b += BATCH) {
    const batchIds = ids.slice(b, b + BATCH);

    for (const id of batchIds) {
      try {
        const data = '0xc87b56dd' + u256(id);
        const raw  = await rpcCallTo(getRpcUrl(), 'eth_call', [{ to: renderer, data }, 'latest']);
        const uri  = abiDecodeString(raw);
        const b64  = uri.replace(/^data:application\/json;base64,/, '');
        const json = JSON.parse(atob(b64));
        _imgCache[id] = json.image || ''; // populate shared cache
        collected.push({
          identifier: id,
          name:       json.name,
          image_url:  json.image,
          attributes: json.attributes || []
        });
      } catch { /* skip token on error, keep going */ }
      await new Promise(r => setTimeout(r, 100)); // 100ms between calls = ~10 req/s
    }

    // First paint: show scroller as soon as the first batch lands
    if (!firstPaintDone && collected.length > 0) {
      firstPaintDone = true;
      paintScroller([...collected]);
    }

    // Throttle: wait between batches to stay under public RPC rate limits
    if (b + BATCH < ids.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  // Final paint with every token loaded
  if (collected.length > 0) paintScroller(collected);
}
// ===========================================================
// 7. FEATURED NFT SCROLLER
// ===========================================================
async function loadFeaturedUndeads() {
  const scroller = document.getElementById('nftScroller');
  if (!scroller) return;

  try {
    let all = [];
    let next = null;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ limit: '200' });
      if (next) params.append('next', next);
      const url = `${CONFIG.OPENSEA_API_HOST}/api/v2/chain/${CONFIG.CHAIN_SLUG}/contract/${CONFIG.CONTRACT}/nfts?${params}`;
      const r = await fetch(url, {
        headers: { 'accept': 'application/json', 'x-api-key': CONFIG.OPENSEA_API_KEY }
      });
      if (!r.ok) break;
      const d = await r.json();
      if (d.nfts) all.push(...d.nfts);
      next = d.next;
      if (!next) break;
      await new Promise(r => setTimeout(r, 200));
    }

    if (all.length === 0) {
      const link = window.NETWORK?.openseaCollection || 'https://opensea.io/collection/basedundeads/overview';
      scroller.innerHTML = `<div class="sales-loading">Unable to load Featured Undeads. Visit <a href="${link}" target="_blank" style="color:var(--accent)">OpenSea</a> directly.</div>`;
      return;
    }

    scroller.innerHTML = '';
    const shuffled = [...all].sort(() => 0.5 - Math.random());
    const row1 = createScrollRow(shuffled.slice(0, 3333), 'left');
    const row2 = createScrollRow(shuffled.slice(3333, 6666), 'right');
    scroller.appendChild(row1);
    scroller.appendChild(row2);

    populateAboutImages(all);
    populateStakingVisual(all);
  } catch (e) {
    scroller.innerHTML = '<div class="sales-loading">Unable to load Featured Undeads.</div>';
  }
}

function createScrollRow(nfts, dir) {
  const row = document.createElement('div');
  row.className = 'nft-scroll-row nft-scroll-' + dir;
  const capped = nfts.slice(0, 40);
  row.style.animationDuration = Math.max(40, capped.length * 3) + 's';
  [...capped, ...capped].forEach(nft => row.appendChild(nftCard(nft)));
  return row;
}

function nftCard(nft) {
  const card = document.createElement('div');
  card.className = 'nft-card';
  const img = proxyImage(nft.image_url || nft.display_image_url || '');
  const tokenId = nft.identifier;
  const name = nft.name || 'Undead #' + tokenId;
  card.innerHTML = `
    <img src="${img}" alt="${name}" loading="lazy"
         onerror="this.src='https://placehold.co/220x220/0a0505/c8a450/png?text=%23${tokenId}'"/>
    <p>${name}</p>`;
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => openUndeadModal(nft));
  return card;
}

// ─── Gothic popup modal for a featured Undead ───────────────────
function openUndeadModal (nft) {
  const tokenId = nft.identifier;
  const name    = nft.name || 'Undead #' + tokenId;
  const img     = proxyImage(nft.image_url || nft.display_image_url || '');
  const attrs   = nft.attributes || nft.traits || [];

  // If we don't have traits yet, pull them from the renderer (mainnet or fallback).
  const needTraits = !attrs || attrs.length === 0;

// Mainnet contract live? Use opensea.io. Still on testnet preview? Use testnets.opensea.io.
  const useFallback   = !NET.rendererAddress && window.FEATURED_FALLBACK;
  const mainContract  = NET.NFT_ADDRESS;
  const isMainSet     = mainContract && mainContract !== '0x0000000000000000000000000000000000000000';
  const fbContract    = useFallback ? window.FEATURED_FALLBACK.NFT_ADDRESS : null;

  let openseaUrl;
  if (isMainSet) {
    openseaUrl = `https://opensea.io/item/base/${mainContract}/${tokenId}`;
  } else if (fbContract) {
    openseaUrl = `https://testnets.opensea.io/assets/base-sepolia/${fbContract}/${tokenId}`;
  } else {
    openseaUrl = 'https://opensea.io/collection/basedundeads/overview';
  }

  const traitsHtml = (list) => (list && list.length)
    ? `<div class="undead-modal-traits">
         ${list.map(a => `
           <div class="undead-trait-pill">
             <span class="utp-type">${a.trait_type || a.type}</span>
             <span class="utp-val">${a.value}</span>
           </div>`).join('')}
       </div>`
    : '<p class="undead-modal-notraits">No traits available.</p>';

  const modal = document.createElement('div');
  modal.className = 'undead-modal-overlay';
  modal.innerHTML = `
    <div class="undead-modal">
      <button class="undead-modal-close" aria-label="Close">&times;</button>
      <div class="undead-modal-grid">
        <div class="undead-modal-img">
          <img src="${img}" alt="${name}" onerror="this.src='https://placehold.co/500x500/0a0505/c8a450/png?text=%23${tokenId}'"/>
        </div>
        <div class="undead-modal-info">
          <p class="undead-modal-eyebrow">Token #${String(tokenId).padStart(4, '0')}</p>
          <h2 class="undead-modal-name">${name}</h2>
          <div class="undead-modal-body" id="undeadModalBody">
            ${needTraits ? '<p class="undead-modal-notraits"><i class="fas fa-spinner fa-spin"></i> Summoning traits…</p>' : traitsHtml(attrs)}
          </div>
          <a href="${openseaUrl}" target="_blank" rel="noopener" class="undead-modal-cta">
            <i class="fas fa-external-link-alt"></i> View on OpenSea
          </a>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  const close = () => {
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 220);
  };
  modal.querySelector('.undead-modal-close').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function esc (e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  // Fetch traits lazily from the renderer if we don't have them.
  if (needTraits) {
    (async () => {
      try {
        const json = await fetchTokenViaRPC(tokenId);
        const body = document.getElementById('undeadModalBody');
        if (body) body.innerHTML = traitsHtml(json.attributes || []);
      } catch (e) {
        const body = document.getElementById('undeadModalBody');
        if (body) body.innerHTML = '<p class="undead-modal-notraits">Could not load traits.</p>';
      }
    })();
  }
}

// Story / about — randomised on every page load. Works on testnet or mainnet
// because `all` is fetched from CONFIG.OPENSEA_API_HOST (driven by config.js).
function populateAboutImages(all) {
  const grid = document.getElementById('aboutImageGrid');
  if (!grid || !all || all.length === 0) return;
  const pool = [...all];
  const pick = pool.sort(() => 0.5 - Math.random()).slice(0, 9);
  grid.innerHTML = pick.map(nft => {
    const img = proxyImage(nft.image_url || nft.display_image_url || '');
    return `<div class="about-image"><img src="${img}" alt="Undead" loading="lazy" onerror="this.style.display='none'"></div>`;
  }).join('');
}

// Passive income teaser — hexagonal tarot spread of 9 randoms
function populateStakingVisual(all) {
  const grid = document.getElementById('stakingTeaserVisual');
  if (!grid || !all || all.length === 0) return;
  const pool = [...all];
  const pick = pool.sort(() => 0.5 - Math.random()).slice(0, 9);
  grid.innerHTML = pick.map(nft => {
    const img = proxyImage(nft.image_url || nft.display_image_url || '');
    return `<img src="${img}" alt="Undead" loading="lazy" onerror="this.style.display='none'">`;
  }).join('');
}

// Previous Projects — rotate Squiggle viewer token on load + Replay/Random
function initProjectsViewer () {
  const frame     = document.getElementById('squiggleFrame');
  const replay    = document.getElementById('squiggleReplay');
  const rand      = document.getElementById('squiggleRandom');
  const fs        = document.getElementById('squiggleFullscreen');
  const display   = document.getElementById('squiggleTokenDisplay');
  const puzzle    = document.getElementById('puzzleFrame');
  const puzzleNew = document.getElementById('puzzleNew');
  if (!frame) return;

  const SQUIGGLE_MAX = 500;   // highest Squiggle On Base token ID — bump if collection grows
  const randomId = () => Math.floor(Math.random() * SQUIGGLE_MAX) + 1;

  let tid = randomId();       // ← random on every page load
  const setToken = n => {
    tid = n;
    frame.src = `https://squiggler.netlify.app/?tid=${n}`;
    if (display) display.textContent = '#' + String(n).padStart(4, '0');
  };
  // Paint the first random token immediately
  setToken(tid);

  replay   && replay.addEventListener('click',   () => setToken(tid));
  rand     && rand.addEventListener('click',     () => setToken(randomId()));
  fs       && fs.addEventListener('click',       () => frame.requestFullscreen?.());
  puzzleNew && puzzleNew.addEventListener('click', () => {
    if (puzzle) puzzle.src = puzzle.src;
  });
}

// ===========================================================
// 8. MOBILE NAV
// ===========================================================
function initMobileNav() {
  const btn = document.getElementById('mobileMenuBtn');
  const links = document.querySelector('.nav-links');
  if (!btn || !links) return;
  btn.addEventListener('click', () => {
    links.classList.toggle('mobile-open');
    btn.innerHTML = links.classList.contains('mobile-open')
      ? '<i class="fas fa-times"></i>'
      : '<i class="fas fa-bars"></i>';
  });
  links.querySelectorAll('.nav-link').forEach(l => l.addEventListener('click', () => {
    links.classList.remove('mobile-open');
    btn.innerHTML = '<i class="fas fa-bars"></i>';
  }));
}

// ===========================================================
// 9. INIT
// ===========================================================
document.addEventListener('DOMContentLoaded', async () => {
  const keysLoaded = await initializeAPIKeys();
  initMobileNav();
  initSalesTabs();
  initProjectsViewer();

  // Featured: always runs. Uses mainnet renderer if address is set,
  // otherwise falls back to Sepolia renderer (see config.js FEATURED_FALLBACK).
  loadFeaturedUndeadsFromRenderer();

  // Sales / floor / stats: only meaningful once mainnet contract is live.
  if (!NET.NFT_ADDRESS || NET.NFT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    ['salesPanel-1', 'salesPanel-7', 'salesPanel-30'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="sales-loading">Sales tracker activates when mainnet contract is live.</div>';
    });
    ['stat-1d-count','stat-1d-volume','stat-1d-avg','stat-1d-floor',
     'stat-7d-count','stat-7d-volume','stat-7d-unique',
     'stat-30d-count','stat-30d-volume','stat-30d-unique']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    const floorGrid = document.getElementById('floorGrid');
    if (floorGrid) floorGrid.innerHTML = '<div class="sales-loading" style="grid-column:1/-1">Floor listings activate when mainnet contract is live.</div>';
    return;
  }

  // ── Mainnet with contract deployed ──────────────────────────
  if (!keysLoaded) {
    const scroller = document.getElementById('nftScroller');
    if (scroller) scroller.innerHTML = '<div class="sales-loading">API not configured — set OPENSEA_API_KEY in Vercel environment variables.</div>';
    return;
  }

  Promise.all([
    renderSalesForRange(1),
    renderSalesForRange(7),
    renderSalesForRange(30),
    loadCollectionStats(),
    loadFloorListings(),
  ]);

  document.querySelectorAll('a[href^="#"], a[href^="/#"]').forEach(a => {
    a.addEventListener('click', e => {
      const href = a.getAttribute('href');
      const hashIdx = href.indexOf('#');
      if (hashIdx < 0) return;
      const target = document.querySelector(href.slice(hashIdx));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });
});