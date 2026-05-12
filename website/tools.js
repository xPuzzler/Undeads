/* ============================================================
   BASED UNDEADS - tools.js
   Handles: Wallet NFT loader · NFT Grid Maker · Wallpaper Maker
            · Collection Explorer
   Mirrors the API key init + OpenSea fetch logic from script.js
   ============================================================ */

'use strict';

/* ============================================================
   API KEYS - fetched from Netlify function exactly like script.js
   ============================================================ */
let OPENSEA_KEY  = null;
let ALCHEMY_KEY  = null;
let MORALIS_KEY  = null;

async function initializeAPIKeys() {
  try {
    const response = await fetch('/.netlify/functions/api-keys');
    if (!response.ok) throw new Error('api-keys fetch failed: ' + response.status);
    const data = await response.json();
    if (!data.apiKeys) throw new Error('apiKeys missing from response');

    ALCHEMY_KEY = data.apiKeys.alchemy || null;
    OPENSEA_KEY = Array.isArray(data.apiKeys.opensea)
      ? data.apiKeys.opensea[0]
      : (data.apiKeys.opensea || null);
    MORALIS_KEY = data.apiKeys.moralis || null;

    console.log('✅ API keys loaded');
    return true;
  } catch (err) {
    console.error('❌ API keys error:', err);
    toast('Could not load API configuration - some features may be limited', 'error');
    return false;
  }
}

/* ============================================================
   UTILITIES
   ============================================================ */

function toast(msg, type = 'info') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const colors = { info: '#c8a450', success: '#3ecf8e', error: '#ff6b6b' };
  const el = document.createElement('div');
  el.style.cssText = `
    display:inline-flex;align-items:center;gap:10px;
    background:rgba(10,5,5,.97);border:1px solid ${colors[type]};
    color:${colors[type]};padding:12px 24px;border-radius:100px;
    font-family:'Geist Mono',monospace;font-size:12px;letter-spacing:.06em;
    box-shadow:0 8px 32px rgba(0,0,0,.7);animation:fadeUp .25s ease;margin:6px 0;
    position:relative;z-index:9999;
  `;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// Cache for renderer-fetched data URLs (avoid re-fetching same token)
const RENDERER_CACHE = new Map();

// Fetches an Undead's image directly from the onchain renderer.
// Returns a data URL (canvas-safe, zero CORS issues).
async function fetchUndeadImageOnchain(tokenId) {
  if (typeof window.NETWORK === 'undefined' || !window.NETWORK?.rendererAddress) return null;
  if (typeof ethers === 'undefined') return null;

  const cacheKey = `${window.NETWORK.NFT_ADDRESS.toLowerCase()}_${tokenId}`;
  if (RENDERER_CACHE.has(cacheKey)) return RENDERER_CACHE.get(cacheKey);

  try {
    const provider = new ethers.JsonRpcProvider(window.NETWORK.rpcUrl);
    // tokenURI(uint256) selector = 0xc87b56dd
    const data = '0xc87b56dd' + BigInt(tokenId).toString(16).padStart(64, '0');
    const raw = await provider.call({ to: window.NETWORK.rendererAddress, data });

    // Decode the ABI-encoded string return value
    const hex = raw.replace(/^0x/, '');
    const offset = parseInt(hex.slice(0, 64), 16) * 2;
    const len = parseInt(hex.slice(offset, offset + 64), 16);
    let uri = '';
    for (let i = 0; i < len * 2; i += 2) {
      uri += String.fromCharCode(parseInt(hex.slice(offset + 64 + i, offset + 64 + i + 2), 16));
    }

    // tokenURI returns data:application/json;base64,<JSON>
    const json = JSON.parse(atob(uri.replace(/^data:application\/json;base64,/, '')));
    const image = json.image || null;
    if (image) RENDERER_CACHE.set(cacheKey, image);
    return image;
  } catch (e) {
    console.warn(`[tools] Renderer fetch failed for #${tokenId}:`, e.message);
    return null;
  }
}

// Detects whether an NFT is a BasedUndead from this collection
function isBasedUndead(nft) {
  if (!nft || !window.NETWORK?.NFT_ADDRESS) return false;
  return (nft.contract || '').toLowerCase() === window.NETWORK.NFT_ADDRESS.toLowerCase();
}

// Loads an image and guarantees the resulting bitmap is CORS-clean
// for canvas export. Strategy:
//   0) For BasedUndeads: fetch directly from onchain renderer (always CORS-safe)
//   1) Try direct load with crossOrigin='anonymous' (fastest, no extra fetch)
//   2) If that fails, fetch as blob → blob URL
//   3) If blob fetch is blocked, route through public CORS proxy
async function loadImg(src, nft = null) {
  if (!src) throw new Error('No src');

  // Tier 0: Onchain fetch for BasedUndeads (zero CORS, always works)
  if (nft && isBasedUndead(nft)) {
    const onchainImg = await fetchUndeadImageOnchain(nft.id);
    if (onchainImg) {
      try { return await loadImgDirect(onchainImg); } catch(_) {}
    }
  }

  // Tier 1: direct load with CORS attribute
  try {
    return await loadImgDirect(src);
  } catch (e) {
    // Fall through
  }

  // Tier 2: fetch as blob, then load from blob URL
  try {
    const r = await fetch(src, { mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    const img = await loadImgDirect(blobUrl);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return img;
  } catch (e) {
    // Fall through
  }

  // Tier 3: route through a public CORS proxy
  try {
    const proxied = 'https://corsproxy.io/?' + encodeURIComponent(src);
    return await loadImgDirect(proxied);
  } catch (e) {
    throw new Error('Image load failed (CORS): ' + src);
  }
}

function loadImgDirect(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Image error: ' + src));
    img.src = src;
  });
}

function proxyUrl(url) {
  if (!url) return '';
  if (url.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + url.slice(7);
  if (url.startsWith('ar://'))   return 'https://arweave.net/'  + url.slice(5);
  return url;
}

// Detects what kind of media the URL/contentType points to.
// Returns: 'image' | 'gif' | 'webp' | 'video'
function detectMediaType(url, contentType = '') {
  // Prefer contentType hint when available (most reliable)
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('gif'))                     return 'gif';
  if (ct.includes('webp'))                    return 'webp';
  if (ct.startsWith('video/'))                return 'video';
  if (ct.includes('mp4') || ct.includes('webm') || ct.includes('quicktime')) return 'video';

  // URL-based detection
  if (!url) return 'image';
  const lower = url.toLowerCase().split('?')[0].split('#')[0];
  if (lower.endsWith('.gif'))                                   return 'gif';
  if (lower.endsWith('.webp'))                                  return 'webp';
  if (lower.match(/\.(mp4|webm|mov|m4v|ogv)$/))                 return 'video';

  // Common patterns in CDN URLs
  if (url.includes('content-type=image/gif'))                   return 'gif';
  if (url.includes('content-type=image/webp'))                  return 'webp';
  if (url.includes('content-type=video'))                       return 'video';

  return 'image';
}

function normalizeTokenId(id) {
  if (!id) return '';
  if (typeof id === 'string' && id.startsWith('0x')) return parseInt(id, 16).toString();
  return id.toString();
}

