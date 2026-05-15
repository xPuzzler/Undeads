// js/page-game.js, BU $1 Game page controller
// ─────────────────────────────────────────────────────────────────────────
// Reads/writes the UndeadGame contract. Renders:
//   • wallet NFT inventory (via Alchemy getNFTsForOwner, fallback message)
//   • active / ending / mine / past tabs
//   • create-game modal (canonical safeTransferFrom + abi.encode(...))
//   • detail modal with buy / draw / claim / cancel
//   • winner celebration overlay with confetti burst
//   • orphan recovery panel (creator safety switch)
// ─────────────────────────────────────────────────────────────────────────

/* eslint-disable no-undef */

// ─── Contract address ────────────────────────────────────────────────────
// TODO: After deploy, set window.BU_CONFIG.contracts.game in config.js.
// Until then the page renders in OFFLINE mode (read-only, no chain calls).
const GAME_ADDRESS = window.BU_CONFIG?.contracts?.game || '';
const GAME_LIVE    = !!GAME_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(GAME_ADDRESS);

// Minimal ABI for the patched UndeadGame.sol. Aligned with abi/UndeadGame.json.
const GAME_ABI = [
  'function gameCount() view returns (uint256)',
  'function games(uint256) view returns (address creator, address nftContract, uint256 tokenId, uint256 endTime, uint256 assetValueUSD, uint256 totalETH, uint256 ticketCount, address winner, bool active, bool drawn, string description, bool nftPendingClaim)',
  'function getTicketPriceWei() view returns (uint256)',
  'function getMyTickets(uint256 id, address wallet) view returns (uint256)',
  'function getWinChanceBPS(uint256 id, address wallet) view returns (uint256)',
  'function totalETHVolume() view returns (uint256)',
  'function isOrphan(address nftContract, uint256 tokenId) view returns (bool, address)',
  'function buyTickets(uint256 id, uint256 qty) payable',
  'function drawWinner(uint256 id)',
  'function claimPrize(uint256 id)',
  'function cancelGame(uint256 id)',
  'function recoverOrphanedNFT(address nftContract, uint256 tokenId)',
  'function convertOrphanToGame(address nftContract, uint256 tokenId, uint256 durationSecs, uint256 assetValueUSD, string description)',
  // events
  'event GameCreated(uint256 indexed id, address indexed creator, address indexed nftContract, uint256 tokenId, uint256 endTime, uint256 assetValueUSD, string description)',
  'event TicketPurchased(uint256 indexed id, address indexed buyer, uint256 qty, uint256 totalTickets, uint256 amountPaid)',
  'event WinnerDrawn(uint256 indexed id, address indexed winner, uint256 winnerTicketIndex, uint256 totalETH)',
  'event PrizeClaimed(uint256 indexed id, address indexed winner)',
  'event NFTOrphaned(address indexed nftContract, uint256 indexed tokenId, address indexed sender, string reason)',
];

// Minimal ERC-721 fragment for the canonical safeTransferFrom with `data`.
const ERC721_ABI = [
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function tokenURI(uint256) view returns (string)',
  'function ownerOf(uint256) view returns (address)',
];

// ─── State ───────────────────────────────────────────────────────────────
let _games       = [];     // [{ id, ...struct, nftMeta?, image? }]
let _inventory   = [];     // [{ contract, tokenId, name, image, collection }]
let _orphans     = [];     // [{ contract, tokenId, name, image }]
let _activeTab   = 'active';
let _selectedNft = null;   // { contract, tokenId, name, image, collection } | null
let _openGameId  = null;
let _lastSeenGameIds = new Set(); // for celebration trigger
let _timers      = [];

// ─── Modal-picker state ──────────────────────────────────────────────────
let _collections      = [];          // [{address, name, image, count, items: []}]
let _pickerMode       = 'collections'; // 'collections' | 'nfts'
let _pickerCollection = null;        // the address being viewed in 'nfts' mode
let _pickerSearch     = '';          // search filter (collection or NFT name)

// ─── Boot ────────────────────────────────────────────────────────────────
(async function gamePage() {
  if (typeof ethers === 'undefined') { console.error('[game] ethers failed to load'); return; }
  window.BUUI.renderNetworkPill();
  window.BUUI.renderNavSocials();
  window.BUUI.bindMobileNav();
  window.BUUI.renderFooterAddresses();
  window.BUUI.bindFAQ?.();

  try { await window.BU.loadABIs(); } catch {}
  await window.BU.upgradeProviderFromKeys();
  await window.BU.tryEagerConnect();
  window.BUUI.renderWalletSlot();

  bindStaticUI();

  if (!GAME_LIVE) {
    console.warn('[game] No game contract address configured. Page running in OFFLINE preview mode.');
    showOfflineNotice();
    return;
  }

  await Promise.all([refreshGames(), refreshHeroStats()]);
  _timers.push(setInterval(refreshGames,     30_000));
  _timers.push(setInterval(refreshHeroStats, 30_000));
  _timers.push(setInterval(tickTimers,        1_000));

  await refreshInventory();

  window.BU.onAccountChange(() => {
    window.BUUI.renderWalletSlot();
    refreshInventory();
    if (_activeTab === 'mine') renderGrid();
  });
})();

