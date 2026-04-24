/* ============================================================
   BASED UNDEADS — tools.js
   Handles: Wallet NFT loader · NFT Grid Maker · Wallpaper Maker
            · Collection Explorer
   All reads from CONFIG injected by config.js / tools.html inline
   ============================================================ */

'use strict';

// ── Tiny toast helper ────────────────────────────────────────
function toast(msg, type = 'info') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  const colors = { info: '#c8a450', success: '#3ecf8e', error: '#ff6b6b' };
  el.style.cssText = `
    display:inline-flex;align-items:center;gap:10px;
    background:rgba(10,5,5,.96);border:1px solid ${colors[type] || colors.info};
    color:${colors[type] || colors.info};
    padding:12px 22px;border-radius:100px;
    font-family:'Geist Mono',monospace;font-size:12px;letter-spacing:.06em;
    box-shadow:0 8px 32px rgba(0,0,0,.6);
    animation:fadeUp .25s ease;margin:6px 0;
  `;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

// ── Image loader ────────────────────────────────────────────
function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ── IPFS proxy ──────────────────────────────────────────────
function proxyUrl(url) {
  if (!url) return 'https://placehold.co/300x300/140808/c8a450?text=☠';
  if (url.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + url.slice(7);
  if (url.startsWith('ar://'))   return 'https://arweave.net/'   + url.slice(5);
  return url;
}

// ── Download canvas as PNG ───────────────────────────────────
function downloadCanvas(canvas, name) {
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ============================================================
   SECTION 1 — WALLET NFT LOADER
   ============================================================ */

let walletNFTs = [];        // all loaded NFTs for this session
let selectedForGrid = [];   // NFTs ticked for grid

async function onFetchNFTs() {
  const addrEl = document.getElementById('walletAddress');
  const chain  = document.getElementById('chainSelect').value;
  const raw    = addrEl.value.trim();
  if (!raw) { toast('Enter a wallet address or ENS name', 'error'); return; }

  let addr = raw;
  if (raw.endsWith('.eth')) {
    toast('Resolving ENS…');
    addr = await resolveENS(raw);
    if (!addr) { toast('Could not resolve ENS: ' + raw, 'error'); return; }
    toast('Resolved → ' + addr.slice(0,6) + '…' + addr.slice(-4), 'success');
  }

  setNFTGridLoading();
  try {
    if (chain === 'onchain') {
      walletNFTs = await fetchOnchain(addr);
    } else {
      walletNFTs = await fetchOpenSea(addr, chain);
    }
    renderWalletGrid(walletNFTs);
    document.getElementById('nftCount').textContent = walletNFTs.length + ' NFTs';
    if (!walletNFTs.length) toast('No NFTs found in this wallet', 'info');
    else toast('Loaded ' + walletNFTs.length + ' NFTs', 'success');
  } catch (e) {
    console.error(e);
    toast('Failed to load NFTs', 'error');
    setNFTGridError();
  }
}

async function resolveENS(name) {
  try {
    const r = await fetch('https://api.ensdata.net/' + name);
    if (r.ok) { const d = await r.json(); if (d.address) return d.address; }
    const r2 = await fetch('https://api.web3.bio/profile/ens/' + name);
    if (r2.ok) { const d2 = await r2.json(); if (d2.address) return d2.address; }
  } catch(_) {}
  return null;
}

/* -- Onchain loader (testnet contract via ethers) ----------- */
async function fetchOnchain(addr) {
  if (typeof ethers === 'undefined') { toast('ethers.js not loaded', 'error'); return []; }

  const ABI_BALANCE = ['function balanceOf(address) view returns (uint256)'];
  const ABI_OWNED   = ['function tokensOfOwner(address) view returns (uint256[])'];
  const ABI_TOKEN   = ['function tokenURI(uint256) view returns (string)'];

  const provider  = new ethers.JsonRpcProvider(CONFIG.rpc);
  const nftAddr   = CONFIG.nft;

  // Try tokensOfOwner first (ERC721Enumerable extension common in this project)
  let tokenIds = [];
  try {
    const c = new ethers.Contract(nftAddr, ABI_OWNED, provider);
    const ids = await c.tokensOfOwner(addr);
    tokenIds = ids.map(n => Number(n));
  } catch (_) {
    // Fallback: bruteforce via Transfer events would be expensive, use tokenURI loop
    // For this contract we'll try balance + sequential scan (capped)
    try {
      const c2 = new ethers.Contract(nftAddr, ABI_BALANCE, provider);
      const bal = Number(await c2.balanceOf(addr));
      if (!bal) return [];
      // Use storage contract to read token list
      tokenIds = await fetchOnchainStorage(addr, bal);
    } catch (_2) {
      return [];
    }
  }

  if (!tokenIds.length) return [];

  const tokenContract = new ethers.Contract(nftAddr, ABI_TOKEN, provider);
  const nfts = [];

  for (const id of tokenIds) {
    try {
      const uri = await tokenContract.tokenURI(id);
      const meta = await resolveTokenURI(uri);
      nfts.push({
        id: String(id),
        name: meta.name || 'Undead #' + id,
        image: proxyUrl(meta.image || ''),
        source: 'onchain'
      });
    } catch (_) {
      nfts.push({ id: String(id), name: 'Undead #' + id, image: proxyUrl(''), source: 'onchain' });
    }
  }
  return nfts;
}

async function fetchOnchainStorage(addr, balance) {
  // Try the storage contract if available
  try {
    const ABI = ['function tokensOfOwner(address) view returns (uint256[])'];
    const provider = new ethers.JsonRpcProvider(CONFIG.rpc);
    const c = new ethers.Contract(CONFIG.storage || CONFIG.nft, ABI, provider);
    const ids = await c.tokensOfOwner(addr);
    return ids.map(n => Number(n));
  } catch (_) { return []; }
}

async function resolveTokenURI(uri) {
  if (!uri) return {};
  if (uri.startsWith('data:application/json')) {
    const json = uri.includes('base64,')
      ? atob(uri.split('base64,')[1])
      : decodeURIComponent(uri.split(',').slice(1).join(','));
    return JSON.parse(json);
  }
  const url = proxyUrl(uri);
  const r = await fetch(url);
  return r.ok ? r.json() : {};
}

/* -- OpenSea loader ----------------------------------------- */
async function fetchOpenSea(addr, chainKey) {
  const chainMap = { base: 'base', ethereum: 'ethereum', apechain: 'ape_chain' };
  const chain = chainMap[chainKey] || 'base';
  const key   = (typeof CONFIG !== 'undefined' && CONFIG.OPENSEA_API_KEY) || '';

  const nfts = [];
  let cursor  = null;
  let page    = 0;

  do {
    let url = `https://api.opensea.io/api/v2/chain/${chain}/account/${addr}/nfts?limit=200`;
    if (cursor) url += '&next=' + encodeURIComponent(cursor);
    const r = await fetch(url, {
      headers: { 'X-API-KEY': key, 'accept': 'application/json' }
    });
    if (!r.ok) break;
    const d = await r.json();
    (d.nfts || []).forEach(n => {
      nfts.push({
        id: n.identifier,
        name: n.name || '#' + n.identifier,
        image: proxyUrl(n.image_url || n.display_image_url || ''),
        collection: n.collection,
        contract: n.contract,
        source: chain
      });
    });
    cursor = d.next || null;
    page++;
    if (cursor) await sleep(250);
  } while (cursor && page < 20);

  return nfts;
}

function setNFTGridLoading() {
  document.getElementById('nftGrid').innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:var(--muted);">
      <i class="fas fa-spinner fa-spin" style="font-size:36px;display:block;margin-bottom:14px;"></i>
      <p style="font-family:'Geist Mono',monospace;font-size:.86rem;letter-spacing:.1em;">Loading NFTs…</p>
    </div>`;
}

function setNFTGridError() {
  document.getElementById('nftGrid').innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:#ff6b6b;">
      <i class="fas fa-exclamation-circle" style="font-size:36px;display:block;margin-bottom:14px;opacity:.6;"></i>
      <p style="font-family:'Geist Mono',monospace;font-size:.86rem;">Failed to load NFTs. Check the address and try again.</p>
    </div>`;
}

function renderWalletGrid(nfts) {
  const grid = document.getElementById('nftGrid');
  grid.innerHTML = '';
  if (!nfts.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:var(--muted);">
      <span style="font-size:48px;display:block;margin-bottom:14px;opacity:.3;">☠</span>
      <p style="font-family:'Geist Mono',monospace;font-size:.86rem;">No NFTs found in this wallet</p></div>`;
    return;
  }

  nfts.forEach((nft, i) => {
    const card = document.createElement('div');
    card.className = 'stake-nft-card';
    card.dataset.index = i;
    card.innerHTML = `
      <img src="${nft.image}" alt="${nft.name}" loading="lazy"
           onerror="this.src='https://placehold.co/300x300/140808/c8a450?text=☠'"/>
      <div class="stake-nft-card-body">
        <span class="stake-nft-id">#${nft.id}</span>
        <span class="stake-nft-card-check"></span>
      </div>`;

    // Click: toggle grid selection OR add to wallpaper
    card.addEventListener('click', () => toggleGridSelect(i, card));

    // Long-press / right-click → add to wallpaper
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      addCharacterToWallpaper(nft);
      document.getElementById('wallpaper')?.scrollIntoView({ behavior: 'smooth' });
      toast('Added to wallpaper — scroll down!', 'success');
    });

    grid.appendChild(card);
  });
}

function toggleGridSelect(index, card) {
  const toggle = document.getElementById('gridModeToggle');
  if (!toggle?.classList.contains('active')) {
    // Grid maker not enabled — add to wallpaper instead
    addCharacterToWallpaper(walletNFTs[index]);
    document.getElementById('wallpaper')?.scrollIntoView({ behavior: 'smooth' });
    toast('Added to Wallpaper Maker ↓', 'info');
    return;
  }

  const mode = document.querySelector('input[name="selectionMode"]:checked')?.value;
  if (mode === 'random') return; // random mode — no manual selection

  const already = selectedForGrid.findIndex(n => n === walletNFTs[index]);
  if (already >= 0) {
    selectedForGrid.splice(already, 1);
    card.classList.remove('selected');
  } else {
    selectedForGrid.push(walletNFTs[index]);
    card.classList.add('selected');
  }
  document.getElementById('gridSelCount').textContent = selectedForGrid.length + ' selected';
}

/* ============================================================
   SECTION 2 — NFT GRID MAKER
   ============================================================ */

function getGridDims() {
  const sel = document.getElementById('gridSize').value;
  if (sel === 'custom') {
    return {
      rows: Math.min(parseInt(document.getElementById('customGridRows').value) || 3, 50),
      cols: Math.min(parseInt(document.getElementById('customGridCols').value) || 3, 50)
    };
  }
  if (sel.startsWith('random')) {
    const ranges = { 'random-small': [2,5], 'random-medium': [5,10], 'random-large': [10,20] };
    const [lo, hi] = ranges[sel];
    const s = lo + Math.floor(Math.random() * (hi - lo + 1));
    return { rows: s, cols: s };
  }
  const s = parseInt(sel);
  return { rows: s, cols: s };
}

function getNFTsForGrid() {
  const mode = document.querySelector('input[name="selectionMode"]:checked')?.value || 'manual';
  const { rows, cols } = getGridDims();
  const needed = rows * cols;

  if (mode === 'random') {
    const pool = walletNFTs.filter(n => n.image);
    if (!pool.length) { toast('Load a wallet first to use random mode', 'error'); return null; }
    const shuffled = [...pool].sort(() => Math.random() - .5);
    return { nfts: shuffled.slice(0, needed), rows, cols };
  }

  if (!selectedForGrid.length) { toast('Select NFTs from your wallet for the grid', 'error'); return null; }
  return { nfts: selectedForGrid.slice(0, needed), rows, cols };
}

async function buildGridCanvas(nfts, rows, cols, cellSize = 400) {
  const sep   = parseInt(document.getElementById('separatorWidth').value) || 0;
  const sepC  = document.getElementById('separatorColor').value || '#0a0505';
  const emptyC= document.getElementById('emptyCellColor').value  || '#1a0a0a';

  const W = cols * cellSize + (cols + 1) * sep;
  const H = rows * cellSize + (rows + 1) * sep;

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = sepC;
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < rows * cols; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = sep + c * (cellSize + sep);
    const y = sep + r * (cellSize + sep);

    if (nfts[i]) {
      try {
        const img = await loadImg(nfts[i].image);
        ctx.drawImage(img, x, y, cellSize, cellSize);
      } catch (_) {
        ctx.fillStyle = emptyC;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    } else {
      ctx.fillStyle = emptyC;
      ctx.fillRect(x, y, cellSize, cellSize);
    }
  }
  return canvas;
}

async function previewGrid() {
  const data = getNFTsForGrid();
  if (!data) return;
  toast('Building preview…');
  try {
    const canvas = await buildGridCanvas(data.nfts, data.rows, data.cols);
    const container = document.getElementById('gridPreviewContainer');
    const preview   = document.getElementById('gridPreview');
    container.classList.remove('hidden');
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.src = canvas.toDataURL();
    img.style.cssText = 'width:100%;height:auto;border-radius:8px;';
    preview.appendChild(img);
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Preview ready!', 'success');
  } catch (e) {
    console.error(e);
    toast('Failed to build grid', 'error');
  }
}

async function downloadGrid() {
  const data = getNFTsForGrid();
  if (!data) return;
  toast('Generating grid PNG…');
  try {
    const canvas = await buildGridCanvas(data.nfts, data.rows, data.cols);
    downloadCanvas(canvas, `undead-grid-${data.rows}x${data.cols}.png`);
    toast('Downloaded!', 'success');
  } catch(e) {
    console.error(e);
    toast('Failed to generate PNG', 'error');
  }
}

async function downloadAllZip() {
  if (!walletNFTs.length) { toast('Load a wallet first', 'error'); return; }
  if (typeof JSZip === 'undefined') { toast('JSZip not available', 'error'); return; }
  toast('Zipping images…');
  const zip = new JSZip();
  let ok = 0;
  for (const nft of walletNFTs) {
    try {
      const r = await fetch(nft.image);
      if (r.ok) {
        zip.file(`undead-${nft.id}.png`, await r.blob());
        ok++;
      }
    } catch(_) {}
  }
  if (!ok) { toast('Could not fetch any images', 'error'); return; }
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'undeads-collection.zip';
  a.click();
  toast(`Saved ${ok} images in ZIP`, 'success');
}

function resetGrid() {
  selectedForGrid = [];
  document.querySelectorAll('.stake-nft-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('gridPreviewContainer')?.classList.add('hidden');
  const ct = document.getElementById('gridSelCount');
  if (ct) ct.textContent = '0 selected';
  toast('Grid reset');
}

/* ============================================================
   SECTION 3 — WALLPAPER MAKER
   ============================================================ */

const WP = {
  canvas: null,
  ctx: null,
  W: 1170, H: 2532,    // iPhone default
  background: 'linear-gradient(180deg,#3d0000 0%,#0a0505 100%)',
  bgImage: null,
  pattern: null,
  patternColor: '#c8a450',
  patternOpacity: 0.15,
  characters: [],
  selected: null,
  dragging: false,
  resizing: false,
  resizeHandle: null,
  dragOff: { x: 0, y: 0 },
  removeBackground: true,
  customGrad: { c1: '#3d0000', c2: '#0a0505', c3: '#140808', angle: 180, three: true }
};

// Wallpaper patterns
const PATTERNS = [
  { id: 'none',       icon: '✕', label: 'None'      },
  { id: 'dots',       icon: '·', label: 'Dots'      },
  { id: 'grid',       icon: '⊞', label: 'Grid'      },
  { id: 'diagonal',   icon: '╱', label: 'Lines'     },
  { id: 'hexagon',    icon: '⬡', label: 'Hex'       },
  { id: 'waves',      icon: '〜', label: 'Waves'     },
  { id: 'circles',    icon: '◯', label: 'Circles'   },
  { id: 'stars',      icon: '★', label: 'Stars'     },
  { id: 'crosshatch', icon: '⊠', label: 'Cross'     },
  { id: 'triangles',  icon: '△', label: 'Tris'      },
];

function initWallpaper() {
  WP.canvas = document.getElementById('wallpaperCanvas');
  if (!WP.canvas) return;
  WP.ctx = WP.canvas.getContext('2d');
  WP.canvas.width  = WP.W;
  WP.canvas.height = WP.H;

  buildPatternButtons();
  drawWallpaper();
  setupWallpaperEvents();
  setupWallpaperControls();
}

function buildPatternButtons() {
  const cont = document.getElementById('patternOptions');
  if (!cont) return;
  cont.innerHTML = '';
  PATTERNS.forEach(p => {
    const btn = document.createElement('div');
    btn.className = 'pattern-opt';
    btn.title = p.label;
    btn.innerHTML = `<span style="font-size:18px;">${p.icon}</span>`;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pattern-opt').forEach(b => b.classList.remove('selected'));
      WP.pattern = p.id === 'none' ? null : p.id;
      if (WP.pattern) btn.classList.add('selected');
      drawWallpaper();
    });
    cont.appendChild(btn);
  });
}

function setupWallpaperControls() {
  // Background presets
  document.querySelectorAll('.bg-option').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.bg-option').forEach(b => b.classList.remove('selected'));
      el.classList.add('selected');
      WP.background = el.dataset.bg;
      WP.bgImage = null;
      drawWallpaper();
    });
  });

  // Background file upload
  document.getElementById('wallpaperBgUpload')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      WP.bgImage = await loadImg(url);
      WP.background = null;
      drawWallpaper();
      toast('Background uploaded!', 'success');
    } catch(_) { toast('Could not load image', 'error'); }
  });

  // Pattern controls
  document.getElementById('patternColor')?.addEventListener('input', e => {
    WP.patternColor = e.target.value; drawWallpaper();
  });
  document.getElementById('patternOpacity')?.addEventListener('input', e => {
    WP.patternOpacity = +e.target.value / 100;
    const lbl = document.getElementById('patternOpacityVal');
    if (lbl) lbl.textContent = e.target.value + '%';
    drawWallpaper();
  });

  // Custom gradient
  ['gradientColor1','gradientColor2','gradientColor3'].forEach((id,i) => {
    document.getElementById(id)?.addEventListener('input', e => {
      WP.customGrad['c' + (i+1)] = e.target.value;
      updateGradientPreview(); drawWallpaper();
    });
  });
  document.getElementById('gradientAngle')?.addEventListener('input', e => {
    WP.customGrad.angle = +e.target.value;
    const lbl = document.getElementById('gradientAngleValue');
    if (lbl) lbl.textContent = e.target.value + '°';
    updateGradientPreview(); drawWallpaper();
  });

  // Three-color toggle
  const threeToggle = document.getElementById('threeColorToggle');
  threeToggle?.addEventListener('click', () => {
    threeToggle.classList.toggle('active');
    WP.customGrad.three = threeToggle.classList.contains('active');
    const c3box = document.getElementById('gradientColor3Container');
    if (c3box) c3box.style.display = WP.customGrad.three ? '' : 'none';
    updateGradientPreview(); drawWallpaper();
  });

  // Apply custom gradient
  document.getElementById('applyCustomGradient')?.addEventListener('click', () => {
    WP.background = '__custom__';
    WP.bgImage = null;
    document.querySelectorAll('.bg-option').forEach(b => b.classList.remove('selected'));
    drawWallpaper();
    toast('Custom gradient applied!', 'success');
  });

  // Remove background toggle
  const bgToggle = document.getElementById('removeBackgroundToggle');
  bgToggle?.addEventListener('click', () => {
    bgToggle.classList.toggle('active');
    WP.removeBackground = bgToggle.classList.contains('active');
    // Re-process existing characters
    WP.characters.forEach(async ch => {
      ch.img = WP.removeBackground
        ? await removeBG(ch.original)
        : ch.original;
    });
    drawWallpaper();
  });

  // Device size buttons
  document.querySelectorAll('.device-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.device-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      WP.W = parseInt(btn.dataset.w);
      WP.H = parseInt(btn.dataset.h);
      WP.canvas.width  = WP.W;
      WP.canvas.height = WP.H;
      // Scale existing characters proportionally
      const sx = WP.W / (WP.canvas.width  || WP.W);
      const sy = WP.H / (WP.canvas.height || WP.H);
      WP.characters.forEach(ch => {
        ch.x *= sx; ch.y *= sy;
        ch.w *= sx; ch.h *= sy;
      });
      drawWallpaper();
    });
  });

  // Download buttons
  document.getElementById('downloadWallpaper')?.addEventListener('click', exportWallpaper);
  document.getElementById('downloadCharacter')?.addEventListener('click', () => exportCharacter(true));
  document.getElementById('downloadCharacterNoBg')?.addEventListener('click', () => exportCharacter(false));

  // Reset
  document.getElementById('resetWallpaper')?.addEventListener('click', () => {
    WP.characters = [];
    WP.selected = null;
    updateCharacterStrip();
    drawWallpaper();
    toast('Wallpaper reset');
  });
}

function updateGradientPreview() {
  const p = document.getElementById('gradientPreview');
  if (!p) return;
  const g = WP.customGrad;
  p.style.background = g.three
    ? `linear-gradient(${g.angle}deg,${g.c1} 0%,${g.c2} 50%,${g.c3} 100%)`
    : `linear-gradient(${g.angle}deg,${g.c1} 0%,${g.c2} 100%)`;
}

/* -- Canvas events (drag & resize) --------------------------- */
function setupWallpaperEvents() {
  const cv = WP.canvas;

  const coords = e => {
    const r  = cv.getBoundingClientRect();
    const sx = WP.canvas.width  / r.width;
    const sy = WP.canvas.height / r.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * sx, y: (src.clientY - r.top) * sy };
  };

  const findChar = (x, y) => {
    for (let i = WP.characters.length - 1; i >= 0; i--) {
      const ch = WP.characters[i];
      if (x >= ch.x && x <= ch.x + ch.w && y >= ch.y && y <= ch.y + ch.h) return ch;
    }
    return null;
  };

  const getHandle = (ch, x, y) => {
    const hs = 60;
    const corners = { nw:[ch.x,ch.y], ne:[ch.x+ch.w,ch.y], sw:[ch.x,ch.y+ch.h], se:[ch.x+ch.w,ch.y+ch.h] };
    for (const [k,[hx,hy]] of Object.entries(corners)) {
      if (Math.abs(x-hx) < hs && Math.abs(y-hy) < hs) return k;
    }
    return null;
  };

  const onDown = e => {
    e.preventDefault();
    const { x, y } = coords(e);
    if (WP.selected) {
      const h = getHandle(WP.selected, x, y);
      if (h) { WP.resizing = true; WP.resizeHandle = h; return; }
    }
    const ch = findChar(x, y);
    if (ch) {
      WP.selected = ch;
      WP.dragging = true;
      WP.dragOff  = { x: x - ch.x, y: y - ch.y };
      // Bring to top
      WP.characters = WP.characters.filter(c => c !== ch);
      WP.characters.push(ch);
      updateCharacterStrip();
    } else {
      WP.selected = null;
      updateCharacterStrip();
    }
    drawWallpaper();
  };

  const onMove = e => {
    e.preventDefault();
    const { x, y } = coords(e);
    if (WP.dragging && WP.selected) {
      WP.selected.x = x - WP.dragOff.x;
      WP.selected.y = y - WP.dragOff.y;
      drawWallpaper();
    }
    if (WP.resizing && WP.selected) {
      const ch = WP.selected;
      const ar = ch.origW / ch.origH;
      switch (WP.resizeHandle) {
        case 'se': ch.w = Math.max(40, x-ch.x); ch.h = ch.w/ar; break;
        case 'sw': { const nw=Math.max(40,ch.x+ch.w-x); ch.x=x; ch.w=nw; ch.h=nw/ar; } break;
        case 'ne': { const nw=Math.max(40,x-ch.x); ch.w=nw; const nh=nw/ar; ch.y=ch.y+ch.h-nh; ch.h=nh; } break;
        case 'nw': { const nw=Math.max(40,ch.x+ch.w-x); const nh=nw/ar; ch.x=x; ch.y=ch.y+ch.h-nh; ch.w=nw; ch.h=nh; } break;
      }
      drawWallpaper();
    }
  };

  const onUp = () => { WP.dragging = false; WP.resizing = false; WP.resizeHandle = null; };

  cv.addEventListener('mousedown',  onDown);
  cv.addEventListener('mousemove',  onMove);
  cv.addEventListener('mouseup',    onUp);
  cv.addEventListener('mouseleave', onUp);
  cv.addEventListener('touchstart', onDown, { passive: false });
  cv.addEventListener('touchmove',  onMove, { passive: false });
  cv.addEventListener('touchend',   onUp);
}

/* -- Background drawing -------------------------------------- */
function drawBG(ctx, w, h) {
  if (WP.bgImage) {
    ctx.drawImage(WP.bgImage, 0, 0, w, h);
    return;
  }
  if (!WP.background || WP.background === '__custom__') {
    const g = WP.customGrad;
    const rad = (g.angle - 90) * Math.PI / 180;
    const len = Math.hypot(w, h) / 2;
    const cx = w/2, cy = h/2;
    const gr = ctx.createLinearGradient(
      cx - Math.cos(rad)*len, cy - Math.sin(rad)*len,
      cx + Math.cos(rad)*len, cy + Math.sin(rad)*len
    );
    gr.addColorStop(0, g.c1);
    if (g.three) { gr.addColorStop(.5, g.c2); gr.addColorStop(1, g.c3); }
    else gr.addColorStop(1, g.c2);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  // CSS gradient → parse colors
  const matches = WP.background.match(/#[0-9a-fA-F]{6}/g) || ['#1a0808','#0a0505'];
  const gr = ctx.createLinearGradient(0, 0, 0, h);
  matches.forEach((c, i) => gr.addColorStop(i / Math.max(matches.length - 1, 1), c));
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, w, h);
}

/* -- Pattern overlay ----------------------------------------- */
function drawPattern(ctx, id, w, h, color, opacity) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = 2;

  switch(id) {
    case 'dots': {
      const sp = 60, r = 5;
      for (let y = sp/2; y < h; y += sp)
        for (let x = sp/2; x < w; x += sp) {
          ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
        }
      break;
    }
    case 'grid': {
      const sp = 80;
      for (let x = 0; x <= w; x += sp) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for (let y = 0; y <= h; y += sp) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
      break;
    }
    case 'diagonal': {
      const sp = 50;
      for (let i = -h; i < w + h; i += sp) {
        ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i+h,h); ctx.stroke();
      }
      break;
    }
    case 'hexagon': {
      const s = 45, hh = s * Math.sqrt(3);
      for (let row = -1; row < h/hh + 1; row++) {
        for (let col = -1; col < w/(s*1.5) + 1; col++) {
          const cx = col * s * 1.5;
          const cy = row * hh + (col%2 ? hh/2 : 0);
          ctx.beginPath();
          for (let k=0;k<6;k++) {
            const a = (k*60-30)*Math.PI/180;
            const hx = cx + s*.9*Math.cos(a), hy = cy + s*.9*Math.sin(a);
            k ? ctx.lineTo(hx,hy) : ctx.moveTo(hx,hy);
          }
          ctx.closePath(); ctx.stroke();
        }
      }
      break;
    }
    case 'waves': {
      const sp = 60, amp = 18, freq = 80;
      for (let y = 0; y < h + sp; y += sp) {
        ctx.beginPath(); ctx.moveTo(0, y);
        for (let x = 0; x < w; x += 4)
          ctx.lineTo(x, y + Math.sin(x/freq*Math.PI*2)*amp);
        ctx.stroke();
      }
      break;
    }
    case 'circles': {
      const sp = 100;
      for (let y = sp/2; y < h; y += sp)
        for (let x = sp/2; x < w; x += sp) {
          ctx.beginPath(); ctx.arc(x,y,sp*0.35,0,Math.PI*2); ctx.stroke();
        }
      break;
    }
    case 'stars': {
      const rng = seededRNG(42);
      for (let k=0; k<120; k++) {
        const sx = rng() * w, sy = rng() * h, sz = rng() * 4 + 1;
        ctx.beginPath();
        for (let i=0;i<5;i++) {
          const a = (i*144-90)*Math.PI/180;
          const px = sx + sz*Math.cos(a), py = sy + sz*Math.sin(a);
          i ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
        }
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'crosshatch': {
      const sp = 30;
      for (let i = -h; i < w+h; i += sp) {
        ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i+h,h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i+h,0); ctx.lineTo(i,h); ctx.stroke();
      }
      break;
    }
    case 'triangles': {
      const s = 60, th = s*Math.sqrt(3)/2;
      ctx.lineWidth = 1;
      for (let row = -1; row < h/th + 1; row++) {
        for (let col = -1; col < w/s + 2; col++) {
          const ox = col*s + (row%2 ? s/2 : 0), oy = row*th;
          ctx.beginPath();
          ctx.moveTo(ox, oy);
          ctx.lineTo(ox+s/2, oy+th);
          ctx.lineTo(ox-s/2, oy+th);
          ctx.closePath(); ctx.stroke();
        }
      }
      break;
    }
  }
  ctx.restore();
}

function seededRNG(seed) {
  let s = seed;
  return () => { s = (s*1664525+1013904223)&0xffffffff; return (s>>>0)/0xffffffff; };
}

/* -- Main render --------------------------------------------- */
function drawWallpaper(ctx, w, h) {
  ctx = ctx || WP.ctx;
  w   = w   || WP.canvas.width;
  h   = h   || WP.canvas.height;

  ctx.clearRect(0, 0, w, h);
  drawBG(ctx, w, h);

  if (WP.pattern) {
    const pc = document.getElementById('patternColor')?.value || WP.patternColor;
    const po = +(document.getElementById('patternOpacity')?.value || 15) / 100;
    drawPattern(ctx, WP.pattern, w, h, pc, po);
  }

  WP.characters.forEach(ch => {
    const img = WP.removeBackground ? ch.img : ch.original;
    if (!img) return;
    ctx.drawImage(img, ch.x, ch.y, ch.w, ch.h);

    if (ch === WP.selected) {
      ctx.save();
      ctx.strokeStyle = 'rgba(200,164,80,0.9)';
      ctx.lineWidth   = Math.max(3, w * 0.003);
      ctx.setLineDash([16, 8]);
      ctx.strokeRect(ch.x, ch.y, ch.w, ch.h);
      ctx.setLineDash([]);

      const hs = Math.max(16, w * 0.018);
      ctx.fillStyle = '#c8a450';
      [[ch.x,ch.y],[ch.x+ch.w,ch.y],[ch.x,ch.y+ch.h],[ch.x+ch.w,ch.y+ch.h]].forEach(([hx,hy]) => {
        ctx.beginPath(); ctx.arc(hx,hy,hs,0,Math.PI*2); ctx.fill();
      });
      ctx.restore();
    }
  });
}

/* -- Background removal -------------------------------------- */
async function removeBG(img) {
  const cv  = document.createElement('canvas');
  cv.width  = img.naturalWidth  || img.width;
  cv.height = img.naturalHeight || img.height;
  const cx  = cv.getContext('2d');
  cx.drawImage(img, 0, 0);

  const idata = cx.getImageData(0, 0, cv.width, cv.height);
  const data  = idata.data;
  const W     = cv.width, H = cv.height;

  // Sample corners to detect background color
  const sp = Math.max(3, Math.floor(Math.min(W,H) * 0.04));
  const samples = [];
  const sampleRegion = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y*W+x)*4;
        samples.push([data[i],data[i+1],data[i+2]]);
      }
  };
  sampleRegion(0,0,sp,sp);
  sampleRegion(W-sp,0,W,sp);
  sampleRegion(0,H-sp,sp,H);
  sampleRegion(W-sp,H-sp,W,H);

  // Median color
  const meds = [0,1,2].map(ch => {
    const vals = samples.map(s=>s[ch]).sort((a,b)=>a-b);
    return vals[Math.floor(vals.length/2)];
  });

  // Flood fill from edges with tolerance
  const tol  = 35;
  const soft  = 55;
  const alpha = new Uint8Array(W*H).fill(255);
  const seen  = new Uint8Array(W*H);

  const dist = i => Math.sqrt(
    Math.pow(data[i]-meds[0],2)+Math.pow(data[i+1]-meds[1],2)+Math.pow(data[i+2]-meds[2],2)
  );

  const stack = [];
  const push = (x,y) => { if(x>=0&&x<W&&y>=0&&y<H&&!seen[y*W+x]) stack.push(y*W+x); };
  for (let x=0;x<W;x++) { push(x,0); push(x,H-1); }
  for (let y=0;y<H;y++) { push(0,y); push(W-1,y); }

  while (stack.length) {
    const idx = stack.pop();
    if (seen[idx]) continue;
    seen[idx] = 1;
    const d = dist(idx*4);
    if (d > soft) continue;
    alpha[idx] = d < tol ? 0 : Math.floor((d-tol)/(soft-tol)*255);
    const x = idx%W, y = Math.floor(idx/W);
    push(x+1,y); push(x-1,y); push(x,y+1); push(x,y-1);
  }

  for (let i=0; i<W*H; i++) data[i*4+3] = alpha[i];
  cx.putImageData(idata, 0, 0);

  const out = new Image();
  out.src = cv.toDataURL('image/png');
  await new Promise(r => { out.onload = r; });
  return out;
}

/* -- Add character to wallpaper ----------------------------- */
async function addCharacterToWallpaper(nft) {
  const orig = await loadImg(nft.image).catch(() => null);
  if (!orig) { toast('Could not load character image', 'error'); return; }

  const processed = WP.removeBackground ? await removeBG(orig) : orig;

  const canvas = WP.canvas;
  const defSize = Math.min(canvas.width, canvas.height) * 0.38;
  const ar = (orig.naturalWidth || orig.width) / (orig.naturalHeight || orig.height);

  const ch = {
    id: Date.now() + Math.random(),
    nft,
    original: orig,
    img: processed,
    origW: orig.naturalWidth  || orig.width,
    origH: orig.naturalHeight || orig.height,
    x: (canvas.width  - defSize * ar) / 2,
    y:  canvas.height * 0.35,
    w:  defSize * ar,
    h:  defSize
  };

  WP.characters.push(ch);
  WP.selected = ch;
  updateCharacterStrip();
  drawWallpaper();
}

function updateCharacterStrip() {
  const strip = document.getElementById('wallpaperSelectedNFT');
  if (!strip) return;
  if (!WP.characters.length) {
    strip.innerHTML = '<p class="muted" style="font-size:.86rem;width:100%;text-align:center;font-style:italic;font-family:\'Geist Mono\',monospace;">Click an NFT below to add</p>';
    return;
  }
  strip.innerHTML = WP.characters.map(ch => `
    <div style="position:relative;cursor:pointer;" data-id="${ch.id}">
      <img src="${ch.nft.image}" alt="${ch.nft.name}"
           style="width:48px;height:48px;border-radius:8px;object-fit:cover;image-rendering:pixelated;
                  border:2px solid ${ch === WP.selected ? 'var(--accent)' : 'var(--glass-border)'};
                  filter:${ch === WP.selected ? 'none' : 'sepia(.15) brightness(.85)'};transition:all .2s;"
           onerror="this.src='https://placehold.co/48x48/140808/c8a450?text=☠'"/>
      <button onclick="removeWPChar('${ch.id}')"
              style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;
                     background:#8b1a1a;border:none;color:#fff;font-size:10px;cursor:pointer;
                     display:flex;align-items:center;justify-content:center;line-height:1;">✕</button>
    </div>`).join('');

  strip.querySelectorAll('[data-id]').forEach(el => {
    el.querySelector('img').addEventListener('click', () => {
      WP.selected = WP.characters.find(c => c.id == el.dataset.id) || null;
      updateCharacterStrip();
      drawWallpaper();
    });
  });
}

window.removeWPChar = function(id) {
  WP.characters = WP.characters.filter(c => c.id != id);
  if (WP.selected?.id == id) WP.selected = null;
  updateCharacterStrip();
  drawWallpaper();
};

/* -- Exports ------------------------------------------------ */
function exportWallpaper() {
  const cv  = document.createElement('canvas');
  cv.width  = WP.canvas.width;
  cv.height = WP.canvas.height;
  const cx  = cv.getContext('2d');
  const prev = WP.selected;
  WP.selected = null;           // no selection handles in export
  drawWallpaper(cx, cv.width, cv.height);
  WP.selected = prev;
  downloadCanvas(cv, 'undead-wallpaper.png');
  toast('Wallpaper saved!', 'success');
}

function exportCharacter(withBG) {
  if (!WP.selected) { toast('Select a character on the canvas first', 'error'); return; }
  const ch = WP.selected;
  const cv = document.createElement('canvas');
  cv.width  = ch.origW;
  cv.height = ch.origH;
  const cx  = cv.getContext('2d');
  cx.drawImage(withBG ? ch.original : ch.img, 0, 0);
  downloadCanvas(cv, `undead-char-${withBG ? 'bg' : 'nobg'}.png`);
  toast('Character saved!', 'success');
}

/* ============================================================
   SECTION 4 — COLLECTION EXPLORER
   ============================================================ */

const EX = {
  page: 0,
  pageSize: 48,
  from: 0,
  to: 4999,
  current: []
};

// We read token URIs directly from the onchain contract/renderer
async function exLoad() {
  const search = parseInt(document.getElementById('exSearch').value);
  const from   = parseInt(document.getElementById('exFrom').value) || 0;
  const to     = parseInt(document.getElementById('exTo').value)   || 47;

  if (!isNaN(search) && search >= 0 && search <= 4999) {
    // Single token lookup
    await exLoadSingle(search);
    return;
  }

  EX.from = Math.max(0, from);
  EX.to   = Math.min(4999, to);
  EX.page = 0;

  const grid  = document.getElementById('exGrid');
  const pager = document.getElementById('exPager');
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:64px 20px;color:var(--muted);">
    <i class="fas fa-spinner fa-spin" style="font-size:36px;display:block;margin-bottom:14px;"></i>
    <p style="font-family:'Geist Mono',monospace;font-size:.86rem;">Loading tokens…</p></div>`;
  pager.style.display = 'none';

  const ids = [];
  for (let i = EX.from; i <= EX.to; i++) ids.push(i);
  EX.current = ids;

  renderExPage();
}

async function exLoadSingle(id) {
  const grid   = document.getElementById('exGrid');
  const detail = document.getElementById('exDetail');
  const pager  = document.getElementById('exPager');
  pager.style.display = 'none';
  detail.innerHTML = '';
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">
    <i class="fas fa-spinner fa-spin" style="font-size:24px;"></i></div>`;

  const meta = await fetchTokenMeta(id);
  if (!meta) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff6b6b;">
      Token #${id} not found or not yet minted.</div>`;
    return;
  }

  grid.innerHTML = '';
  const card = makeExCard(id, meta.image || '', true);
  grid.appendChild(card);

  // Show attributes
  if (meta.attributes?.length) {
    detail.innerHTML = `
      <div class="card" style="padding:24px;margin-top:20px;">
        <div class="eyebrow mb-16">Traits — ${meta.name || 'Undead #'+id}</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          ${meta.attributes.map(a => `
            <div style="background:rgba(200,164,80,.08);border:1px solid rgba(200,164,80,.25);
                        border-radius:12px;padding:10px 16px;">
              <div style="font-family:'Geist Mono',monospace;font-size:9px;letter-spacing:.15em;
                          text-transform:uppercase;color:var(--accent);margin-bottom:4px;">
                ${a.trait_type || 'Trait'}</div>
              <div style="font-family:'Instrument Serif',serif;font-size:16px;">
                ${a.value}</div>
            </div>`).join('')}
        </div>
      </div>`;
  }
}

async function fetchTokenMeta(id) {
  // 1. Try onchain renderer (config.js provides renderer address)
  if (typeof ethers !== 'undefined' && CONFIG?.renderer) {
    try {
      const provider  = new ethers.JsonRpcProvider(CONFIG.rpc);
      const ABI = ['function tokenURI(uint256) view returns (string)'];
      const c   = new ethers.Contract(CONFIG.nft, ABI, provider);
      const uri = await c.tokenURI(id);
      return await resolveTokenURI(uri);
    } catch(_) {}
  }

  // 2. Try OpenSea API as fallback
  try {
    const key = CONFIG?.OPENSEA_API_KEY || '';
    const url = `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.nft}/nfts/${id}`;
    const r = await fetch(url, { headers: { 'X-API-KEY': key, 'accept': 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      const n = d.nft || {};
      return {
        name: n.name,
        image: proxyUrl(n.image_url || n.display_image_url || ''),
        attributes: n.traits || []
      };
    }
  } catch(_) {}

  // 3. Construct a metadata URL guess (common patterns)
  const bases = [
    `https://ipfs.io/ipfs/QmBaseHash/${id}`,      // placeholder
    `https://metadata.basedundeads.com/${id}`
  ];
  for (const base of bases) {
    try {
      const r = await fetch(base);
      if (r.ok) return r.json();
    } catch(_) {}
  }
  return null;
}

function renderExPage() {
  const grid  = document.getElementById('exGrid');
  const pager = document.getElementById('exPager');
  const info  = document.getElementById('pgInfo');

  const start = EX.page * EX.pageSize;
  const slice = EX.current.slice(start, start + EX.pageSize);

  grid.innerHTML = '';

  slice.forEach(id => {
    // Build image URL — try OpenSea CDN pattern
    const imageUrl = buildTokenImageURL(id);
    const card = makeExCard(id, imageUrl, false);
    grid.appendChild(card);
  });

  const total = Math.ceil(EX.current.length / EX.pageSize);
  if (total > 1) {
    pager.style.display = 'flex';
    info.textContent    = `Page ${EX.page + 1} / ${total}`;
    document.getElementById('pgPrev').disabled = EX.page === 0;
    document.getElementById('pgNext').disabled = EX.page >= total - 1;
  } else {
    pager.style.display = 'none';
  }
}

function buildTokenImageURL(id) {
  // Standard OpenSea CDN for Base chain:
  return `https://i.seadn.io/gcs/files/${CONFIG.nft?.toLowerCase()}/${id}.png`
       + `?auto=format&dpr=1&w=300`;
}

function makeExCard(id, imageUrl, large) {
  const card = document.createElement('a');
  card.className = 'token-card';
  const osUrl = `https://opensea.io/assets/base/${CONFIG.nft}/${id}`;
  card.href   = osUrl;
  card.target = '_blank';
  card.rel    = 'noopener';

  // For the explorer we lazy-load and also try tokenURI on-the-fly
  const finalUrl = imageUrl || `https://placehold.co/300x300/140808/c8a450?text=%23${id}`;

  card.innerHTML = `
    <img src="${finalUrl}" alt="Undead #${id}" loading="lazy"
         style="${large ? 'max-width:300px;' : ''}"
         onerror="this.onerror=null;this.src='https://placehold.co/300x300/140808/c8a450?text=%23${id}'"
    />
    <div class="token-card-body">
      <span class="token-card-id">#${id}</span>
    </div>`;

  // Lazy-load actual metadata for better image if we have ethers
  if (typeof ethers !== 'undefined' && CONFIG?.nft) {
    card.addEventListener('mouseenter', () => lazyLoadMeta(id, card), { once: true });
  }

  return card;
}

async function lazyLoadMeta(id, card) {
  const meta = await fetchTokenMeta(id).catch(() => null);
  if (!meta?.image) return;
  const img = card.querySelector('img');
  if (img) img.src = meta.image;
}

/* ============================================================
   UTILITY
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {

  /* ── Wallet loader ── */
  document.getElementById('fetchNFTs')?.addEventListener('click', onFetchNFTs);
  document.getElementById('walletAddress')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') onFetchNFTs();
  });

  /* ── Grid maker toggle ── */
  const gridToggle = document.getElementById('gridModeToggle');
  const gridOpts   = document.getElementById('gridOptions');
  if (gridToggle && gridOpts) {
    gridToggle.addEventListener('click', () => {
      gridToggle.classList.toggle('active');
      gridOpts.classList.toggle('hidden');
    });
  }

  /* ── Grid size → show/hide custom inputs ── */
  document.getElementById('gridSize')?.addEventListener('change', function() {
    const box = document.getElementById('customGridSizeInput');
    if (box) box.classList.toggle('hidden', this.value !== 'custom');
  });

  /* ── Grid actions ── */
  document.getElementById('previewGrid')?.addEventListener('click', previewGrid);
  document.getElementById('downloadGrid')?.addEventListener('click', downloadGrid);
  document.getElementById('downloadAll')?.addEventListener('click', downloadAllZip);
  document.getElementById('resetGrid')?.addEventListener('click', resetGrid);

  // Inject a tiny count label into the action buttons area
  const gridCard = document.getElementById('gridOptions');
  if (gridCard) {
    const ct = document.createElement('span');
    ct.id = 'gridSelCount';
    ct.style.cssText = 'font-family:"Geist Mono",monospace;font-size:11px;color:var(--muted-2);display:block;margin-bottom:12px;';
    ct.textContent = '0 selected';
    gridCard.insertBefore(ct, gridCard.querySelector('.grid-opts-row'));
  }

  /* ── Wallpaper maker ── */
  initWallpaper();

  /* ── Collection explorer ── */
  document.getElementById('exLoad')?.addEventListener('click', exLoad);
  document.getElementById('exSearch')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') exLoad();
  });
  document.getElementById('pgPrev')?.addEventListener('click', () => {
    if (EX.page > 0) { EX.page--; renderExPage(); }
  });
  document.getElementById('pgNext')?.addEventListener('click', () => {
    const total = Math.ceil(EX.current.length / EX.pageSize);
    if (EX.page < total - 1) { EX.page++; renderExPage(); }
  });

  // Kick off explorer with first page
  exLoad();

  /* ── Smooth scroll for anchor links ── */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });

  /* ── Mobile menu ── */
  const hamburger = document.getElementById('hamburger');
  const mob = document.getElementById('mobileMenu');
  const close = document.getElementById('mobileMenuClose');
  hamburger?.addEventListener('click', () => mob?.classList.toggle('open'));
  close?.addEventListener('click', () => mob?.classList.remove('open'));
});