function downloadCanvas(canvas, name) {
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isSpam(name) {
  if (!name) return false;
  const kw = ['claim','reward','visit','voucher','airdrop','free mint','.com','.io','.xyz','http','www.','$','usd'];
  return kw.some(k => name.toLowerCase().includes(k));
}

/* ============================================================
   SECTION 1 - WALLET NFT LOADER
   ============================================================ */

let walletNFTs           = [];
let selectedForGrid      = [];
let userCollections      = new Map();
let currentDisplayedNFTs = [];
let lastRandomGrid       = null;

function processNFTsByCollection(nfts) {
  userCollections.clear();
  nfts.forEach(nft => {
    if (!nft.contract) return;
    const key  = nft.contract.toLowerCase();
    const name = nft.collection || 'Unknown Collection';
    if (isSpam(name)) return;
    if (!userCollections.has(key)) userCollections.set(key, { name, contract: nft.contract, nfts: [] });
    if (nft.image) userCollections.get(key).nfts.push(nft);
  });
  for (const [k, col] of userCollections.entries()) { if (!col.nfts.length) userCollections.delete(k); }
}

function displayCollectionSelector() {
  const section = document.getElementById('collectionSection');
  const select  = document.getElementById('collectionSelect');
  if (!section || !select) return;
  select.innerHTML = '<option value="">All Collections</option>';
  [...userCollections.values()]
    .sort((a, b) => b.nfts.length - a.nfts.length)
    .forEach(col => {
      const opt = document.createElement('option');
      opt.value = col.contract;
      opt.textContent = col.name + ' (' + col.nfts.length + ' NFTs)';
      select.appendChild(opt);
    });
  section.classList.remove('hidden');
}

async function onFetchNFTs() {
  const raw   = document.getElementById('walletAddress').value.trim();
  const chain = document.getElementById('chainSelect').value;

  if (!raw) { toast('Enter a wallet address or ENS name', 'error'); return; }

  let addr = raw;
  if (raw.endsWith('.eth')) {
    toast('Resolving ENS…');
    addr = await resolveENS(raw);
    if (!addr) { toast('Could not resolve: ' + raw, 'error'); return; }
    toast('Resolved → ' + addr.slice(0,6) + '…' + addr.slice(-4), 'success');
  }

  if (!addr.startsWith('0x') || addr.length !== 42) {
    toast('Please enter a valid wallet address or ENS name', 'error');
    return;
  }

  setNFTGridLoading();

  try {
    const [walletFetched, stakedFetched] = await Promise.all([
      fetchOpenSeaWallet(addr, chain),
      fetchStakedNFTs(addr)
    ]);
    // Merge: deduplicate by contract+id so staked tokens don't double-appear
    const seenIds = new Set(walletFetched.map(n => (n.contract||'').toLowerCase()+'_'+n.id));
    const newStaked = stakedFetched.filter(n => !seenIds.has((n.contract||'').toLowerCase()+'_'+n.id));
    walletNFTs = [...walletFetched, ...newStaked];
    processNFTsByCollection(walletNFTs);
    displayCollectionSelector();
    currentDisplayedNFTs = walletNFTs;
    renderWalletGrid(walletNFTs);
    document.getElementById('nftCount').textContent = walletNFTs.length + ' NFTs';
    // Debug: log media type breakdown
    const breakdown = {};
    walletNFTs.forEach(n => {
      const t = n.mediaType || 'unknown';
      breakdown[t] = (breakdown[t] || 0) + 1;
    });
    console.info('[tools] Media type breakdown:', breakdown);
    console.info('[tools] First 3 NFTs:', walletNFTs.slice(0, 3).map(n => ({
      id: n.id,
      mediaType: n.mediaType,
      image: n.image?.slice(0, 80),
      animation: n.animation?.slice(0, 80),
    })));

    toast(walletNFTs.length
      ? 'Loaded ' + walletNFTs.length + ' NFTs'
      : 'No NFTs found in this wallet', walletNFTs.length ? 'success' : 'info');
  } catch (err) {
    console.error('fetchNFTs error:', err);
    toast('Failed to load NFTs', 'error');
    setNFTGridError();
  }
}

async function resolveENS(name) {
  try {
    const r = await fetch('https://api.ensdata.net/' + name);
    if (r.ok) { const d = await r.json(); if (d.address) return d.address; }
  } catch(_) {}
  try {
    const r = await fetch('https://api.web3.bio/profile/ens/' + name);
    if (r.ok) { const d = await r.json(); if (d.address) return d.address; }
  } catch(_) {}
  return null;
}

/* Fetch staked NFTs directly from the staking contract */
async function fetchStakedNFTs(addr) {
  if (!window.NETWORK?.STAKING_ADDRESS || !window.NETWORK?.rpcUrl) return [];
  if (typeof ethers === 'undefined') return [];
  try {
    const iface = new ethers.Interface(['function getStakedTokens(address) view returns (uint256[])']);
    const calldata = iface.encodeFunctionData('getStakedTokens', [addr]);
    const rpcResp = await fetch(window.NETWORK.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'eth_call',
        params: [{ to: window.NETWORK.STAKING_ADDRESS, data: calldata }, 'latest'],
        id: 1
      })
    });
    const rpcJson = await rpcResp.json();
    if (rpcJson.error) throw new Error(rpcJson.error.message);
    const decoded = iface.decodeFunctionResult('getStakedTokens', rpcJson.result);
    const tokenIds = decoded[0].map(id => id.toString());
    if (!tokenIds.length) return [];
    toast(`Found ${tokenIds.length} staked NFT(s) — fetching images…`);
    const stakedNFTs = await Promise.all(tokenIds.map(async (id) => {
      const image = await fetchUndeadImageOnchain(id);
      return {
        id,
        name: `Undead #${id}`,
        image: image || `https://placehold.co/300x300/140808/c8a450?text=%23${id}`,
        rawImage: image || '',
        animation: '',
        mediaType: 'image',
        collection: 'Based Undeads (Staked)',
        contract: (window.NETWORK.NFT_ADDRESS || '').toLowerCase(),
        source: 'staking',
        staked: true
      };
    }));
    return stakedNFTs;
  } catch(e) {
    console.error('[tools] fetchStakedNFTs error:', e);
    return [];
  }
}

/* OpenSea wallet fetch - mirrors script.js loadWalletCollections */
async function fetchOpenSeaWallet(addr, chainKey) {
  const chainMap = { base:'base', ethereum:'ethereum', apechain:'ape_chain' };
  const chain    = chainMap[chainKey] || 'base';
  const BASE_API = 'https://api.opensea.io/api/v2';

  const seenNFTs = new Set();
  const allNFTs  = [];

  /* OpenSea */
  try {
    let cursor = null, page = 0;
    do {
      const url = cursor
        ? `${BASE_API}/chain/${chain}/account/${addr}/nfts?limit=200&next=${cursor}`
        : `${BASE_API}/chain/${chain}/account/${addr}/nfts?limit=200`;
      const r = await fetch(url, {
        headers: { 'X-API-KEY': OPENSEA_KEY || '', 'accept': 'application/json' }
      });
      if (!r.ok) { console.warn('OpenSea status:', r.status); break; }
      const d = await r.json();
      (d.nfts || []).forEach(n => {
        const uid = (n.contract||'').toLowerCase() + '_' + normalizeTokenId(n.identifier);
        if (seenNFTs.has(uid)) return;
        seenNFTs.add(uid);
        const imgUrl = proxyUrl(n.image_url || n.display_image_url || '');
        const animUrl = proxyUrl(n.display_animation_url || n.animation_url || '');
        const mt = detectMediaType(animUrl || imgUrl, n.mime_type || n.media_type);
        allNFTs.push({
          id: n.identifier,
          name: n.name || '#' + n.identifier,
          image: imgUrl,
          rawImage: imgUrl,                  // OpenSea's image is already raw
          animation: animUrl,
          mediaType: mt,
          collection: n.collection,
          contract: n.contract,
          source: 'opensea'
        });
      });
      cursor = d.next || null; page++;
      if (cursor) await sleep(300);
    } while (cursor && page < 20);
  } catch(e) { console.error('OpenSea wallet fetch:', e); }

  /* Moralis */
  const MORALIS_CHAIN_MAP = { base:'base', ethereum:'eth', apechain:'apechain' };
  if (MORALIS_KEY) {
    try {
      const mchain = MORALIS_CHAIN_MAP[chainKey] || 'base';
      let cursor = null, page = 0;
      do {
        const url = cursor
          ? `https://deep-index.moralis.io/api/v2/${addr}/nft?chain=${mchain}&format=decimal&limit=100&cursor=${cursor}`
          : `https://deep-index.moralis.io/api/v2/${addr}/nft?chain=${mchain}&format=decimal&limit=100`;
        const r = await fetch(url, { headers: { 'X-API-Key': MORALIS_KEY } });
        if (!r.ok) break;
        const d = await r.json();
        (d.result || []).forEach(n => {
          const uid = (n.token_address||'').toLowerCase() + '_' + normalizeTokenId(n.token_id);
          if (seenNFTs.has(uid)) return;
          seenNFTs.add(uid);
          let meta = {};
          try { meta = n.metadata ? JSON.parse(n.metadata) : {}; } catch(_) {}
          const imgUrl = proxyUrl(meta.image || meta.image_url || '');
          const animUrl = proxyUrl(meta.animation_url || meta.animation || '');
          if (!imgUrl && !animUrl) return;
          const mt = detectMediaType(animUrl || imgUrl);
          allNFTs.push({
            id: n.token_id,
            name: n.name || meta.name || '#'+n.token_id,
            image: imgUrl || animUrl,
            rawImage: imgUrl,   
            animation: animUrl,
            mediaType: mt,
            collection: n.name,
            contract: n.token_address,
            source: 'moralis'
          });
        });
        cursor = d.cursor||null; page++;
        if (cursor) await sleep(300);
      } while (cursor && page < 30);
    } catch(e) { console.error('Moralis wallet fetch:', e); }
  }

  /* Alchemy */
  const ALCHEMY_NET_MAP = { base:'base-mainnet', ethereum:'eth-mainnet', apechain:'apechain-mainnet' };
  if (ALCHEMY_KEY) {
    try {
      const net = ALCHEMY_NET_MAP[chainKey] || 'base-mainnet';
      let pageKey = null, page = 0;
      do {
        const url = pageKey
          ? `https://${net}.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner?owner=${addr}&withMetadata=true&pageSize=100&pageKey=${pageKey}`
          : `https://${net}.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner?owner=${addr}&withMetadata=true&pageSize=100`;
        const r = await fetch(url);
        if (!r.ok) break;
        const d = await r.json();
        (d.ownedNfts || []).forEach(n => {
          const uid = (n.contract?.address||'').toLowerCase() + '_' + normalizeTokenId(n.tokenId);
          if (seenNFTs.has(uid)) return;
          // Capture every URL Alchemy gives us so we can fall back later
          const rawImage = n.raw?.metadata?.image || n.raw?.metadata?.image_url || '';
          const rawAnim  = n.raw?.metadata?.animation_url || n.raw?.metadata?.animation || '';
          const cdnImage = n.image?.cachedUrl || n.image?.thumbnailUrl || '';
          // Display URL (prefer CDN — faster), but keep raw for the GIF/video builder
          const imgUrl = proxyUrl(cdnImage || rawImage);
          const animUrl = proxyUrl(rawAnim);
          if (!imgUrl && !animUrl) return;
          const contentType = n.image?.contentType || n.raw?.metadata?.mime_type || '';
          const mt = detectMediaType(animUrl || rawImage || imgUrl, contentType);
          seenNFTs.add(uid);
          allNFTs.push({
            id: n.tokenId,
            name: n.name||n.title||'#'+n.tokenId,
            image: imgUrl || animUrl,
            rawImage: proxyUrl(rawImage),     // ← keep raw for animation decoding
            animation: animUrl,
            mediaType: mt,
            collection: n.contract?.openSeaMetadata?.collectionName || n.contract?.name,
            contract: n.contract?.address,
            source: 'alchemy'
          });
        });
        pageKey = d.pageKey||null; page++;
        if (pageKey) await sleep(300);
      } while (pageKey && page < 50);
    } catch(e) { console.error('Alchemy wallet fetch:', e); }
  }

  return allNFTs.filter(n => n.image && !isSpam(n.collection || n.name));
}