function showOfflineNotice() {
  const wrap = document.getElementById('inventoryStatus');
  if (wrap) {
    wrap.innerHTML = `<div class="g-inv-status-inner">
      <div class="g-inv-status-icon">⚠</div>
      <p><strong>The $1 Game contract is not deployed yet.</strong></p>
      <p class="g-help">This page is fully ready — once an address is set in <code>config.js</code> (<code>BU_CONFIG.contracts.game</code>) games will appear here automatically.</p>
    </div>`;
  }
  ['gridActive','gridEnding','gridMine','gridEnded'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="empty">Awaiting contract deployment.</div>`;
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────
function _readGame() {
  return new ethers.Contract(GAME_ADDRESS, GAME_ABI, window.BU.getReadProvider());
}
function _writeGame() {
  const signer = window.BU.getSigner?.();
  return signer ? new ethers.Contract(GAME_ADDRESS, GAME_ABI, signer) : null;
}

async function refreshHeroStats() {
  if (!GAME_LIVE) return;
  try {
    const g = _readGame();
    const [vol, count] = await Promise.all([
      g.totalETHVolume().catch(()=>0n),
      g.gameCount().catch(()=>0n),
    ]);
    setText('heroStatVolume', window.BUUI.fmtETH(vol) + ' ETH');
    const active = _games.filter(x => x.active && !x.drawn).length;
    setText('heroStatActive', String(active || Number(count) || 0));
  } catch (e) { console.warn('[game] hero stats failed:', e.message); }
}

async function refreshGames() {
  if (!GAME_LIVE) return;
  try {
    const g = _readGame();
    const count = Number(await g.gameCount());
    if (count === 0) { _games = []; renderGrid(); return; }
    // Read all in batches of 20
    const BATCH = 20;
    const list = [];
    for (let i = 0; i < count; i += BATCH) {
      const end = Math.min(i + BATCH, count);
      const ids = [];
      for (let j = i; j < end; j++) ids.push(j);
      const results = await Promise.all(ids.map(id => g.games(id).catch(() => null)));
      results.forEach((r, idx) => {
        if (!r) return;
        list.push(_normalizeGame(ids[idx], r));
      });
    }
    // Trigger celebration for newly-drawn games we hadn't seen as drawn before.
    const me = (window.BU.getUserAddress?.() || '').toLowerCase();
    for (const game of list) {
      if (game.drawn && !_lastSeenGameIds.has(game.id) && game.winner && game.winner !== ethers.ZeroAddress) {
        if (me && game.winner.toLowerCase() === me) celebrateWinner(game);
      }
      if (game.drawn) _lastSeenGameIds.add(game.id);
    }
    _games = list;
    // Async-load NFT images in the background (best-effort).
    enrichWithImages(_games).then(() => renderGrid());
    renderGrid();
  } catch (e) {
    console.error('[game] refreshGames failed:', e.message);
    document.getElementById('gridActive').innerHTML = `<div class="empty">Error: ${e.message.slice(0,140)}</div>`;
  }
}

function _normalizeGame(id, r) {
  // r is the raw struct from contract.games(id)
  return {
    id,
    creator:        r.creator || r[0],
    nftContract:    r.nftContract || r[1],
    tokenId:        r.tokenId || r[2],
    endTime:        Number(r.endTime || r[3]),
    assetValueUSD:  Number(r.assetValueUSD || r[4]),
    totalETH:       r.totalETH || r[5],
    ticketCount:    Number(r.ticketCount || r[6]),
    winner:         r.winner || r[7],
    active:         r.active === undefined ? r[8] : r.active,
    drawn:          r.drawn  === undefined ? r[9] : r.drawn,
    description:    r.description || r[10] || '',
    nftPendingClaim: r.nftPendingClaim === undefined ? r[11] : r.nftPendingClaim,
    image: null, nftName: null, collection: null,
  };
}

async function enrichWithImages(games) {
  // Best-effort: fetch tokenURI for each unique (contract, tokenId) and resolve to image.
  // Falls back to placeholder skull if anything fails.
  const seen = new Set();
  const tasks = [];
  for (const g of games) {
    const key = `${g.nftContract}:${g.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(_resolveNftImage(g.nftContract, g.tokenId).then(meta => {
      if (!meta) return;
      games.filter(x => x.nftContract === g.nftContract && String(x.tokenId) === String(g.tokenId)).forEach(x => {
        x.image      = meta.image;
        x.nftName    = meta.name;
        x.collection = meta.collection;
      });
    }).catch(()=>{}));
  }
  await Promise.all(tasks);
}

async function _resolveNftImage(nftContract, tokenId) {
  try {
    const c = new ethers.Contract(nftContract, ERC721_ABI, window.BU.getReadProvider());
    const [uri, collection] = await Promise.all([
      c.tokenURI(tokenId).catch(() => null),
      c.name().catch(() => null),
    ]);
    if (!uri) return { image: null, name: `#${tokenId}`, collection };
    const json = await _fetchTokenURI(uri);
    if (!json) return { image: null, name: `#${tokenId}`, collection };
    return { image: _ipfsToHttp(json.image || json.image_url || ''), name: json.name || `#${tokenId}`, collection };
  } catch { return null; }
}
async function _fetchTokenURI(uri) {
  uri = _ipfsToHttp(uri);
  if (uri.startsWith('data:application/json')) {
    try { return JSON.parse(decodeURIComponent(uri.split(',')[1])); }
    catch { try { return JSON.parse(atob(uri.split(',')[1])); } catch { return null; } }
  }
  try {
    const r = await fetch(uri, { mode: 'cors' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
function _ipfsToHttp(u) {
  if (!u) return u;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
  return u;
}

// ─── Grid rendering ──────────────────────────────────────────────────────
function renderGrid() {
  const now = Math.floor(Date.now() / 1000);
  const me  = (window.BU.getUserAddress?.() || '').toLowerCase();

  const active = _games.filter(g => g.active && !g.drawn && g.endTime > now);
  const ending = active.filter(g => g.endTime - now < 6 * 3600).sort((a,b)=>a.endTime-b.endTime);
  const ended  = _games.filter(g => g.drawn || g.endTime <= now);
  const mine   = !me ? [] : _games.filter(g =>
    (g.creator && g.creator.toLowerCase() === me) ||
    (g.winner  && g.winner.toLowerCase()  === me));

  _paint('gridActive', active.sort((a,b)=>b.id-a.id));
  _paint('gridEnding', ending);
  _paint('gridEnded',  ended.sort((a,b)=>b.id-a.id));
  _paint('gridMine',   mine.sort((a,b)=>b.id-a.id));
}

function _paint(elId, list) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="empty">${
      elId === 'gridMine' && !window.BU.getUserAddress?.()
        ? 'Connect your wallet to see games you created or entered.'
        : 'Nothing here yet.'
    }</div>`;
    return;
  }
  el.innerHTML = list.map(_gameCardHTML).join('');
  el.querySelectorAll('[data-open-game]').forEach(card => {
    card.addEventListener('click', () => openDetail(Number(card.dataset.openGame)));
  });
}

function _gameCardHTML(g) {
  const now    = Math.floor(Date.now() / 1000);
  const left   = g.endTime - now;
  const status = g.drawn ? 'DRAWN' : (left > 0 ? 'LIVE' : 'AWAITING DRAW');
  const tlText = g.drawn ? '—' : _fmtCountdown(g.endTime);
  const img    = g.image
    ? `<img src="${g.image}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="g-card-img-fallback" style="display:none">💀</div>`
    : `<div class="g-card-img-fallback">💀</div>`;
  return `<div class="g-card" data-open-game="${g.id}">
    <div class="g-card-status g-card-status-${status.toLowerCase().replace(/\s+/g,'-')}">${status}</div>
    <div class="g-card-img">${img}</div>
    <div class="g-card-body">
      <div class="g-card-title">${g.nftName || `#${g.tokenId}`}</div>
      <div class="g-card-sub">${g.collection || _shortAddr(g.nftContract)} · ID ${g.tokenId}</div>
      <div class="g-card-stats">
        <div><span class="g-card-stat-lbl">Pot</span><span class="g-card-stat-val accent">${window.BUUI.fmtETH(g.totalETH)} ETH</span></div>
        <div><span class="g-card-stat-lbl">Tickets</span><span class="g-card-stat-val">${g.ticketCount}</span></div>
        <div><span class="g-card-stat-lbl">${g.drawn ? 'Winner' : 'Time Left'}</span><span class="g-card-stat-val">${g.drawn ? _shortAddr(g.winner) : tlText}</span></div>
      </div>
    </div>
  </div>`;
}

function _shortAddr(a) { return a ? a.slice(0,6) + '…' + a.slice(-4) : '—'; }

// ─── Live timer tick ─────────────────────────────────────────────────────
function tickTimers() {
  // Update only the inline "time left" text on active cards (cheap).
  const now = Math.floor(Date.now() / 1000);
  document.querySelectorAll('.g-card[data-open-game]').forEach(card => {
    const id = Number(card.dataset.openGame);
    const g  = _games.find(x => x.id === id);
    if (!g || g.drawn) return;
    const lbl = card.querySelector('.g-card-stat-val:last-child');
    if (!lbl) return;
    const left = g.endTime - now;
    lbl.textContent = _fmtCountdown(g.endTime);
  });
  // Detail modal timer
  if (_openGameId !== null) {
    const g = _games.find(x => x.id === _openGameId);
    if (g) {
      const left = g.endTime - Math.floor(Date.now()/1000);
      setText('gdTime', g.drawn ? '—' : _fmtCountdown(g.endTime));
    }
  }
}

// ─── Tabs ────────────────────────────────────────────────────────────────
function bindStaticUI() {
  document.querySelectorAll('.g-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      document.querySelectorAll('.g-tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.g-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === _activeTab));
    });
  });
  document.getElementById('heroCreateBtn')?.addEventListener('click',  () => openCreateModal());
  document.getElementById('howCreateBtn')?.addEventListener('click',   () => openCreateModal());
  document.getElementById('finalCreateBtn')?.addEventListener('click', () => openCreateModal());

  document.getElementById('inventoryRefreshBtn')?.addEventListener('click', () => refreshInventory(true));
  document.getElementById('invSearchInput')?.addEventListener('input', (e) => {
    _invSearch = e.target.value.trim().toLowerCase();
    _renderInventoryGrid();
  });

  // Modal close handlers (overlay click + × buttons)
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
    ov.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => ov.classList.remove('open')));
  });

  // Create-modal interactions
  document.querySelectorAll('#createModal .g-pill').forEach(p =>
    p.addEventListener('click', () => {
      document.querySelectorAll('#createModal .g-pill').forEach(x => x.classList.toggle('active', x === p));
    }));
  document.getElementById('cfChangeNft')?.addEventListener('click', () => {
    _selectedNft = null;
    _pickerMode = 'collections';
    _pickerCollection = null;
    _pickerSearch = '';
    const inp = document.getElementById('cfSearch'); if (inp) inp.value = '';
    _showCreateStep('picker');
  });
  document.getElementById('cfManualLink')?.addEventListener('click', () => {
    _selectedNft = null;
    _showCreateStep('config', { manual: true });
  });
  document.getElementById('cfBackToPicker')?.addEventListener('click', () => {
    _pickerMode = 'collections';
    _pickerCollection = null;
    _showCreateStep('picker');
  });
  document.getElementById('cfPickerRefresh')?.addEventListener('click', () => refreshInventory(true));
  document.getElementById('cfSubmit')?.addEventListener('click', submitCreateGame);

  // Detail-modal qty buttons
  document.querySelectorAll('#detailModal .g-qty').forEach(b =>
    b.addEventListener('click', () => {
      const inp = document.getElementById('gdQty');
      const step = Number(b.dataset.step);
      const next = Math.max(1, Math.min(100, (parseInt(inp.value)||1) + step));
      inp.value = next;
      _updateBuyCost();
    }));
  document.getElementById('gdQty')?.addEventListener('input', _updateBuyCost);

  // Celebration close
  document.getElementById('celebrationClose')?.addEventListener('click', () => {
    document.getElementById('celebration').classList.remove('open');
    _stopConfetti();
  });
}

// ─── Wallet NFT inventory (via Alchemy getNFTsForOwner) ─────────────────
let _invFetching = false;
let _invSearch   = '';
async function refreshInventory(force = false) {
  if (_invFetching && !force) return;
  _invFetching = true;
  try { await _refreshInventoryInner(force); }
  finally { _invFetching = false; }
}
async function _refreshInventoryInner(force = false) {
  const addr = window.BU.getUserAddress?.();
  const statusEl  = document.getElementById('inventoryStatus');
  const wrapEl    = document.getElementById('inventoryWrap');
  const headerEl  = document.getElementById('inventoryHeader');
  const gridEl    = document.getElementById('inventoryGrid');
  const orphanWrap= document.getElementById('orphanWrap');
  const orphanGrid= document.getElementById('orphanGrid');

  if (!addr) {
    statusEl.style.display = 'block';
    wrapEl.style.display   = 'none';
    orphanWrap.style.display = 'none';
    return;
  }
  statusEl.style.display = 'none';
  wrapEl.style.display   = 'block';
  headerEl.textContent   = 'Loading inventory…';

  // Wait briefly for ALCHEMY_KEY (api-keys may still be in flight).
  let key = window.ALCHEMY_KEY;
  if (!key) {
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (window.ALCHEMY_KEY) { key = window.ALCHEMY_KEY; break; }
    }
  }
  // Fallback: the rpcUrl in config.js already embeds an Alchemy key (it's the
  // public read-only one). Extract it so inventory works on any deploy even
  // without ALCHEMY_API_KEY env var configured.
  if (!key) {
    const rpc = window.BU_CONFIG?.activeNetwork?.rpcUrl || '';
    const m = rpc.match(/alchemy\.com\/v2\/([^/?#]+)/);
    if (m && m[1]) {
      key = m[1];
      console.info('[inv] using Alchemy key extracted from rpcUrl (no ALCHEMY_API_KEY env var)');
    }
  }
  if (!key) {
    gridEl.innerHTML = `<div class="empty">Alchemy API key not configured — set <code>ALCHEMY_API_KEY</code> in Netlify env vars to enable inventory lookup.</div>`;
    headerEl.textContent = `${_shortAddr(addr)} · inventory unavailable`;
    return;
  }

  try {
    const alchemyHost = window.BU_CONFIG.activeNetwork.alchemyHost || 'https://base-mainnet.g.alchemy.com';
    const items = [];
    let pageKey = '';
    let pages = 0;
    const MAX_PAGES = 50; // up to 5,000 NFTs per wallet
    while (pages < MAX_PAGES) {
      // orderBy=transferTime → Alchemy v3 returns most-recently-acquired first.
      const url = `${alchemyHost}/nft/v3/${key}/getNFTsForOwner?owner=${addr}&withMetadata=true&pageSize=100&orderBy=transferTime` + (pageKey ? `&pageKey=${pageKey}` : '');
      console.info('[inv] GET page', pages + 1);
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text();
        console.error('[inv] Alchemy', r.status, body.slice(0, 200));
        throw new Error(`Alchemy ${r.status}: ${body.slice(0,140)}`);
      }
      const d = await r.json();
      const owned = d.ownedNfts || [];
      console.info('[inv] page', pages+1, 'returned', owned.length, 'NFTs');
      for (const nft of owned) {
        // Skip spam / suspected scams — layered defence
        if (_isSpamNft(nft)) continue;
        items.push({
          contract: nft.contract?.address,
          tokenId:  nft.tokenId,
          name:     nft.name || nft.contract?.name || `#${nft.tokenId}`,
          image:    _bestImage(nft),
          collection: nft.contract?.name || nft.contract?.openSeaMetadata?.collectionName || _shortAddr(nft.contract?.address),
          collectionImage: nft.contract?.openSeaMetadata?.imageUrl || _bestImage(nft) || null,
          floorPrice: parseFloat(nft.contract?.openSeaMetadata?.floorPrice || 0) || 0,
          safelistStatus: nft.contract?.openSeaMetadata?.safelistStatus || '',
        });
      }
      // Progressive render: update inventory + repaint picker after each page so
      // users see results without waiting for full pagination.
      _inventory = [...items];
      _collections = _groupByCollection(_inventory);
      headerEl.textContent = `${_shortAddr(addr)} · ${items.length} NFT${items.length===1?'':'s'} so far…`;
      if (items.length) {
        _renderInventoryGrid();
      }
      // Re-paint the modal picker if it's currently open.
      if (document.getElementById('cfPickerStep')?.style.display === 'block') {
        _renderPickerGrid();
      }
      pageKey = d.pageKey || '';
      pages++;
      if (!pageKey) break;
      // Tiny pause between pages to be polite + avoid throttling.
      await new Promise(r => setTimeout(r, 60));
    }
    headerEl.textContent = `${_shortAddr(addr)} · ${items.length} NFT${items.length===1?'':'s'} owned`;
    if (!items.length) {
      _renderInventoryGrid();
    }
  } catch (e) {
    console.error('[inv] failed:', e.message);
    gridEl.innerHTML = `<div class="empty">Failed to load inventory: ${e.message.slice(0,140)}</div>`;
  }

  // If the create modal is open on the picker step, re-render it with fresh data.
  if (document.getElementById('cfPickerStep')?.style.display === 'block') {
    _renderPickerGrid();
  }

  // Orphan check — search unique (contract, tokenId) in inventory for orphan status.
  // Runs fire-and-forget so it never blocks the inventory render.
  // Capped at 30 items to avoid hundreds of sequential RPC calls.
  if (GAME_LIVE) {
    (async () => {
    try {
      const g = _readGame();
      const orphans = [];
      const checkList = _inventory.slice(0, 30);
      for (const it of checkList) {
        try {
          const [, sender] = await g.isOrphan(it.contract, it.tokenId);
          if (sender && sender.toLowerCase() === addr.toLowerCase()) {
            orphans.push(it);
          }
        } catch {}
      }
      _orphans = orphans;
      if (orphans.length) {
        orphanWrap.style.display = 'block';
        orphanGrid.innerHTML = orphans.map(o => `
          <div class="g-orphan-card">
            <div class="g-orphan-img">${o.image ? `<img src="${o.image}" alt="" onerror="this.style.display='none'">` : '💀'}</div>
            <div class="g-orphan-meta">
              <div class="g-orphan-name">${o.name}</div>
              <div class="g-orphan-sub">${o.collection}</div>
            </div>
            <button class="btn btn-sm btn-primary" data-recover='${JSON.stringify({c:o.contract, t:o.tokenId})}'>Recover</button>
          </div>`).join('');
        orphanGrid.querySelectorAll('[data-recover]').forEach(b =>
          b.addEventListener('click', () => recoverOrphan(JSON.parse(b.dataset.recover))));
      } else {
        orphanWrap.style.display = 'none';
      }
    } catch (e) { console.warn('[orphans] check failed:', e.message); }
    })(); // fire-and-forget, does not block inventory render
  }
}
// ─── Spam / junk NFT filter ──────────────────────────────────────────────
// Layer 1: Alchemy server-side excludeFilters=SPAM,AIRDROPS handles most junk.
// Layer 2: this catches whatever slips through.
const _SPAM_KEYWORDS = /\b(claim|airdrop|reward|voucher|visit|free\s*mint|whitelist|discord\.gg|t\.me\/|http[s]?:\/\/)\b/i;
const _SCAM_URL_RE   = /\.(xyz|gg|vip|bond|win|click|loan|cam|surf|rest|hair)$/i;