function setNFTGridLoading() {
  document.getElementById('nftGrid').innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:var(--muted);">
      <i class="fas fa-spinner fa-spin" style="font-size:36px;display:block;margin-bottom:14px;opacity:.5;"></i>
      <p style="font-family:'Geist Mono',monospace;font-size:.86rem;letter-spacing:.1em;">Loading NFTs…</p>
    </div>`;
}

function setNFTGridError() {
  document.getElementById('nftGrid').innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:#ff6b6b;">
      <i class="fas fa-exclamation-circle" style="font-size:36px;display:block;margin-bottom:14px;opacity:.5;"></i>
      <p style="font-family:'Geist Mono',monospace;font-size:.86rem;">Failed to load NFTs - check the address and try again.</p>
    </div>`;
}

function renderWalletGrid(nfts) {
  const grid = document.getElementById('nftGrid');
  grid.innerHTML = '';

  if (!nfts.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:var(--muted);">
        <span style="font-size:48px;display:block;margin-bottom:14px;opacity:.3;">☠</span>
        <p style="font-family:'Geist Mono',monospace;font-size:.86rem;">No NFTs found in this wallet</p>
      </div>`;
    return;
  }

  nfts.forEach((nft, i) => {
    const card = document.createElement('div');
    card.className = 'stake-nft-card';
    card.dataset.index = i;
    const typeBadge = nft.mediaType && nft.mediaType !== 'image'
      ? `<span style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,.85);
         padding:3px 8px;border-radius:100px;font-family:'Geist Mono',monospace;font-size:9px;
         color:#c8a450;letter-spacing:.1em;text-transform:uppercase;border:1px solid rgba(200,164,80,.3);">
         ${nft.mediaType}</span>` : '';
    const stakedBadge = nft.staked
      ? `<span style="position:absolute;top:6px;right:6px;background:rgba(139,26,26,.9);
         padding:3px 8px;border-radius:100px;font-family:'Geist Mono',monospace;font-size:9px;
         color:#ff8888;letter-spacing:.1em;text-transform:uppercase;border:1px solid rgba(139,26,26,.6);">
         ⚰ Staked</span>` : '';
    card.innerHTML = `
      ${typeBadge}${stakedBadge}
      <img src="${nft.image || 'https://placehold.co/300x300/140808/c8a450?text=%23'+nft.id}"
           alt="${nft.name}" loading="lazy"
           onerror="this.onerror=null;this.src='https://placehold.co/300x300/140808/c8a450?text=%23${nft.id}'"/>
      <div class="stake-nft-card-body">
        <span class="stake-nft-id">#${nft.id}</span>
        <span class="stake-nft-card-check"></span>
      </div>`;

    card.addEventListener('click', () => {
      const gridActive = document.getElementById('gridModeToggle')?.classList.contains('active');
      const mode = document.querySelector('input[name="selectionMode"]:checked')?.value || 'manual';
      if (gridActive && mode === 'manual') {
        toggleGridSelect(nft, card);
      } else {
        addCharacterToWallpaper(nft);
        document.getElementById('wallpaper')?.scrollIntoView({ behavior:'smooth' });
        toast('Added to Wallpaper Maker ↓', 'info');
      }
    });

    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      addCharacterToWallpaper(nft);
      document.getElementById('wallpaper')?.scrollIntoView({ behavior:'smooth' });
      toast('Added to Wallpaper Maker', 'success');
    });

    grid.appendChild(card);
  });
}

function toggleGridSelect(nft, card) {
  const idx = selectedForGrid.findIndex(n => n === nft);
  if (idx >= 0) { selectedForGrid.splice(idx, 1); card.classList.remove('selected'); }
  else           { selectedForGrid.push(nft); card.classList.add('selected'); }
  updateGridSelCount();
}

function updateGridSelCount() {
  const el = document.getElementById('gridSelCount');
  if (!el) return;
  if (!selectedForGrid.length) {
    el.textContent = '0 selected';
    return;
  }
  const types = new Set(selectedForGrid.map(n => n.mediaType || 'image'));
  if (types.size > 1) {
    el.textContent = `${selectedForGrid.length} selected · ⚠️ Mixed types (${[...types].join(', ')}) — pick one type only`;
    el.style.color = '#ff6b6b';
  } else {
    const t = [...types][0];
    const emoji = t === 'image' ? '🖼' : t === 'video' ? '🎥' : '✨';
    el.textContent = `${selectedForGrid.length} selected · ${emoji} ${t}`;
    el.style.color = '';
  }
}

/* ============================================================
   SECTION 2 - NFT GRID MAKER
   ============================================================ */

function getGridDims() {
  const v = document.getElementById('gridSize').value;
  if (v === 'custom') {
    return {
      rows: Math.min(+document.getElementById('customGridRows').value || 3, 50),
      cols: Math.min(+document.getElementById('customGridCols').value || 3, 50)
    };
  }
  if (v.startsWith('random')) {
    const map = { 'random-small':[2,5], 'random-medium':[5,10], 'random-large':[10,20] };
    const [lo,hi] = map[v];
    const s = lo + Math.floor(Math.random()*(hi-lo+1));
    return { rows:s, cols:s };
  }
  const s = parseInt(v);
  return { rows:s, cols:s };
}

function getNFTsForGrid(useCache = false) {
  const mode = document.querySelector('input[name="selectionMode"]:checked')?.value || 'manual';
  const { rows, cols } = getGridDims();
  const needed = rows * cols;

  let chosenNfts;

  if (mode === 'random') {
    if (useCache && lastRandomGrid) return lastRandomGrid;
    const pool = (currentDisplayedNFTs.length ? currentDisplayedNFTs : walletNFTs).filter(n => n.image);
    if (!pool.length) { toast('Load a wallet first to use random mode', 'error'); return null; }

    // For random: group by mediaType, pick the largest group
    const byType = {};
    pool.forEach(n => {
      const t = n.mediaType || 'image';
      if (!byType[t]) byType[t] = [];
      byType[t].push(n);
    });
    const largestType = Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length)[0];
    const sameTypePool = byType[largestType];
    chosenNfts = [...sameTypePool].sort(() => Math.random() - 0.5).slice(0, needed);

    lastRandomGrid = { nfts: chosenNfts, rows, cols, mediaType: largestType };
    return lastRandomGrid;
  }

  // Manual mode
  lastRandomGrid = null;
  if (!selectedForGrid.length) { toast('Select NFTs from your wallet for the grid', 'error'); return null; }

  // Check that all selected are same media type
  const types = new Set(selectedForGrid.map(n => n.mediaType || 'image'));
  if (types.size > 1) {
    toast(`Mixed types selected (${[...types].join(', ')}). Pick all images, all GIFs, or all videos.`, 'error');
    return null;
  }

  chosenNfts = selectedForGrid.slice(0, needed);
  return { nfts: chosenNfts, rows, cols, mediaType: [...types][0] || 'image' };
}

async function buildGridCanvas(nfts, rows, cols) {
  const cellSize = 400;
  const sep   = Math.max(0, parseInt(document.getElementById('separatorWidth').value) || 0);
  const sepC  = document.getElementById('separatorColor').value  || '#0a0505';
  const emtyC = document.getElementById('emptyCellColor').value  || '#1a0a0a';
  const W = cols*cellSize+(cols+1)*sep, H = rows*cellSize+(rows+1)*sep;
  const canvas = document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle=sepC; ctx.fillRect(0,0,W,H);

  // Pre-load all images in parallel — much faster than serial.
  // Pass the full nft object so loadImg can route BasedUndeads through onchain.
  const imagePromises = nfts.slice(0, rows*cols).map(nft =>
    nft?.image ? loadImg(nft.image, nft).catch(() => null) : Promise.resolve(null)
  );
  const images = await Promise.all(imagePromises);

  let failures = 0;
  for (let i=0; i<rows*cols; i++) {
    const r=Math.floor(i/cols), c=i%cols;
    const x=sep+c*(cellSize+sep), y=sep+r*(cellSize+sep);
    const img = images[i];
    if (img) {
      try {
        ctx.drawImage(img, x, y, cellSize, cellSize);
      } catch (_) {
        ctx.fillStyle=emtyC; ctx.fillRect(x,y,cellSize,cellSize);
        failures++;
      }
    } else {
      ctx.fillStyle=emtyC; ctx.fillRect(x,y,cellSize,cellSize);
      if (nfts[i]?.image) failures++;
    }
  }

  if (failures > 0) {
    console.warn(`[tools] ${failures} image(s) skipped (CORS or load failed)`);
  }
  return canvas;
}

async function previewGrid() {
  const data = getNFTsForGrid(false);
  if (!data) return;

  if (data.mediaType === 'image') {
    return previewImageGrid(data);
  }
  if (data.mediaType === 'gif' || data.mediaType === 'webp') {
    return previewAnimatedGrid(data);
  }
  if (data.mediaType === 'video') {
    return previewVideoGrid(data);
  }
}

async function previewImageGrid(data) {
  toast('Building preview…');
  try {
    const canvas = await buildGridCanvas(data.nfts, data.rows, data.cols);
    showPreviewImage(canvas.toDataURL());
    toast('Preview ready!', 'success');
  } catch(e) { console.error(e); toast('Failed to build grid', 'error'); }
}

async function previewAnimatedGrid(data) {
  toast('Building animated preview… (this can take 10-30s)');
  try {
    // For GIFs: try real GIF builder (preserves looping, transparency)
    if (data.mediaType === 'gif') {
      try {
        const blob = await buildAnimatedGifGrid(data.nfts, data.rows, data.cols);
        const url = URL.createObjectURL(blob);
        showPreviewImage(url);
        toast(`GIF preview ready! (${(blob.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
        return;
      } catch (e) {
        console.warn('[tools] GIF builder failed, falling back to video:', e.message);
        toast('GIF builder unavailable — exporting as video instead', 'info');
      }
    }
    // For WebP or GIF fallback: use canvas-based video recording
    const blob = await buildAnimatedGridViaCanvas(data.nfts, data.rows, data.cols, data.mediaType);
    const url = URL.createObjectURL(blob);
    showPreviewVideo(url);
    toast(`Preview ready! (${(blob.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
  } catch(e) { console.error(e); toast('Failed: ' + e.message, 'error'); }
}

async function previewVideoGrid(data) {
  toast('Building video preview… (this can take 10-30s)');
  try {
    const blob = await buildVideoGrid(data.nfts, data.rows, data.cols);
    const url = URL.createObjectURL(blob);
    showPreviewVideo(url);
    toast(`Video preview ready! (${(blob.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
  } catch(e) { console.error(e); toast('Failed: ' + e.message, 'error'); }
}

function showPreviewImage(src) {
  const container = document.getElementById('gridPreviewContainer');
  const preview = document.getElementById('gridPreview');
  container.classList.remove('hidden');
  preview.innerHTML = '';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'width:100%;height:auto;display:block;border-radius:8px;';
  preview.appendChild(img);
  container.scrollIntoView({ behavior:'smooth', block:'start' });
}

function showPreviewVideo(src) {
  const container = document.getElementById('gridPreviewContainer');
  const preview = document.getElementById('gridPreview');
  container.classList.remove('hidden');
  preview.innerHTML = '';
  const v = document.createElement('video');
  v.src = src; v.controls = true; v.autoplay = true; v.loop = true; v.muted = true;
  v.style.cssText = 'width:100%;height:auto;display:block;border-radius:8px;';
  preview.appendChild(v);
  container.scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ============================================================
   ANIMATED GRID BUILDERS — GIF and Video
   ============================================================ */

// Lazy-load gif.js from CDN (only when needed)
// Lazy-load gif.js + create a same-origin blob URL for its worker.
// (Browsers block cross-origin Worker scripts, so we have to fetch the
// worker text and turn it into a blob: URL.)
let GIF_WORKER_URL = null;

async function loadGifJS() {
  // Load main library if not present
  if (!window.GIF) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  // Build same-origin worker URL once
  if (!GIF_WORKER_URL) {
    const r = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
    if (!r.ok) throw new Error('Could not fetch gif.worker.js');
    const code = await r.text();
    GIF_WORKER_URL = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  }

  return window.GIF;
}

// Decode a GIF/WebP to a sequence of frames using the browser's
// native ImageDecoder (Chromium/Edge/Safari 17+).
async function decodeAnimatedToFrames(url) {
  if (typeof ImageDecoder === 'undefined') {
    throw new Error('Animated decoding not supported in this browser');
  }
  const r = await fetch(url, { mode: 'cors' }).catch(async () => {
    return fetch('https://corsproxy.io/?' + encodeURIComponent(url));
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  const decoder = new ImageDecoder({
    data: blob.stream(),
    type: blob.type || 'image/gif',
  });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const frameCount = track.frameCount;
  const frames = [];
  let totalDurationMs = 0;
  for (let i = 0; i < frameCount; i++) {
    const { image, duration } = await decoder.decode({ frameIndex: i });
    const durMs = (duration || 100000) / 1000; // microseconds → ms
    frames.push({ bitmap: image, durationMs: durMs });
    totalDurationMs += durMs;
  }
  return { frames, totalDurationMs };
}

// Build an animated GIF where each cell loops its source.
// All cells run at a common timeline; total length = max source length.
async function buildAnimatedGifGrid(nfts, rows, cols) {
  const GIF = await loadGifJS();
  const cellSize = 200; // smaller than PNG to keep filesize manageable
  const sep = Math.max(0, parseInt(document.getElementById('separatorWidth').value) || 0);
  const sepColor = document.getElementById('separatorColor').value || '#0a0505';
  const W = cols * cellSize + (cols + 1) * sep;
  const H = rows * cellSize + (rows + 1) * sep;

  toast('Decoding animated frames…');
  // Decode each NFT in parallel — try multiple URL candidates per NFT
  const decodedSlots = await Promise.all(
    nfts.slice(0, rows * cols).map(async (nft) => {
      // Try every URL we have, in order of likelihood of being animated
      const candidates = [nft?.animation, nft?.rawImage, nft?.image].filter(Boolean);
      for (const url of candidates) {
        try {
          const result = await decodeAnimatedToFrames(url);
          if (result.frames.length > 1) {
            console.info(`[tools] #${nft.id}: decoded ${result.frames.length} frames from ${url.slice(0, 60)}`);
            return result;
          }
          // Single frame? Try next candidate before giving up
          console.info(`[tools] #${nft.id}: ${url.slice(0, 60)} only had 1 frame, trying next URL`);
        } catch (e) {
          console.warn(`[tools] #${nft.id} decode failed for ${url.slice(0, 60)}: ${e.message}`);
        }
      }
      // Fallback: load as static image
      try {
        const url = nft?.image || nft?.animation;
        const img = await loadImg(url, nft);
        return { frames: [{ bitmap: img, durationMs: 100 }], totalDurationMs: 100 };
      } catch (_) {
        return null;
      }
    })
  );

  // Find the longest clip — that's our timeline
  const maxDuration = Math.max(...decodedSlots.filter(Boolean).map(s => s.totalDurationMs), 1000);
  const frameStep = 50; // 20fps output
  const totalFrames = Math.ceil(maxDuration / frameStep);

  toast(`Building ${totalFrames}-frame GIF…`);

  const gif = new GIF({
    workers: 2,
    quality: 10,
    width: W,
    height: H,
    workerScript: GIF_WORKER_URL,   // same-origin blob URL
  });

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  for (let f = 0; f < totalFrames; f++) {
    const tMs = f * frameStep;
    ctx.fillStyle = sepColor;
    ctx.fillRect(0, 0, W, H);

    decodedSlots.forEach((slot, i) => {
      if (!slot) return;
      const r = Math.floor(i / cols), c = i % cols;
      const x = sep + c * (cellSize + sep);
      const y = sep + r * (cellSize + sep);
      const localT = tMs % slot.totalDurationMs;
      const bitmap = pickFrameAtTime(slot.frames, localT);
      if (bitmap) ctx.drawImage(bitmap, x, y, cellSize, cellSize);
    });

    gif.addFrame(ctx, { copy: true, delay: frameStep });
  }

  return new Promise((resolve, reject) => {
    gif.on('finished', resolve);
    gif.on('error', reject);
    gif.render();
  });
}

function pickFrameAtTime(frames, tMs) {
  let acc = 0;
  for (const fr of frames) {
    acc += fr.durationMs;
    if (tMs < acc) return fr.bitmap;
  }
  return frames[frames.length - 1]?.bitmap || null;
}

// Build a WebM video where each cell plays its source video on loop.
// Total length = max source video length.
async function buildVideoGrid(nfts, rows, cols) {
  const cellSize = 256;
  const sep = Math.max(0, parseInt(document.getElementById('separatorWidth').value) || 0);
  const sepColor = document.getElementById('separatorColor').value || '#0a0505';
  const W = cols * cellSize + (cols + 1) * sep;
  const H = rows * cellSize + (rows + 1) * sep;

  toast('Loading source videos…');
  const slots = await Promise.all(
    nfts.slice(0, rows * cols).map(async (nft) => {
      // Try animation first, then rawImage, then image as fallback
      const candidates = [nft?.animation, nft?.rawImage, nft?.image].filter(Boolean);
      for (const url of candidates) {
        const v = await loadVideoElement(url).catch(() => null);
        if (v && v.duration > 0) {
          console.info(`[tools] #${nft.id}: video loaded (${v.duration.toFixed(1)}s) from ${url.slice(0, 60)}`);
          return v;
        }
      }
      console.warn(`[tools] #${nft.id}: no playable video URL`);
      return null;
    })
  );

  const validSlots = slots.filter(Boolean);
  if (!validSlots.length) throw new Error('No videos could be loaded');
  const maxDuration = Math.max(...validSlots.map(v => v.duration || 1));

  // Set up canvas + MediaRecorder
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('Browser does not support WebM recording');

  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  toast(`Recording ${maxDuration.toFixed(1)}s video…`);

  // Start all videos & recorder
  slots.forEach(v => { if (v) { v.currentTime = 0; v.loop = true; v.muted = true; v.play().catch(() => {}); } });
  recorder.start();

  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    let stopped = false;

    function frame() {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed >= maxDuration) {
        if (!stopped) {
          stopped = true;
          recorder.stop();
          slots.forEach(v => { if (v) v.pause(); });
        }
        return;
      }

      ctx.fillStyle = sepColor;
      ctx.fillRect(0, 0, W, H);

      slots.forEach((v, i) => {
        if (!v) return;
        const r = Math.floor(i / cols), c = i % cols;
        const x = sep + c * (cellSize + sep);
        const y = sep + r * (cellSize + sep);
        try { ctx.drawImage(v, x, y, cellSize, cellSize); } catch(_) {}
      });

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.onerror = reject;
  });
}

// Build an animated grid by playing source media (any animated format)
// in HTML <img> elements and recording the canvas to WebM.
// Works for animated GIFs/WebPs/videos — anything the browser can natively animate.
async function buildAnimatedGridViaCanvas(nfts, rows, cols, mediaType) {
  const cellSize = 256;
  const sep = Math.max(0, parseInt(document.getElementById('separatorWidth').value) || 0);
  const sepColor = document.getElementById('separatorColor').value || '#0a0505';
  const W = cols * cellSize + (cols + 1) * sep;
  const H = rows * cellSize + (rows + 1) * sep;

  toast('Loading source media…');

  // Load each NFT as either <img> (gif/webp) or <video> (mp4/webm)
  const slots = await Promise.all(
    nfts.slice(0, rows * cols).map(async (nft) => {
      const candidates = [nft?.animation, nft?.rawImage, nft?.image].filter(Boolean);
      for (const url of candidates) {
        try {
          if (mediaType === 'video') {
            const v = await loadVideoElement(url);
            if (v && v.duration > 0) return { kind: 'video', el: v, duration: v.duration };
          } else {
            // For gif/webp: load as <img>, animation plays automatically
            const img = await loadImg(url, nft);
            return { kind: 'image', el: img, duration: 3 }; // assume 3s default
          }
        } catch (e) {
          console.warn(`[tools] #${nft.id} candidate failed: ${e.message}`);
        }
      }
      return null;
    })
  );

  const validSlots = slots.filter(Boolean);
  if (!validSlots.length) throw new Error('No media could be loaded');
  const maxDuration = Math.max(...validSlots.map(s => s.duration), 1);

  // Setup canvas + recorder
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('Browser does not support WebM recording');

  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  toast(`Recording ${maxDuration.toFixed(1)}s…`);

  // Start playback for videos
  slots.forEach(s => {
    if (s?.kind === 'video') {
      s.el.currentTime = 0;
      s.el.loop = true;
      s.el.muted = true;
      s.el.play().catch(() => {});
    }
  });

  recorder.start();

  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    let stopped = false;

    function frame() {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed >= maxDuration) {
        if (!stopped) {
          stopped = true;
          recorder.stop();
          slots.forEach(s => { if (s?.kind === 'video') s.el.pause(); });
        }
        return;
      }

      ctx.fillStyle = sepColor;
      ctx.fillRect(0, 0, W, H);

      slots.forEach((s, i) => {
        if (!s) return;
        const r = Math.floor(i / cols), c = i % cols;
        const x = sep + c * (cellSize + sep);
        const y = sep + r * (cellSize + sep);
        try { ctx.drawImage(s.el, x, y, cellSize, cellSize); } catch(_) {}
      });

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.onerror = reject;
  });
}

function loadVideoElement(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = src;
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => {
      // Try CORS proxy
      const v2 = document.createElement('video');
      v2.crossOrigin = 'anonymous';
      v2.muted = true;
      v2.src = 'https://corsproxy.io/?' + encodeURIComponent(src);
      v2.onloadedmetadata = () => resolve(v2);
      v2.onerror = () => reject(new Error('Video load failed'));
    };
  });
}

async function downloadGridPNG() {
  const data = getNFTsForGrid(true);
  if (!data) return;

  try {
    if (data.mediaType === 'image') {
      toast('Generating PNG…');
      const canvas = await buildGridCanvas(data.nfts, data.rows, data.cols);
      downloadCanvas(canvas, `undead-grid-${data.rows}x${data.cols}.png`);
      toast('Downloaded!', 'success');
      return;
    }
    if (data.mediaType === 'gif') {
      toast('Generating GIF… (10-30s)');
      try {
        const blob = await buildAnimatedGifGrid(data.nfts, data.rows, data.cols);
        downloadBlob(blob, `undead-grid-${data.rows}x${data.cols}.gif`);
        toast(`Saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)!`, 'success');
      } catch (e) {
        console.warn('[tools] GIF failed, falling back to webm:', e.message);
        toast('GIF unavailable — saving as WebM video instead', 'info');
        const blob = await buildAnimatedGridViaCanvas(data.nfts, data.rows, data.cols, 'gif');
        downloadBlob(blob, `undead-grid-${data.rows}x${data.cols}.webm`);
        toast(`Saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)!`, 'success');
      }
      return;
    }
    if (data.mediaType === 'webp') {
      toast('Generating animated grid… (10-30s)');
      const blob = await buildAnimatedGridViaCanvas(data.nfts, data.rows, data.cols, 'webp');
      downloadBlob(blob, `undead-grid-${data.rows}x${data.cols}.webm`);
      toast(`Saved as WebM video (${(blob.size / 1024 / 1024).toFixed(1)} MB)!`, 'success');
      return;
    }
    if (data.mediaType === 'video') {
      toast('Generating video… (10-30s)');
      const blob = await buildVideoGrid(data.nfts, data.rows, data.cols);
      downloadBlob(blob, `undead-grid-${data.rows}x${data.cols}.webm`);
      toast(`Saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)!`, 'success');
      return;
    }
  } catch(e) { console.error(e); toast('Export failed: ' + e.message, 'error'); }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function downloadAllZip() {
  if (!walletNFTs.length) { toast('Load a wallet first', 'error'); return; }
  if (typeof JSZip === 'undefined') {
    await new Promise((res,rej) => {
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload=res; s.onerror=rej; document.head.appendChild(s);
    }).catch(()=>{ toast('Could not load JSZip','error'); return; });
  }
  toast('Zipping images…');
  const zip=new JSZip(); let ok=0, fail=0;

  for (const nft of walletNFTs) {
    if (!nft.image) continue;
    let blob = null;

    // Tier 1: direct fetch
    try {
      const r = await fetch(nft.image, { mode: 'cors' });
      if (r.ok) blob = await r.blob();
    } catch(_) {}

    // Tier 2: CORS proxy fallback
    if (!blob) {
      try {
        const r = await fetch('https://corsproxy.io/?' + encodeURIComponent(nft.image));
        if (r.ok) blob = await r.blob();
      } catch(_) {}
    }

    if (blob) {
      zip.file(`undead-${nft.id}.png`, blob);
      ok++;
    } else {
      fail++;
    }
  }

  if (fail > 0) console.warn(`[tools] ${fail} images skipped during ZIP build`);
  if (!ok) { toast('Could not fetch any images','error'); return; }
  const blob=await zip.generateAsync({type:'blob'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download='undeads-collection.zip'; a.click();
  toast(`Saved ${ok} images in ZIP`,'success');
}

function resetGrid() {
  selectedForGrid=[];
  lastRandomGrid=null;
  document.querySelectorAll('.stake-nft-card').forEach(c=>c.classList.remove('selected'));
  document.getElementById('gridPreviewContainer')?.classList.add('hidden');
  updateGridSelCount();
  toast('Grid reset');
}

/* ============================================================
   SECTION 3 - WALLPAPER MAKER
   ============================================================ */

const WP = {
  canvas:null, ctx:null,
  W:1170, H:2532,
  background:'linear-gradient(180deg,#3d0000 0%,#0a0505 100%)',
  bgImage:null,
  pattern:null,
  characters:[], selected:null,
  dragging:false, resizing:false, resizeHandle:null,
  dragOff:{x:0,y:0},
  removeBackground:true,
  customGrad:{c1:'#3d0000',c2:'#0a0505',c3:'#140808',angle:180,three:true}
};

const PATTERNS=[
  {id:'none',icon:'✕',label:'None'},
  {id:'dots',icon:'·',label:'Dots'},
  {id:'grid',icon:'⊞',label:'Grid'},
  {id:'diagonal',icon:'╱',label:'Lines'},
  {id:'hexagon',icon:'⬡',label:'Hex'},
  {id:'waves',icon:'〜',label:'Waves'},
  {id:'circles',icon:'◯',label:'Circles'},
  {id:'stars',icon:'★',label:'Stars'},
  {id:'crosshatch',icon:'⊠',label:'Cross'},
  {id:'triangles',icon:'△',label:'Tris'},
];

function initWallpaper() {
  WP.canvas=document.getElementById('wallpaperCanvas');
  if (!WP.canvas) return;
  WP.ctx=WP.canvas.getContext('2d');
  WP.canvas.width=WP.W; WP.canvas.height=WP.H;
  buildPatternButtons();
  updateGradientPreview();
  drawWallpaper();
  setupWallpaperCanvasEvents();
  setupWallpaperControls();
}

function buildPatternButtons() {
  const cont=document.getElementById('patternOptions');
  if (!cont) return;
  cont.innerHTML='';
  PATTERNS.forEach(p=>{
    const btn=document.createElement('div');
    btn.className='pattern-opt'; btn.title=p.label;
    btn.innerHTML=`<span style="font-size:18px;">${p.icon}</span>`;
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.pattern-opt').forEach(b=>b.classList.remove('selected'));
      WP.pattern=(p.id==='none')?null:p.id;
      if(WP.pattern) btn.classList.add('selected');
      drawWallpaper();
    });
    cont.appendChild(btn);
  });
}

function setupWallpaperControls() {
  document.querySelectorAll('.bg-option').forEach(el=>{
    el.addEventListener('click',()=>{
      document.querySelectorAll('.bg-option').forEach(b=>b.classList.remove('selected'));
      el.classList.add('selected');
      WP.background=el.dataset.bg; WP.bgImage=null;
      drawWallpaper();
    });
  });

  document.getElementById('wallpaperBgUpload')?.addEventListener('change',async e=>{
    const f=e.target.files[0]; if(!f) return;
    try {
      WP.bgImage=await loadImg(URL.createObjectURL(f));
      WP.background=null;
      document.querySelectorAll('.bg-option').forEach(b=>b.classList.remove('selected'));
      drawWallpaper(); toast('Background uploaded!','success');
    } catch(_){ toast('Could not load image','error'); }
  });

  document.getElementById('patternColor')?.addEventListener('input',()=>drawWallpaper());
  document.getElementById('patternOpacity')?.addEventListener('input',e=>{
    const lbl=document.getElementById('patternOpacityVal');
    if(lbl) lbl.textContent=e.target.value+'%';
    drawWallpaper();
  });

  [['gradientColor1','c1'],['gradientColor2','c2'],['gradientColor3','c3']].forEach(([id,key])=>{
    document.getElementById(id)?.addEventListener('input',e=>{ WP.customGrad[key]=e.target.value; updateGradientPreview(); drawWallpaper(); });
  });
  document.getElementById('gradientAngle')?.addEventListener('input',e=>{
    WP.customGrad.angle=+e.target.value;
    const lbl=document.getElementById('gradientAngleValue'); if(lbl) lbl.textContent=e.target.value+'°';
    updateGradientPreview(); drawWallpaper();
  });

  const threeToggle=document.getElementById('threeColorToggle');
  threeToggle?.addEventListener('click',()=>{
    threeToggle.classList.toggle('active');
    WP.customGrad.three=threeToggle.classList.contains('active');
    const c3box=document.getElementById('gradientColor3Container');
    if(c3box) c3box.style.display=WP.customGrad.three?'':'none';
    updateGradientPreview(); drawWallpaper();
  });

  document.getElementById('applyCustomGradient')?.addEventListener('click',()=>{
    WP.background='__custom__'; WP.bgImage=null;
    document.querySelectorAll('.bg-option').forEach(b=>b.classList.remove('selected'));
    drawWallpaper(); toast('Custom gradient applied!','success');
  });

  const bgToggle=document.getElementById('removeBackgroundToggle');
  if(bgToggle){
    bgToggle.classList.add('active');
    bgToggle.addEventListener('click',()=>{
      bgToggle.classList.toggle('active');
      WP.removeBackground=bgToggle.classList.contains('active');
      drawWallpaper();
    });
  }

  document.querySelectorAll('.device-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.device-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      WP.W=+btn.dataset.w; WP.H=+btn.dataset.h;
      WP.canvas.width=WP.W; WP.canvas.height=WP.H;
      drawWallpaper();
    });
  });

  document.getElementById('downloadWallpaper')?.addEventListener('click',exportWallpaper);
  document.getElementById('downloadCharacter')?.addEventListener('click',()=>exportCharacter(true));
  document.getElementById('downloadCharacterNoBg')?.addEventListener('click',()=>exportCharacter(false));
  document.getElementById('resetWallpaper')?.addEventListener('click',()=>{
    WP.characters=[]; WP.selected=null;
    updateCharacterStrip(); drawWallpaper(); toast('Wallpaper reset');
  });
}

function updateGradientPreview() {
  const p=document.getElementById('gradientPreview'); if(!p) return;
  const g=WP.customGrad;
  p.style.background=g.three
    ? `linear-gradient(${g.angle}deg,${g.c1} 0%,${g.c2} 50%,${g.c3} 100%)`
    : `linear-gradient(${g.angle}deg,${g.c1} 0%,${g.c2} 100%)`;
}

function setupWallpaperCanvasEvents() {
  const cv=WP.canvas;
  const getCoords=e=>{
    const rect=cv.getBoundingClientRect();
    const sx=WP.canvas.width/rect.width, sy=WP.canvas.height/rect.height;
    const src=e.touches?e.touches[0]:e;
    return {x:(src.clientX-rect.left)*sx, y:(src.clientY-rect.top)*sy};
  };
  const findChar=(x,y)=>{
    for(let i=WP.characters.length-1;i>=0;i--){
      const ch=WP.characters[i];
      if(x>=ch.x&&x<=ch.x+ch.w&&y>=ch.y&&y<=ch.y+ch.h) return ch;
    }
    return null;
  };
  const getHandle=(ch,x,y)=>{
    const hs=Math.max(40,WP.canvas.width*.025);
    const corners={nw:[ch.x,ch.y],ne:[ch.x+ch.w,ch.y],sw:[ch.x,ch.y+ch.h],se:[ch.x+ch.w,ch.y+ch.h]};
    for(const[k,[hx,hy]] of Object.entries(corners)) if(Math.abs(x-hx)<hs&&Math.abs(y-hy)<hs) return k;
    return null;
  };

  const onDown=e=>{
    e.preventDefault();
    const{x,y}=getCoords(e);
    if(WP.selected){const h=getHandle(WP.selected,x,y);if(h){WP.resizing=true;WP.resizeHandle=h;return;}}
    const ch=findChar(x,y);
    if(ch){
      WP.selected=ch; WP.dragging=true; WP.dragOff={x:x-ch.x,y:y-ch.y};
      WP.characters=WP.characters.filter(c=>c!==ch); WP.characters.push(ch);
      updateCharacterStrip();
    } else { WP.selected=null; updateCharacterStrip(); }
    drawWallpaper();
  };

  const onMove=e=>{
    e.preventDefault();
    const{x,y}=getCoords(e);
    if(WP.dragging&&WP.selected){WP.selected.x=x-WP.dragOff.x;WP.selected.y=y-WP.dragOff.y;drawWallpaper();}
    if(WP.resizing&&WP.selected){
      const ch=WP.selected,ar=ch.origW/ch.origH;
      switch(WP.resizeHandle){
        case'se':ch.w=Math.max(40,x-ch.x);ch.h=ch.w/ar;break;
        case'sw':{const nw=Math.max(40,ch.x+ch.w-x);ch.x=x;ch.w=nw;ch.h=nw/ar;}break;
        case'ne':{const nw=Math.max(40,x-ch.x),nh=nw/ar;ch.w=nw;ch.y=ch.y+ch.h-nh;ch.h=nh;}break;
        case'nw':{const nw=Math.max(40,ch.x+ch.w-x),nh=nw/ar;ch.x=x;ch.y=ch.y+ch.h-nh;ch.w=nw;ch.h=nh;}break;
      }
      drawWallpaper();
    }
  };

  const onUp=()=>{WP.dragging=false;WP.resizing=false;WP.resizeHandle=null;};
  cv.addEventListener('mousedown',onDown);
  cv.addEventListener('mousemove',onMove);
  cv.addEventListener('mouseup',onUp);
  cv.addEventListener('mouseleave',onUp);
  cv.addEventListener('touchstart',onDown,{passive:false});
  cv.addEventListener('touchmove',onMove,{passive:false});
  cv.addEventListener('touchend',onUp);
}