function _isSpamNft(nft) {
  // Alchemy explicit flags
  if (nft.spamInfo?.isSpam)                        return true;
  if (nft.contract?.isSpam)                        return true;

  // Any spam classification present
  const classifications = nft.spamInfo?.classifications || [];
  if (classifications.length > 0)                  return true;

  // OpenSea safelist: if explicitly approved/verified, trust it and keep
  const safelistStatus = nft.contract?.openSeaMetadata?.safelistStatus;
  if (safelistStatus === 'approved' || safelistStatus === 'verified') return false;

  const name        = (nft.name || nft.contract?.name || '').toLowerCase();
  const description = (nft.description || nft.raw?.metadata?.description || '').toLowerCase();
  const contractName = (nft.contract?.name || '');

  // No contract name at all → likely anonymous airdrop junk
  if (!contractName.trim())                        return true;

  // Scam keywords in name or description
  if (_SPAM_KEYWORDS.test(name))                   return true;
  if (_SPAM_KEYWORDS.test(description))            return true;

  // Suspicious URL-like content in name (e.g. "visit scam.xyz to claim")
  if (_SCAM_URL_RE.test(name))                     return true;

  // No image at all and no metadata → worthless airdrop
  const hasImage = !!(nft.image?.cachedUrl || nft.image?.originalUrl || nft.raw?.metadata?.image);
  if (!hasImage && !nft.raw?.metadata?.attributes?.length) return true;

  return false;
}