function drawWallpaper(ctx,w,h){
  ctx=ctx||WP.ctx; w=w||WP.canvas.width; h=h||WP.canvas.height;
  ctx.clearRect(0,0,w,h);

  if(WP.bgImage){
    ctx.drawImage(WP.bgImage,0,0,w,h);
  } else if(!WP.background||WP.background==='__custom__'){
    const g=WP.customGrad,rad=(g.angle-90)*Math.PI/180,len=Math.hypot(w,h)/2;
    const gr=ctx.createLinearGradient(w/2-Math.cos(rad)*len,h/2-Math.sin(rad)*len,w/2+Math.cos(rad)*len,h/2+Math.sin(rad)*len);
    gr.addColorStop(0,g.c1);
    if(g.three){gr.addColorStop(.5,g.c2);gr.addColorStop(1,g.c3);}else gr.addColorStop(1,g.c2);
    ctx.fillStyle=gr;ctx.fillRect(0,0,w,h);
  } else {
    const colors=WP.background.match(/#[0-9a-fA-F]{6}/g)||['#1a0808','#0a0505'];
    const gr=ctx.createLinearGradient(0,0,0,h);
    colors.forEach((c,i)=>gr.addColorStop(i/Math.max(colors.length-1,1),c));
    ctx.fillStyle=gr;ctx.fillRect(0,0,w,h);
  }

  if(WP.pattern){
    const color=document.getElementById('patternColor')?.value||'#c8a450';
    const opacity=+(document.getElementById('patternOpacity')?.value||15)/100;
    drawPattern(ctx,WP.pattern,w,h,color,opacity);
  }

  WP.characters.forEach(ch=>{
    const img=(WP.removeBackground&&ch.noBgImg)?ch.noBgImg:ch.origImg;
    if(!img) return;
    ctx.drawImage(img,ch.x,ch.y,ch.w,ch.h);
    if(ch===WP.selected){
      const lw=Math.max(4,w*.003),hs=Math.max(18,w*.018);
      ctx.save();
      ctx.strokeStyle='#c8a450';ctx.lineWidth=lw;ctx.setLineDash([18,9]);
      ctx.strokeRect(ch.x,ch.y,ch.w,ch.h);ctx.setLineDash([]);
      ctx.fillStyle='#c8a450';
      [[ch.x,ch.y],[ch.x+ch.w,ch.y],[ch.x,ch.y+ch.h],[ch.x+ch.w,ch.y+ch.h]].forEach(([hx,hy])=>{
        ctx.beginPath();ctx.arc(hx,hy,hs,0,Math.PI*2);ctx.fill();
      });
      ctx.restore();
    }
  });
}

function drawPattern(ctx,id,w,h,color,opacity){
  ctx.save();ctx.globalAlpha=opacity;ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2;
  switch(id){
    case'dots':{const sp=60,r=5;for(let y=sp/2;y<h;y+=sp)for(let x=sp/2;x<w;x+=sp){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}break;}
    case'grid':{const sp=80;for(let x=0;x<=w;x+=sp){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<=h;y+=sp){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}break;}
    case'diagonal':{const sp=50;for(let i=-h;i<w+h;i+=sp){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i+h,h);ctx.stroke();}break;}
    case'hexagon':{const s=45,hh=s*Math.sqrt(3);for(let row=-1;row<h/hh+1;row++)for(let col=-1;col<w/(s*1.5)+1;col++){const cx=col*s*1.5,cy=row*hh+(col%2?hh/2:0);ctx.beginPath();for(let k=0;k<6;k++){const a=(k*60-30)*Math.PI/180;const hx=cx+s*.9*Math.cos(a),hy=cy+s*.9*Math.sin(a);k?ctx.lineTo(hx,hy):ctx.moveTo(hx,hy);}ctx.closePath();ctx.stroke();}break;}
    case'waves':{const sp=60,amp=18,freq=80;for(let y=0;y<h+sp;y+=sp){ctx.beginPath();ctx.moveTo(0,y);for(let x=0;x<w;x+=4)ctx.lineTo(x,y+Math.sin(x/freq*Math.PI*2)*amp);ctx.stroke();}break;}
    case'circles':{const sp=100;for(let y=sp/2;y<h;y+=sp)for(let x=sp/2;x<w;x+=sp){ctx.beginPath();ctx.arc(x,y,sp*.35,0,Math.PI*2);ctx.stroke();}break;}
    case'stars':{let s=42;const rng=()=>{s=(s*1664525+1013904223)&0xffffffff;return(s>>>0)/0xffffffff;};for(let k=0;k<120;k++){const sx=rng()*w,sy=rng()*h,sz=rng()*4+1;ctx.beginPath();for(let i=0;i<5;i++){const a=(i*144-90)*Math.PI/180;const px=sx+sz*Math.cos(a),py=sy+sz*Math.sin(a);i?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.closePath();ctx.fill();}break;}
    case'crosshatch':{const sp=30;for(let i=-h;i<w+h;i+=sp){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i+h,h);ctx.stroke();ctx.beginPath();ctx.moveTo(i+h,0);ctx.lineTo(i,h);ctx.stroke();}break;}
    case'triangles':{const s=60,th=s*Math.sqrt(3)/2;ctx.lineWidth=1;for(let row=-1;row<h/th+1;row++)for(let col=-1;col<w/s+2;col++){const ox=col*s+(row%2?s/2:0),oy=row*th;ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(ox+s/2,oy+th);ctx.lineTo(ox-s/2,oy+th);ctx.closePath();ctx.stroke();}break;}
  }
  ctx.restore();
}

async function removeBG(img){
  const cv=document.createElement('canvas');
  cv.width=img.naturalWidth||img.width; cv.height=img.naturalHeight||img.height;
  const cx=cv.getContext('2d'); cx.drawImage(img,0,0);
  const idata=cx.getImageData(0,0,cv.width,cv.height),data=idata.data,W=cv.width,H=cv.height;
  const sp=Math.max(3,Math.floor(Math.min(W,H)*.04)),samples=[];
  const samp=(x0,y0,x1,y1)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*W+x)*4;samples.push([data[i],data[i+1],data[i+2]]);}};
  samp(0,0,sp,sp);samp(W-sp,0,W,sp);samp(0,H-sp,sp,H);samp(W-sp,H-sp,W,H);
  const meds=[0,1,2].map(ch=>{const v=samples.map(s=>s[ch]).sort((a,b)=>a-b);return v[Math.floor(v.length/2)];});
  const tol=35,soft=55,alpha=new Uint8Array(W*H).fill(255),seen=new Uint8Array(W*H);
  const dist=i=>Math.sqrt(Math.pow(data[i]-meds[0],2)+Math.pow(data[i+1]-meds[1],2)+Math.pow(data[i+2]-meds[2],2));
  const stack=[];
  const push=(x,y)=>{if(x>=0&&x<W&&y>=0&&y<H&&!seen[y*W+x])stack.push(y*W+x);};
  for(let x=0;x<W;x++){push(x,0);push(x,H-1);}
  for(let y=0;y<H;y++){push(0,y);push(W-1,y);}
  while(stack.length){
    const idx=stack.pop();if(seen[idx])continue;seen[idx]=1;
    const d=dist(idx*4);if(d>soft)continue;
    alpha[idx]=d<tol?0:Math.floor((d-tol)/(soft-tol)*255);
    const x=idx%W,y=Math.floor(idx/W);push(x+1,y);push(x-1,y);push(x,y+1);push(x,y-1);
  }
  for(let i=0;i<W*H;i++) data[i*4+3]=alpha[i];
  cx.putImageData(idata,0,0);
  const out=new Image(); out.src=cv.toDataURL('image/png');
  await new Promise(r=>{out.onload=r;}); return out;
}