function _bestImage(nft) {
  const i = nft.image || {};
  return i.cachedUrl || i.thumbnailUrl || i.pngUrl || i.originalUrl || _ipfsToHttp(nft.raw?.metadata?.image || '') || null;
}
function _renderInventoryGrid() {
  const gridEl = document.getElementById('inventoryGrid');
  if (!gridEl) return;
  const filtered = _invSearch
    ? _inventory.filter(it =>
        it.name.toLowerCase().includes(_invSearch) ||
        (it.collection || '').toLowerCase().includes(_invSearch))
    : _inventory;
  if (!filtered.length) {
    gridEl.innerHTML = `<div class="empty">${_invSearch ? `No NFTs match "${_escape(_invSearch)}"` : 'No NFTs found in this wallet on Base.'}</div>`;
    return;
  }
  gridEl.innerHTML = filtered.map(_invCardHTML).join('');
  gridEl.querySelectorAll('[data-pick]').forEach(c =>
    c.addEventListener('click', () => pickFromInventory(Number(c.dataset.pick))));
}

function _invCardHTML(it, idx) {
  return `<div class="g-inv-card" data-pick="${idx ?? _inventory.indexOf(it)}">
    <div class="g-inv-img">${it.image ? `<img src="${it.image}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="g-inv-img-fallback" style="display:none">💀</div>` : '<div class="g-inv-img-fallback">💀</div>'}</div>
    <div class="g-inv-body">
      <div class="g-inv-name">${it.name}</div>
      <div class="g-inv-sub">${it.collection}</div>
    </div>
    <div class="g-inv-pick-overlay"><span>＋ Create $1 Game</span></div>
  </div>`;
}
function pickFromInventory(idx) {
  _selectedNft = _inventory[idx];
  if (!_selectedNft) return;
  openCreateModal();
}

// ─── Create-game modal ──────────────────────────────────────────────────
// State machine: connect (no wallet) → picker (choose NFT) → config (set duration / value / desc)
function openCreateModal() {
  const modal = document.getElementById('createModal');
  modal.classList.add('open');

  const addr = window.BU.getUserAddress?.();
  if (!addr) { _showCreateStep('connect'); return; }
  if (_selectedNft) { _showCreateStep('config', { manual: false }); return; }
  _showCreateStep('picker');
}

// stepName ∈ 'connect' | 'picker' | 'config'
function _showCreateStep(stepName, opts = {}) {
  const eyebrow = document.getElementById('cfEyebrow');
  const title   = document.getElementById('cfTitle');
  document.getElementById('cfConnectStep').style.display = stepName === 'connect' ? 'block' : 'none';
  document.getElementById('cfPickerStep' ).style.display = stepName === 'picker'  ? 'block' : 'none';
  document.getElementById('cfConfigStep' ).style.display = stepName === 'config'  ? 'flex'  : 'none';
  _updateStepIndicator(stepName);

  if (stepName === 'connect') {
    eyebrow.textContent = 'Create A Game';
    title.textContent   = 'Connect Your Wallet';
    const slot = document.getElementById('cfConnectSlot');
    if (slot && !slot.dataset.bound) {
      slot.innerHTML = `<button class="btn btn-primary btn-lg" id="cfConnectBtn">Connect Wallet</button>`;
      slot.dataset.bound = '1';
      document.getElementById('cfConnectBtn').addEventListener('click', async () => {
        try {
          await window.BU.connectWallet?.();
          await refreshInventory(true);
          openCreateModal();
        } catch (e) {
          window.BUUI.toast?.({ title:'Connect failed', body:e.shortMessage||e.message, kind:'error' });
        }
      });
    }
    return;
  }

  if (stepName === 'picker') {
    eyebrow.textContent = 'Step 1 of 3';
    title.textContent   = _pickerMode === 'nfts' ? 'Pick An NFT' : 'Pick A Collection';
    _bindSearchBoxOnce();
    _renderPickerGrid();
    return;
  }

  // config step
  eyebrow.textContent = 'Step 2 of 3';
  title.textContent   = 'Configure Your Game';
  const selectedRow = document.getElementById('cfSelectedRow');
  const manualRow   = document.getElementById('cfManualRow');
  if (opts.manual || !_selectedNft) {
    selectedRow.style.display = 'none';
    manualRow.style.display   = 'block';
  } else {
    manualRow.style.display = 'none';
    selectedRow.style.display = 'block';
    document.getElementById('cfSelectedImg').innerHTML =
      _selectedNft.image ? `<img src="${_selectedNft.image}" alt="" onerror="this.style.display='none'">` : '💀';
    document.getElementById('cfSelectedName').textContent = _selectedNft.name;
    document.getElementById('cfSelectedSub').textContent  = `${_selectedNft.collection} · ID ${_selectedNft.tokenId}`;
  }
}

function _updateStepIndicator(stepName) {
  const map = { connect: 0, picker: 1, config: 2 };
  const idx = map[stepName] ?? 0;
  document.querySelectorAll('#createModal .g-cf-step-dot').forEach(d => {
    const dotIdx = Number(d.dataset.step) - 1;
    d.classList.toggle('active', dotIdx === idx);
    d.classList.toggle('done',   dotIdx <  idx);
  });
}

let _searchBound = false;
function _bindSearchBoxOnce() {
  if (_searchBound) return;
  const inp = document.getElementById('cfSearch');
  if (!inp) return;
  inp.addEventListener('input', () => {
    _pickerSearch = inp.value.trim().toLowerCase();
    _renderPickerGrid();
  });
  document.getElementById('cfBackToCollections')?.addEventListener('click', () => {
    _pickerMode = 'collections';
    _pickerCollection = null;
    document.getElementById('cfTitle').textContent = 'Pick A Collection';
    _renderPickerGrid();
  });
  _searchBound = true;
}

// Group flat inventory list into collections, preserving the inventory order
// (which is most-recently-acquired first, courtesy of Alchemy orderBy=transferTime).
function _groupByCollection(items) {
  const map = new Map();
  for (const it of items) {
    const key = (it.contract || '').toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        address: it.contract,
        name:    it.collection,
        image:   it.collectionImage || it.image || null,
        count:   0,
        items:   [],
      });
    }
    const entry = map.get(key);
    entry.count++;
    entry.items.push(it);
    // Use first available image as collection cover (= most recent item due to order).
    if (!entry.image && it.image) entry.image = it.image;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// Single entry point: paints picker according to _pickerMode.
function _renderPickerGrid() {
  const status        = document.getElementById('cfPickerStatus');
  const collectionsEl = document.getElementById('cfCollectionsGrid');
  const nftsEl        = document.getElementById('cfPickerGrid');
  const breadcrumb    = document.getElementById('cfBreadcrumb');
  if (!status) return;

  // Empty state — still loading?
  if (!_inventory || _inventory.length === 0) {
    status.style.display       = 'block';
    collectionsEl.style.display = 'none';
    nftsEl.style.display        = 'none';
    breadcrumb.style.display    = 'none';
    status.innerHTML = `<div class="g-cf-empty"><div class="g-cf-empty-icon">⌛</div><p>Looking up NFTs in your wallet…</p></div>`;
    refreshInventory().then(() => {
      if (document.getElementById('cfPickerStep').style.display !== 'none') _renderPickerGrid();
    });
    return;
  }

  if (_pickerMode === 'collections') {
    breadcrumb.style.display    = 'none';
    nftsEl.style.display        = 'none';
    collectionsEl.style.display = 'grid';

    const filter = _pickerSearch;
    const list = filter
      ? _collections.filter(c => c.name.toLowerCase().includes(filter))
      : _collections;

    status.style.display = 'block';
    status.textContent   = `${_collections.length} collection${_collections.length===1?'':'s'} · ${_inventory.length} NFT${_inventory.length===1?'':'s'} total · most recent first`;

    if (!list.length) {
      collectionsEl.innerHTML = `<div class="empty" style="grid-column:1/-1">No collections match "${_escape(filter)}".</div>`;
      return;
    }

    collectionsEl.innerHTML = list.map((c, idx) => `
      <div class="g-collection-card" data-collection="${_escape(c.address || '')}">
        <div class="g-collection-img">${c.image
          ? `<img src="${c.image}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="g-collection-img-fallback" style="display:none">💀</div>`
          : `<div class="g-collection-img-fallback">💀</div>`}</div>
        <div class="g-collection-body">
          <div class="g-collection-name">${_escape(c.name)}</div>
          <div class="g-collection-count">${c.count} NFT${c.count===1?'':'s'}</div>
        </div>
      </div>`).join('');

    collectionsEl.querySelectorAll('[data-collection]').forEach(card => {
      card.addEventListener('click', () => {
        _pickerMode       = 'nfts';
        _pickerCollection = card.dataset.collection;
        document.getElementById('cfTitle').textContent = 'Pick An NFT';
        _renderPickerGrid();
      });
    });
    return;
  }

  // mode === 'nfts'
  collectionsEl.style.display = 'none';
  nftsEl.style.display        = 'grid';
  breadcrumb.style.display    = 'flex';

  const col = _collections.find(c => (c.address || '').toLowerCase() === (_pickerCollection || '').toLowerCase());
  if (!col) {
    // Collection vanished (eg refreshed while open); bounce back.
    _pickerMode = 'collections';
    return _renderPickerGrid();
  }
  document.getElementById('cfCollectionName').textContent = col.name;

  const filter = _pickerSearch;
  const list = filter
    ? col.items.filter(it => it.name.toLowerCase().includes(filter))
    : col.items;

  status.style.display = 'block';
  status.textContent   = `${col.count} NFT${col.count===1?'':'s'} in ${col.name} · click one to use as the prize`;

  if (!list.length) {
    nftsEl.innerHTML = `<div class="empty" style="grid-column:1/-1">No NFTs match "${_escape(filter)}".</div>`;
    return;
  }
  nftsEl.innerHTML = list.map((it) => {
    const invIdx = _inventory.indexOf(it);
    return `<div class="g-picker-card" data-pick="${invIdx}">
      <div class="g-picker-img">${it.image
        ? `<img src="${it.image}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="g-picker-img-fallback" style="display:none">💀</div>`
        : `<div class="g-picker-img-fallback">💀</div>`}</div>
      <div class="g-picker-body">
        <div class="g-picker-name">${_escape(it.name)}</div>
        <div class="g-picker-sub">ID ${_escape(String(it.tokenId))}</div>
      </div>
    </div>`;
  }).join('');
  nftsEl.querySelectorAll('[data-pick]').forEach(card => {
    card.addEventListener('click', () => {
      const idx = Number(card.dataset.pick);
      _selectedNft = _inventory[idx];
      _showCreateStep('config', { manual: false });
    });
  });
}
function _escape(s) { return String(s||'').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

async function submitCreateGame() {
  if (!GAME_LIVE)            { window.BUUI.toast({ title:'Offline', body:'Contract not deployed yet', kind:'warn' }); return; }
  if (!window.BU.getSigner?.()) { window.BUUI.toast({ title:'Wallet', body:'Connect your wallet first', kind:'warn' }); return; }

  let nftAddr, tokenId;
  if (_selectedNft) {
    nftAddr = _selectedNft.contract;
    tokenId = _selectedNft.tokenId;
  } else {
    nftAddr = document.getElementById('cfNftAddr').value.trim();
    tokenId = document.getElementById('cfTokenId').value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(nftAddr)) { window.BUUI.toast({ title:'Bad input', body:'Invalid NFT contract', kind:'warn' }); return; }
    if (!/^\d+$/.test(tokenId))               { window.BUUI.toast({ title:'Bad input', body:'Invalid token ID', kind:'warn' }); return; }
  }

  const duration = Number(document.querySelector('#createModal .g-pill.active')?.dataset.dur || 86400);
  const valueUSD = parseInt(document.getElementById('cfValue').value, 10);
  const desc     = document.getElementById('cfDesc').value.trim();
  if (!Number.isFinite(valueUSD) || valueUSD < 1) { window.BUUI.toast({ title:'Bad input', body:'Asset value must be >= $1', kind:'warn' }); return; }
  if (desc.length > 120)                          { window.BUUI.toast({ title:'Bad input', body:'Description too long', kind:'warn' }); return; }

  try {
    const signer = window.BU.getSigner();
    const owner  = await signer.getAddress();
    // Canonical safe path: encode params and call NFT's safeTransferFrom(owner, GAME, tokenId, data).
    // Works for plain ERC-721 and most operator-filtered collections. For ERC-721C
    // at security level 2+, the collection owner must allowlist this game contract
    // on the V3 validator (0x721C0078c2328597Ca70F5451ffF5A7B38D4E947) first — see
    // catch block below for the user-facing error.
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256','uint256','string'],
      [BigInt(duration), BigInt(valueUSD * 100), desc] // contract expects USD in cents (>= 100)
    );
    const nft = new ethers.Contract(nftAddr, ERC721_ABI, signer);
    console.info('[create] safeTransferFrom →', GAME_ADDRESS, 'tokenId', tokenId, 'duration', duration, 'valueCents', valueUSD*100);
    await window.BUUI.trackTx('Create $1 Game', nft['safeTransferFrom(address,address,uint256,bytes)'](owner, GAME_ADDRESS, tokenId, data));
    document.getElementById('createModal').classList.remove('open');
    _selectedNft = null;
    await refreshGames();
    await refreshInventory();
  } catch (e) {
    console.error('[create] failed:', e);
    const isTransferRestricted = e.data === '0x369c2f4c' || (e.message||'').includes('custom error');
const errBody = isTransferRestricted
  ? 'This NFT collection uses ERC-721C transfer restrictions. The collection owner must whitelist the game contract before it can be used as a prize.'
  : (window.BUUI.explainError ? window.BUUI.explainError(e) : (e.shortMessage || e.message || 'Unknown'));
window.BUUI.toast({ title:'Create failed', body: errBody, kind:'error' });
  }
}

// ─── Detail modal ────────────────────────────────────────────────────────
function openDetail(id) {
  const g = _games.find(x => x.id === id);
  if (!g) return;
  _openGameId = id;
  setText('gdEyebrow', `Game #${id}`);
  setText('gdTitle', g.nftName || `#${g.tokenId}`);
  setText('gdValue', '$' + (g.assetValueUSD / 100).toLocaleString());
  setText('gdTickets', String(g.ticketCount));
  setText('gdPot', window.BUUI.fmtETH(g.totalETH) + ' ETH');
  const left = g.endTime - Math.floor(Date.now()/1000);
  setText('gdTime', g.drawn ? '—' : _fmtCountdown(g.endTime));
  const img = document.getElementById('gdImg');
  const fb  = document.getElementById('gdImgFallback');
  if (g.image) { img.src = g.image; img.style.display = 'block'; fb.style.display = 'none'; img.onerror = () => { img.style.display='none'; fb.style.display='flex'; }; }
  else        { img.style.display = 'none'; fb.style.display = 'flex'; }
  // My tickets
  const me = window.BU.getUserAddress?.();
  if (me && GAME_LIVE) {
    _readGame().getMyTickets(id, me).then(n => setText('gdMine', String(n))).catch(()=>setText('gdMine','0'));
    _readGame().getWinChanceBPS(id, me).then(bps => setText('gdOdds', ((Number(bps)/100).toFixed(2)) + '%')).catch(()=>setText('gdOdds','—'));
  } else {
    setText('gdMine', me ? '0' : '—');
    setText('gdOdds', me ? '0.00%' : '—');
  }
  // Buy row visibility + actions
  const now = Math.floor(Date.now()/1000);
  const buyRow = document.getElementById('gdBuyRow');
  const actions = document.getElementById('gdActions');
  buyRow.style.display = (g.active && !g.drawn && g.endTime > now) ? 'block' : 'none';
  const buttons = [];
  if (g.active && !g.drawn && g.endTime > now) buttons.push(`<button class="btn btn-primary btn-block" id="gdBuyBtn">Buy Tickets</button>`);
  if (g.active && !g.drawn && g.endTime <= now) buttons.push(`<button class="btn btn-primary btn-block" id="gdDrawBtn">Draw Winner</button>`);
  if (g.drawn && g.nftPendingClaim && me && g.winner && g.winner.toLowerCase() === me.toLowerCase()) buttons.push(`<button class="btn btn-primary btn-block" id="gdClaimBtn">Claim NFT Prize</button>`);
  if (g.active && !g.drawn && g.ticketCount === 0 && me && g.creator && g.creator.toLowerCase() === me.toLowerCase()) buttons.push(`<button class="btn btn-danger btn-block" id="gdCancelBtn">Cancel Game</button>`);
  actions.innerHTML = buttons.join('') || `<div class="empty" style="padding:8px">No actions available.</div>`;
  document.getElementById('gdBuyBtn')?.addEventListener('click', () => doBuyTickets(id));
  document.getElementById('gdDrawBtn')?.addEventListener('click', () => doDraw(id));
  document.getElementById('gdClaimBtn')?.addEventListener('click', () => doClaim(id));
  document.getElementById('gdCancelBtn')?.addEventListener('click', () => doCancel(id));
  _updateBuyCost();
  document.getElementById('detailModal').classList.add('open');
}