async function addCharacterToWallpaper(nft){
  toast('Adding character…');
  let origImg;
  try { origImg=await loadImg(nft.image, nft); }
  catch(_){ toast('Could not load character image','error'); return; }
  const noBgImg=WP.removeBackground?await removeBG(origImg):null;
  const canvas=WP.canvas;
  const defSize=Math.min(canvas.width,canvas.height)*.38;
  const origW=origImg.naturalWidth||origImg.width, origH=origImg.naturalHeight||origImg.height;
  const ar=origW/origH;
  const ch={
    id:Date.now()+Math.random(), nft,
    origImg, noBgImg, origW, origH,
    x:(canvas.width-defSize*ar)/2, y:canvas.height*.35,
    w:defSize*ar, h:defSize
  };
  WP.characters.push(ch); WP.selected=ch;
  updateCharacterStrip(); drawWallpaper();
  toast('Character added! Drag to move, corners to resize.','success');
}

function updateCharacterStrip(){
  const strip=document.getElementById('wallpaperSelectedNFT'); if(!strip) return;
  if(!WP.characters.length){
    strip.innerHTML=`<p class="muted" style="font-size:.86rem;width:100%;text-align:center;font-style:italic;font-family:'Geist Mono',monospace;">Click an NFT from your wallet to add</p>`;
    return;
  }
  strip.innerHTML=WP.characters.map(ch=>`
    <div style="position:relative;display:inline-block;" data-chid="${ch.id}">
      <img src="${ch.nft.image}"
           style="width:48px;height:48px;border-radius:8px;object-fit:cover;image-rendering:pixelated;cursor:pointer;
                  border:2px solid ${ch===WP.selected?'var(--accent)':'var(--glass-border)'};
                  filter:${ch===WP.selected?'none':'sepia(.15) brightness(.8)'};transition:all .2s;"
           onerror="this.src='https://placehold.co/48x48/140808/c8a450?text=%23${ch.nft.id}'"/>
      <button onclick="removeWPChar('${ch.id}')"
              style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;
                     background:#8b1a1a;border:1px solid rgba(255,100,100,.4);color:#fff;
                     font-size:9px;cursor:pointer;line-height:18px;text-align:center;padding:0;">✕</button>
    </div>`).join('');
  strip.querySelectorAll('[data-chid] img').forEach(img=>{
    img.addEventListener('click',()=>{
      const id=+img.closest('[data-chid]').dataset.chid;
      WP.selected=WP.characters.find(c=>c.id===id)||null;
      updateCharacterStrip(); drawWallpaper();
    });
  });
}