async function _updateBuyCost() {
  if (!GAME_LIVE) return;
  const qty = Math.max(1, Math.min(100, parseInt(document.getElementById('gdQty')?.value || '1') || 1));
  try {
    const price = await _readGame().getTicketPriceWei();
    const total = price * BigInt(qty);
    setText('gdCost', `${window.BUUI.fmtETHPrecise ? window.BUUI.fmtETHPrecise(total) : window.BUUI.fmtETH(total)} ETH (~$${qty}.00)`);
  } catch { setText('gdCost', `~$${qty}.00`); }
}

async function doBuyTickets(id) {
  try {
    if (!window.BU.getSigner?.()) { window.BUUI.toast({ title:'Wallet', body:'Connect first', kind:'warn' }); return; }
    const qty = Math.max(1, Math.min(100, parseInt(document.getElementById('gdQty').value)||1));
    const price = await _readGame().getTicketPriceWei();
    // Send 2% buffer to absorb micro-price-shifts between view + tx; contract refunds overpay.
    const value = (price * BigInt(qty) * 102n) / 100n;
    await window.BUUI.trackTx(`Buy ${qty} ticket${qty===1?'':'s'}`, _writeGame().buyTickets(id, qty, { value }));
    await refreshGames();
    openDetail(id);
  } catch (e) {
    console.error('[buy] failed:', e);
    window.BUUI.toast({ title:'Buy failed', body: window.BUUI.explainError ? window.BUUI.explainError(e) : (e.shortMessage||e.message||'Unknown'), kind:'error' });
  }
}
async function doDraw(id) {
  try {
    if (!window.BU.getSigner?.()) { window.BUUI.toast({ title:'Wallet', body:'Connect first', kind:'warn' }); return; }
    await window.BUUI.trackTx(`Draw winner #${id}`, _writeGame().drawWinner(id));
    await refreshGames();
    // If we're the winner, refreshGames() will trigger celebrateWinner() automatically.
    openDetail(id);
  } catch (e) { window.BUUI.toast({ title:'Draw failed', body: e.shortMessage||e.message, kind:'error' }); }
}
async function doClaim(id) {
  try {
    await window.BUUI.trackTx(`Claim prize #${id}`, _writeGame().claimPrize(id));
    await refreshGames();
    openDetail(id);
  } catch (e) { window.BUUI.toast({ title:'Claim failed', body: e.shortMessage||e.message, kind:'error' }); }
}
async function doCancel(id) {
  try {
    await window.BUUI.trackTx(`Cancel game #${id}`, _writeGame().cancelGame(id));
    await refreshGames();
    document.getElementById('detailModal').classList.remove('open');
  } catch (e) { window.BUUI.toast({ title:'Cancel failed', body: e.shortMessage||e.message, kind:'error' }); }
}