window.removeWPChar=id=>{
  WP.characters=WP.characters.filter(c=>c.id!=id);
  if(WP.selected?.id==id) WP.selected=null;
  updateCharacterStrip(); drawWallpaper();
};

function exportWallpaper(){
  const cv=document.createElement('canvas'); cv.width=WP.canvas.width; cv.height=WP.canvas.height;
  const cx=cv.getContext('2d'), prev=WP.selected;
  WP.selected=null; drawWallpaper(cx,cv.width,cv.height); WP.selected=prev;
  downloadCanvas(cv,'undead-wallpaper.png'); toast('Wallpaper saved!','success');
}

function exportCharacter(withBG){
  if(!WP.selected){ toast('Select a character on the canvas first','error'); return; }
  const ch=WP.selected;
  const cv=document.createElement('canvas'); cv.width=ch.origW; cv.height=ch.origH;
  const cx=cv.getContext('2d');
  cx.drawImage(withBG?ch.origImg:(ch.noBgImg||ch.origImg),0,0);
  downloadCanvas(cv,`undead-char-${withBG?'withbg':'nobg'}.png`); toast('Character saved!','success');
}

/* ============================================================
   SECTION 4 - COLLECTION EXPLORER
   ============================================================ */

const EX={page:0,pageSize:48,current:[]};

async function exLoad(){
  const searchVal=document.getElementById('exSearch').value.trim();
  const from=parseInt(document.getElementById('exFrom').value)||0;
  const to=parseInt(document.getElementById('exTo').value)||47;
  const grid=document.getElementById('exGrid');
  const pager=document.getElementById('exPager');
  const detail=document.getElementById('exDetail');
  detail.innerHTML=''; pager.style.display='none';

  if(searchVal!==''){
    const id=parseInt(searchVal);
    if(!isNaN(id)&&id>=0&&id<=4999){ await exLoadSingle(id); return; }
  }

  EX.page=0; EX.current=[];
  for(let i=Math.max(0,from);i<=Math.min(4999,to);i++) EX.current.push(i);
  renderExPage();
}

function renderExPage(){
  const grid=document.getElementById('exGrid');
  const pager=document.getElementById('exPager');
  const info=document.getElementById('pgInfo');
  const start=EX.page*EX.pageSize;
  const slice=EX.current.slice(start,start+EX.pageSize);
  grid.innerHTML='';
  slice.forEach(id=>grid.appendChild(makeExCard(id)));
  const total=Math.ceil(EX.current.length/EX.pageSize);
  pager.style.display=(total>1)?'flex':'none';
  if(total>1){
    info.textContent=`Page ${EX.page+1} / ${total}`;
    document.getElementById('pgPrev').disabled=EX.page===0;
    document.getElementById('pgNext').disabled=EX.page>=total-1;
  }
}

function makeExCard(id){
  const a=document.createElement('a');
  a.className='token-card';
  a.href=`https://opensea.io/assets/base/${CONFIG.nft}/${id}`;
  a.target='_blank'; a.rel='noopener';
  a.innerHTML=`
    <img src="https://placehold.co/300x300/140808/c8a450?text=%23${id}"
         alt="Undead #${id}" loading="lazy" id="ex-img-${id}"
         style="width:100%;aspect-ratio:1;object-fit:cover;image-rendering:pixelated;display:block;"/>
    <div class="token-card-body"><span class="token-card-id">#${id}</span></div>`;

  const observer=new IntersectionObserver(async entries=>{
    if(!entries[0].isIntersecting) return;
    observer.disconnect();
    const meta=await fetchTokenMetaOS(id);
    if(meta?.image){ const el=document.getElementById(`ex-img-${id}`); if(el) el.src=meta.image; }
  },{rootMargin:'200px'});
  observer.observe(a);
  return a;
}

async function fetchTokenMetaOS(id){
  try {
    const r=await fetch(`https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.nft}/nfts/${id}`,
      {headers:{'X-API-KEY':OPENSEA_KEY||'','accept':'application/json'}});
    if(!r.ok) return null;
    const d=await r.json(); const n=d.nft||{};
    return {name:n.name,image:proxyUrl(n.image_url||n.display_image_url||''),attributes:n.traits||[]};
  } catch(_){ return null; }
}

async function exLoadSingle(id){
  const grid=document.getElementById('exGrid'),detail=document.getElementById('exDetail');
  grid.innerHTML=`<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">
    <i class="fas fa-spinner fa-spin" style="font-size:24px;"></i></div>`;
  const meta=await fetchTokenMetaOS(id);
  grid.innerHTML='';
  const a=document.createElement('a'); a.className='token-card';
  a.href=`https://opensea.io/assets/base/${CONFIG.nft}/${id}`; a.target='_blank'; a.rel='noopener';
  a.innerHTML=`
    <img src="${meta?.image||'https://placehold.co/300x300/140808/c8a450?text=%23'+id}"
         alt="Undead #${id}" style="width:100%;aspect-ratio:1;object-fit:cover;image-rendering:pixelated;"
         onerror="this.src='https://placehold.co/300x300/140808/c8a450?text=%23${id}'"/>
    <div class="token-card-body"><span class="token-card-id">#${id}</span></div>`;
  grid.appendChild(a);
  if(meta?.attributes?.length){
    detail.innerHTML=`
      <div class="card" style="padding:24px;margin-top:20px;">
        <div class="eyebrow mb-16">Traits - ${meta.name||'Undead #'+id}</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          ${meta.attributes.map(a=>`
            <div style="background:rgba(200,164,80,.08);border:1px solid rgba(200,164,80,.25);border-radius:12px;padding:10px 16px;">
              <div style="font-family:'Geist Mono',monospace;font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:4px;">${a.trait_type||'Trait'}</div>
              <div style="font-family:'Instrument Serif',serif;font-size:16px;">${a.value}</div>
            </div>`).join('')}
        </div>
      </div>`;
  } else if(!meta){
    detail.innerHTML=`<p style="color:#ff6b6b;font-family:'Geist Mono',monospace;font-size:12px;margin-top:12px;">Token #${id} not found or not yet minted.</p>`;
  }
}

/* ============================================================
   INIT - fetch API keys first, then boot everything
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {

  /* STEP 1: Fetch API keys from Netlify - same as script.js */
  await initializeAPIKeys();

  /* Wallet loader */
  document.getElementById('fetchNFTs')?.addEventListener('click', onFetchNFTs);
  document.getElementById('collectionSelect')?.addEventListener('change', function() {
    const val      = this.value;
    const filtered = val
      ? (userCollections.get(val.toLowerCase())?.nfts || [])
      : walletNFTs;
    currentDisplayedNFTs = filtered;
    selectedForGrid = [];
    lastRandomGrid = null;
    updateGridSelCount();
    renderWalletGrid(filtered);
    document.getElementById('nftCount').textContent = filtered.length + ' NFTs';
  });
  document.getElementById('walletAddress')?.addEventListener('keydown', e => {
    if (e.key==='Enter') onFetchNFTs();
  });

  /* Grid maker */
  const gridToggle=document.getElementById('gridModeToggle');
  const gridOpts=document.getElementById('gridOptions');
  gridToggle?.addEventListener('click',()=>{
    gridToggle.classList.toggle('active');
    gridOpts?.classList.toggle('hidden');
  });
  document.getElementById('gridSize')?.addEventListener('change',function(){
    document.getElementById('customGridSizeInput')?.classList.toggle('hidden',this.value!=='custom');
  });

  if(gridOpts){
    const ct=document.createElement('span'); ct.id='gridSelCount';
    ct.style.cssText=`font-family:'Geist Mono',monospace;font-size:11px;color:var(--muted-2);display:block;margin-bottom:12px;`;
    ct.textContent='0 selected';
    const firstRow=gridOpts.querySelector('.grid-opts-row');
    if(firstRow) gridOpts.insertBefore(ct,firstRow); else gridOpts.prepend(ct);
  }

  document.getElementById('previewGrid')?.addEventListener('click', previewGrid);
  document.getElementById('downloadGrid')?.addEventListener('click', downloadGridPNG);
  document.getElementById('downloadAll')?.addEventListener('click',  downloadAllZip);
  document.getElementById('resetGrid')?.addEventListener('click',    resetGrid);

  /* Wallpaper maker */
  initWallpaper();

  /* Smooth anchor scroll */
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',e=>{
      const target=document.querySelector(a.getAttribute('href'));
      if(target){e.preventDefault();target.scrollIntoView({behavior:'smooth',block:'start'});}
    });
  });

  /* Mobile menu */
  document.getElementById('hamburger')?.addEventListener('click',()=>document.getElementById('mobileMenu')?.classList.toggle('open'));
  document.getElementById('mobileMenuClose')?.addEventListener('click',()=>document.getElementById('mobileMenu')?.classList.remove('open'));
});