async function recoverOrphan(args) {
  try {
    if (!window.BU.getSigner?.()) { window.BUUI.toast({ title:'Wallet', body:'Connect first', kind:'warn' }); return; }
    await window.BUUI.trackTx('Recover NFT', _writeGame().recoverOrphanedNFT(args.c, args.t));
    await refreshInventory(true);
  } catch (e) { window.BUUI.toast({ title:'Recover failed', body: e.shortMessage||e.message, kind:'error' }); }
}

// ─── Winner celebration: confetti + glow overlay ────────────────────────
let _confettiRAF = null;
function celebrateWinner(game) {
  const overlay = document.getElementById('celebration');
  setText('celebrationWinner', `${_shortAddr(game.winner)}`);
  setText('celebrationPrize', `${game.nftName || `#${game.tokenId}`} · ${window.BUUI.fmtETH(game.totalETH)} ETH pot`);
  overlay.classList.add('open');
  _startConfetti();
}
function _startConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = window.innerWidth  * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const COLORS = ['#4ed98a', '#7ce8a8', '#c8a450', '#e8c878', '#ff6ec7', '#ff9bd9', '#e6f0e0'];
  const particles = [];
  for (let i = 0; i < 220; i++) {
    particles.push({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 60,
      y: window.innerHeight / 2 + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 16 - 4,
      g:  0.35 + Math.random() * 0.25,
      r:  Math.random() * 6 + 3,
      rot: Math.random() * Math.PI,
      vr:  (Math.random() - 0.5) * 0.4,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      shape: Math.random() < 0.5 ? 'rect' : 'circle',
      life: 1,
    });
  }
  let started = performance.now();
  const tick = (t) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const elapsed = (t - started) / 1000;
    for (const p of particles) {
      p.vy += p.g;
      p.x  += p.vx;
      p.y  += p.vy;
      p.rot += p.vr;
      p.life = Math.max(0, 1 - elapsed / 5);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.r, -p.r/2, p.r*2, p.r);
      else { ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI*2); ctx.fill(); }
      ctx.restore();
    }
    if (elapsed < 5.5) _confettiRAF = requestAnimationFrame(tick);
    else _stopConfetti();
  };
  _confettiRAF = requestAnimationFrame(tick);
}
function _stopConfetti() {
  if (_confettiRAF) cancelAnimationFrame(_confettiRAF);
  _confettiRAF = null;
  const canvas = document.getElementById('confettiCanvas');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ─── Countdown formatter ─────────────────────────────────────────────────
function _fmtCountdown(endTime) {
  const left = endTime - Math.floor(Date.now() / 1000);
  if (left <= 0) return 'Ended';
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (d > 0)  return `${d}d ${h}h ${String(m).padStart(2,'0')}m`;
  if (h > 0)  return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  return `${m}m ${String(s).padStart(2,'0')}s`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }