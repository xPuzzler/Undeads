// ─── ABIs (only the functions this page uses) ─────────────────
const NFT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function totalSupply() view returns (uint256)',
  'function exists(uint256 tokenId) view returns (bool)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];

const STAKING_ABI = [
  'function stake(uint256[] calldata tokenIds)',
  'function unstake(uint256[] calldata tokenIds)',
  'function claim()',
  'function stakeAndClaim(uint256[] calldata tokenIds)',
  'function earned(address) view returns (uint256)',
  'function stakedBalance(address) view returns (uint256)',
  'function getStakedTokens(address) view returns (uint256[])',
  'function totalStaked() view returns (uint256)',
  'function timeUntilUnstake(address) view returns (uint256)',
  'function rewardPoolBalance() view returns (uint256)',
  'function totalRewardsReceived() view returns (uint256)',
  'function totalRewardsDistributed() view returns (uint256)',
  'event Staked(address indexed user, uint256[] tokenIds)',
  'event Unstaked(address indexed user, uint256[] tokenIds)',
  'event RewardClaimed(address indexed user, uint256 amount)',
  'event RoyaltyReceived(uint256 total, uint256 toOwner, uint256 toPool)',
];

// ─── STATE ────────────────────────────────────────────────────
let provider, signer, userAddress;
let nftContract, stakingContract;
let readProvider;               // Always-available read-only provider
let walletNFTs = [];
let stakedNFTs = [];
const selectedWallet = new Set();
const selectedStaked = new Set();
let ethPriceUsd = 0;
let pollTimer = null;
let unlockTimer = null;       // setInterval handle for the live countdown
let unlockEndTime = 0;        // unix ms when the lock expires (0 = no lock)

// ─── PRE-LAUNCH FLAG ──────────────────────────────────────────
const STAKING_ENABLED = !!(NETWORK && NETWORK.stakingEnabled);
const MAX_BATCH_SIZE = 50;

function showPreLaunchModal() {
  const m = document.getElementById('prelaunchModal');
  if (!m) return;
  m.classList.add('open');
}
function hidePreLaunchModal() {
  const m = document.getElementById('prelaunchModal');
  if (!m) return;
  m.classList.remove('open');
}

// ─── STAT ANIMATION SYSTEM ───────────────────────────────────
// Tracks previous values so we can detect changes and animate
// only the cards whose numbers actually moved.
const _prevStatValues = {};

/**
 * updateStat(id, newText)
 * - First call ever for this id  → plays entrance (count-up + slide-in)
 * - Subsequent call, value same  → silent no-op
 * - Subsequent call, value diff  → vibrate + glow flash
 */
function updateStat(id, newText) {
  const el = document.getElementById(id);
  if (!el) return;
  const card = el.closest('.stat-card');
  const isFirst = !Object.prototype.hasOwnProperty.call(_prevStatValues, id);
  const prev    = _prevStatValues[id];
  _prevStatValues[id] = newText;

  if (isFirst) {
    // Entrance: slide-up fade + count-up number
    if (card) {
      card.classList.remove('stat-entering', 'stat-changed');
      void card.offsetWidth;
      card.classList.add('stat-entering');
      setTimeout(() => card.classList.remove('stat-entering'), 700);
    }
    _countUpEl(el, newText);
    return;
  }

  // Silent if unchanged
  if (prev === newText) return;

  // Value changed — update text then vibrate + glow
  _countUpEl(el, newText);
  if (card) {
    card.classList.remove('stat-changed');
    void card.offsetWidth;
    card.classList.add('stat-changed');
    setTimeout(() => card.classList.remove('stat-changed'), 1400);
  }
}

/**
 * _countUpEl(el, targetStr)
 * Animates from 0 to the numeric value embedded in targetStr.
 * Preserves prefix/suffix (e.g. " Ξ", "%", "— ").
 */
function _countUpEl(el, targetStr) {
  if (!targetStr || targetStr === '-' || targetStr === '—') {
    el.textContent = targetStr;
    return;
  }

  // Match the first run of digits (with optional commas / decimal)
  const match = targetStr.match(/[\d,]+\.?\d*/);
  if (!match) { el.textContent = targetStr; return; }

  const raw = match[0].replace(/,/g, '');
  const num = parseFloat(raw);
  if (isNaN(num) || num === 0) { el.textContent = targetStr; return; }

  const before = targetStr.slice(0, match.index);
  const after  = targetStr.slice(match.index + match[0].length);
  const dec    = raw.includes('.') ? raw.split('.')[1].length : 0;
  const dur    = 850;
  const t0     = performance.now();

  (function tick(now) {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const v = num * e;
    const s = dec
      ? v.toFixed(dec)
      : Math.round(v).toLocaleString();
    el.textContent = before + s + after;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = targetStr; // pin exact final value
  })(t0);
}

/**
 * flashRewardsPanel()
 * Pulses the big ETH number in the rewards card when rewards change.
 */
function flashRewardsPanel() {
  const el = document.getElementById('rewardsAmount');
  if (!el) return;
  el.classList.remove('rewards-updating');
  void el.offsetWidth;
  el.classList.add('rewards-updating');
  setTimeout(() => el.classList.remove('rewards-updating'), 1000);
}

// ─── HELPERS ──────────────────────────────────────────────────
function notify(msg, type = 'info') {
  const old = document.querySelector('.notification');
  if (old) old.remove();
  const n = document.createElement('div');
  n.className = 'notification ' + type;
  n.innerHTML = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 4500);
}

const short = a => a.slice(0, 6) + '…' + a.slice(-4);

function fmtDuration(s) {
  if (s <= 0) return 'Unlocked';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${h}h ${m}m ${ss}s`;
}

// ── Live countdown timer ─────────────────────────────────────
function startUnlockCountdown() {
  stopUnlockCountdown();
  tickUnlockCountdown();
  unlockTimer = setInterval(tickUnlockCountdown, 1000);
}

function stopUnlockCountdown() {
  if (unlockTimer) {
    clearInterval(unlockTimer);
    unlockTimer = null;
  }
}

function tickUnlockCountdown() {
  const notice = document.getElementById('lockNotice');
  if (!notice) return;

  if (!unlockEndTime || stakedNFTs.length === 0) {
    notice.innerHTML = '';
    stopUnlockCountdown();
    return;
  }

  const remainingMs  = unlockEndTime - Date.now();
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));

  if (remainingSec <= 0) {
    notice.innerHTML = `<div class="timer-display unlocked"><i class="fas fa-unlock"></i> Unlocked — unstake anytime</div>`;
    stopUnlockCountdown();
    unlockEndTime = 0;
    if (stakingContract && userAddress) refreshStakedNFTs();
    return;
  }

  notice.innerHTML = `<div class="timer-display locked"><i class="fas fa-lock"></i> Unlocks in ${fmtDuration(remainingSec)}</div>`;
}

// ── Renderer image fetch (testnet fallback) ───────────────────
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

async function fetchImageFromRenderer(id) {
  if (!NETWORK.rendererAddress) return '';
  try {
    const data = '0xc87b56dd' + BigInt(id).toString(16).padStart(64, '0');
    const raw  = await readProvider.call({ to: NETWORK.rendererAddress, data });
    const uri  = abiDecodeString(raw);
    const b64  = uri.replace(/^data:application\/json;base64,/, '');
    const json = JSON.parse(atob(b64));
    return json.image || '';
  } catch { return ''; }
}

// ─── CURSOR + SCROLL ──────────────────────────────────────────
(function () {
  const cursor = document.querySelector('.cursor');
  const dot = document.querySelector('.cursor-dot');
  if (!cursor || !dot) return;
  let mx = 0, my = 0, cx = 0, cy = 0;
  (function loop () {
    cx += (mx - cx) * 0.12;
    cy += (my - cy) * 0.12;
    cursor.style.transform = `translate(${cx - 10}px, ${cy - 10}px)`;
    requestAnimationFrame(loop);
  })();
  document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    dot.style.transform = `translate(${mx - 2}px, ${my - 2}px)`;
  }, { passive: true });
  ['a', 'button', '.stake-nft-card', '.tab-btn'].forEach(sel => {
    document.addEventListener('mouseover', e => {
      if (e.target.closest(sel)) cursor.classList.add('hover');
    });
    document.addEventListener('mouseout', e => {
      if (e.target.closest(sel)) cursor.classList.remove('hover');
    });
  });
})();

window.addEventListener('scroll', () => {
  const bar = document.querySelector('.scroll-progress');
  if (!bar) return;
  const h = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  bar.style.width = ((window.pageYOffset / h) * 100) + '%';
});

// ─── NETWORK BADGE ────────────────────────────────────────────
function mountNetworkBadge () {
  if (!IS_TESTNET) return;
  const badge = document.createElement('div');
  badge.className = 'testnet-banner';
  badge.innerHTML = `
    <span class="tb-pulse"></span>
    <strong>TESTNET MODE</strong> - ${NETWORK.label} ·
    you are testing with simulated royalties; mainnet activity will be live
  `;
  document.body.prepend(badge);
}

// ─── READ-ONLY PROVIDER ───────────────────────────────────────
readProvider = new ethers.JsonRpcProvider(NETWORK.rpcUrl);
let nftReadContract = new ethers.Contract(NETWORK.NFT_ADDRESS, NFT_ABI, readProvider);
// Dedicated provider for eth_getLogs — public Base RPC has no block range limits
// and works without wallet connection on all browsers including MetaMask mobile
const logsProvider = new ethers.JsonRpcProvider('https://mainnet.base.org');

window.upgradeReadProvider = function(rpcUrl) {
  if (!rpcUrl || rpcUrl === NETWORK.rpcUrl) return;
  console.info('[staking] Upgraded read provider to Alchemy RPC');
  readProvider = new ethers.JsonRpcProvider(rpcUrl);
  nftReadContract = new ethers.Contract(NETWORK.NFT_ADDRESS, NFT_ABI, readProvider);
  NETWORK.rpcUrl = rpcUrl;
};

// ─── WALLET CONNECT ───────────────────────────────────────────
async function connectWallet () {
  if (!window.ethereum) {
    notify('No wallet detected - install MetaMask or similar.', 'error');
    return;
  }

  try {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();

    if (Number(net.chainId) !== NETWORK.chainId) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: NETWORK.chainIdHex }],
        });
      } catch (e) {
        if (e.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: NETWORK.chainIdHex,
              chainName: NETWORK.label,
              nativeCurrency: { name: 'ETH', symbol: NETWORK.nativeSymbol, decimals: 18 },
              rpcUrls: [NETWORK.rpcUrl],
              blockExplorerUrls: [NETWORK.explorerBase],
            }],
          });
        } else {
          notify(`Please switch to ${NETWORK.label}.`, 'error');
          return;
        }
      }
      // Give mobile MetaMask time to settle after chain switch
      await new Promise(r => setTimeout(r, 500));
      provider = new ethers.BrowserProvider(window.ethereum);
    }

    // Small delay for mobile MetaMask to be ready
    await new Promise(r => setTimeout(r, 200));
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    if (
      NETWORK.NFT_ADDRESS === '0x0000000000000000000000000000000000000000' ||
      NETWORK.STAKING_ADDRESS === '0x0000000000000000000000000000000000000000'
    ) {
      notify('Contract addresses not set for this network - edit config.js', 'error');
      return;
    }

    nftContract     = new ethers.Contract(NETWORK.NFT_ADDRESS,     NFT_ABI,     signer);
    stakingContract = new ethers.Contract(NETWORK.STAKING_ADDRESS, STAKING_ABI, signer);

    document.querySelectorAll('#connectBtn, #connectBannerBtn, .connect-btn').forEach(b => {
      if (b.id === 'connectBtn' || b.id === 'connectBannerBtn' || b.classList.contains('js-connect')) {
        b.innerHTML = `<i class="fas fa-user-skull"></i> ${short(userAddress)}`;
        b.classList.add('connected');
      }
    });

    document.getElementById('connectBanner').style.display = 'none';
    document.getElementById('rewardsPanel').style.display  = 'block';
    document.getElementById('tabsNav').style.display       = 'flex';
    document.getElementById('panel-wallet').style.display  = 'block';
    const personal = document.getElementById('personalStats');
    if (personal) personal.style.display = 'grid';
    if (IS_TESTNET) {
      const demo = document.getElementById('demoRoyaltyCard');
      if (demo) demo.style.display = 'block';
    }

    notify(`✓ Connected to ${NETWORK.label}`, 'success');

    // ── Real-time event listeners ─────────────────────────────
    // Stake/Unstake need full refresh (tokens move between wallet ↔ staked).
    // RewardClaimed/RoyaltyReceived only touch numbers, skip heavy NFT scan.
    stakingContract.on('Staked',   (u) => u.toLowerCase() === userAddress.toLowerCase() && refreshEverything());
    stakingContract.on('Unstaked', (u) => u.toLowerCase() === userAddress.toLowerCase() && refreshEverything());
    stakingContract.on('RewardClaimed', (u) => {
      if (u.toLowerCase() === userAddress.toLowerCase()) {
        refreshStats();
        refreshRewards();
        refreshPublicStats();
      }
    });
    stakingContract.on('RoyaltyReceived', () => {
      refreshStats();
      refreshRewards();
      refreshPublicStats();
    });

    await refreshEverything();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshRewards, 30000);

    window.ethereum.on('accountsChanged', () => { stopUnlockCountdown(); window.location.reload(); });
    window.ethereum.on('chainChanged',    () => { stopUnlockCountdown(); window.location.reload(); });

  } catch (e) {
    console.error(e);
    // On mobile MetaMask, user rejection looks different — don't show error for that
    if (e.code === 4001 || e.code === 'ACTION_REJECTED') return;
    notify('Connection failed: ' + (e.shortMessage || e.message), 'error');
  }
}

// ─── REFRESHERS ───────────────────────────────────────────────
async function refreshEverything () {
  if (!userAddress) return;
  await Promise.all([
    refreshPublicStats(),
    refreshStats(),
    refreshRewards(),
    refreshWalletNFTs(),
    refreshStakedNFTs(),
    fetchEthPrice(),
  ]);
}

// Public stats — works without wallet
async function refreshPublicStats () {
  try {
    // Always use readProvider for public stats — BrowserProvider on mobile
    // MetaMask fails silently before the user has approved the connection
    const stakingRead = new ethers.Contract(NETWORK.STAKING_ADDRESS, STAKING_ABI, readProvider);

    const [total, received, distributed] = await Promise.all([
      stakingRead.totalStaked(),
      stakingRead.totalRewardsReceived(),
      stakingRead.totalRewardsDistributed(),
    ]);

    updateStat('totalStakedGlobal', Number(total).toLocaleString());

    const poolEth = parseFloat(ethers.formatEther(received - distributed));
    updateStat('totalRewardPool', poolEth.toFixed(4) + ' Ξ');

    // Total stakers — event queries need MetaMask, not Alchemy free tier
    try {
      const stakingEvents = new ethers.Contract(NETWORK.STAKING_ADDRESS, STAKING_ABI, logsProvider);
      const filter = stakingEvents.filters.Staked();
      const events = await stakingEvents.queryFilter(filter);
      const uniqueAddresses = [...new Set(events.map(e => e.args[0].toLowerCase()))];

      const balances = await Promise.all(
        uniqueAddresses.map(addr => stakingRead.stakedBalance(addr).catch(() => 0n))
      );

      const activeCount = balances.filter(b => BigInt(b) > 0n).length;
      updateStat('totalStakers', activeCount.toLocaleString());
    } catch (e) {
      const el = document.getElementById('totalStakers');
      if (el) el.textContent = '—';
    }
  } catch (e) {
    console.warn('[staking] refreshPublicStats failed:', e.message);
  }
}

// Personal stats — only after wallet connect
async function refreshStats () {
  try {
    const [bal, staked, total, earned] = await Promise.all([
      nftContract.balanceOf(userAddress),
      stakingContract.stakedBalance(userAddress),
      stakingContract.totalStaked(),
      stakingContract.earned(userAddress),
    ]);

    updateStat('nftsInWallet', bal.toString());
    updateStat('nftsStaked',   staked.toString());

    const tot = Number(total), mine = Number(staked);
    updateStat('poolShare',    tot > 0 ? ((mine / tot) * 100).toFixed(2) + '%' : '0%');
    updateStat('claimableEth', parseFloat(ethers.formatEther(earned)).toFixed(6));
  } catch (e) { console.error('refreshStats', e); }
}

async function refreshRewards () {
  if (!stakingContract || !userAddress) return;
  try {
    if (!ethPriceUsd) await fetchEthPrice();
    const [earned, poolTotal, poolDistrib] = await Promise.all([
      stakingContract.earned(userAddress),
      stakingContract.totalRewardsReceived(),
      stakingContract.totalRewardsDistributed(),
    ]);

    const eth   = parseFloat(ethers.formatEther(earned));
    const poolE = parseFloat(ethers.formatEther(poolTotal - poolDistrib));

    const prevRewards = _prevStatValues['_rewardsAmount'];
    const newRewards  = eth.toFixed(6) + ' ETH';

    // Update big rewards display (not a stat-card, handled separately)
    const rewardsAmountEl = document.getElementById('rewardsAmount');
    if (rewardsAmountEl) {
      rewardsAmountEl.textContent = newRewards;
      if (prevRewards !== undefined && prevRewards !== newRewards) {
        flashRewardsPanel();
      }
    }
    _prevStatValues['_rewardsAmount'] = newRewards;

    const rewardsUsdEl = document.getElementById('rewardsUsd');
    if (rewardsUsdEl) rewardsUsdEl.textContent = (eth * ethPriceUsd).toFixed(2);

    // claimableEth lives in a stat-card — use updateStat
    updateStat('claimableEth', eth.toFixed(6));

    const claimBtn = document.getElementById('claimBtn');
    if (claimBtn) claimBtn.disabled = eth <= 0;

    const poolEl = document.getElementById('poolBalance');
    if (poolEl) poolEl.textContent = poolE.toFixed(6) + ' ETH';

    // Per-user sales count: only royalty events since this user's first stake
    try {
      const [stakedEvents, royaltyEvents] = await Promise.all([
        stakingContract.queryFilter(stakingContract.filters.Staked(userAddress)),
        stakingContract.queryFilter(stakingContract.filters.RoyaltyReceived()),
      ]).catch(() => [[], []]);
      const salesCountEl = document.getElementById('rewardsSalesCount');
      const salesInfoEl  = document.getElementById('rewardsSalesInfo');
      if (stakedEvents.length > 0 && salesCountEl && salesInfoEl) {
        const firstStakeBlock = stakedEvents[0].blockNumber;
        const personalSales = royaltyEvents.filter(e => e.blockNumber >= firstStakeBlock).length;
        salesCountEl.textContent = personalSales.toLocaleString();
        salesInfoEl.style.display = personalSales > 0 ? 'inline' : 'none';
      }
    } catch (_) {}
  } catch (e) { console.error(e); }
}

async function fetchEthPrice () {
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD');
    const d = await r.json();
    ethPriceUsd = d.USD || 0;
  } catch (e) { ethPriceUsd = 0; }
}

// ─── NFT ENUMERATION ──────────────────────────────────────────
async function enumerateWalletNFTs() {
  if (!window.ALCHEMY_KEY) {
    await new Promise(r => setTimeout(r, 2000));
  }

  if (typeof window.ALCHEMY_KEY === 'string' && window.ALCHEMY_KEY.length > 0) {
    try {
      const all = [];
      let pageKey = null;
      let pageNum = 0;
      const MAX_PAGES = 100;

      do {
        const params = new URLSearchParams({
          owner: userAddress,
          'contractAddresses[]': NETWORK.NFT_ADDRESS,
          withMetadata: 'true',
          pageSize: '100',
        });
        if (pageKey) params.set('pageKey', pageKey);

        const url = `${NETWORK.alchemyHost}/nft/v3/${window.ALCHEMY_KEY}/getNFTsForOwner?${params}`;
        const r = await fetch(url);
        if (!r.ok) {
          console.warn(`[staking] Alchemy page ${pageNum + 1} HTTP ${r.status}`);
          break;
        }

        const d = await r.json();
        const page = (d.ownedNfts || []).map(n => ({
          id:    Number(n.tokenId),
          image: n.image?.cachedUrl || n.image?.originalUrl || n.image?.pngUrl || '',
        }));
        all.push(...page);
        pageKey = d.pageKey || null;
        pageNum++;
        console.info(`[staking] Alchemy page ${pageNum}: +${page.length} (total ${all.length})`);
      } while (pageKey && pageNum < MAX_PAGES);

      if (all.length > 0) return all;
      console.info('[staking] Alchemy returned 0 results — falling through to chain scan');
    } catch (e) {
      console.info('[staking] Alchemy unavailable — falling through:', e.message);
    }
  }

  if (!IS_TESTNET && window.OPENSEA_KEY) {
    try {
      const url = `${NETWORK.openseaApiHost}/api/v2/chain/${NETWORK.openseaChain}` +
        `/account/${userAddress}/nfts?collection=${NETWORK.collectionSlug}&limit=50`;
      const r = await fetch(url, { headers: { 'x-api-key': window.OPENSEA_KEY } });
      if (r.ok) {
        const d = await r.json();
        const arr = (d.nfts || []).map(n => ({
          id:    Number(n.identifier),
          image: n.image_url || n.display_image_url || '',
        }));
        if (arr.length > 0) return arr;
        console.info('[staking] OpenSea returned 0 results — falling through to chain scan');
      }
    } catch (e) {
      console.info('[staking] OpenSea unavailable — falling through:', e.message);
    }
  }

  return null;
}

function appendCard(grid, nft, mode, locked = false) {
  const tmp = document.createElement('div');
  tmp.innerHTML = renderCard(nft, mode, locked);
  const card = tmp.firstElementChild;
  card.addEventListener('click', () => toggleSelection(card, mode));
  grid.appendChild(card);
}

async function refreshWalletNFTs() {
  const grid = document.getElementById('walletGrid');
  const isFirstLoad = walletNFTs.length === 0;
  if (isFirstLoad) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin" style="font-size:28px"></i><p>Summoning your Undeads…</p></div>';
  }

  const prevSelected = new Set(selectedWallet);
  walletNFTs = [];
  selectedWallet.clear();
  updateActionBars();

  try {
    const bal = Number(await nftReadContract.balanceOf(userAddress));
    console.info(`[staking] On-chain balance for ${userAddress}: ${bal} (${NETWORK.NFT_ADDRESS})`);
    document.getElementById('cnt-wallet').textContent = bal;

    if (bal === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="skull">💀</div>
        <p>No Undeads in this wallet.
        ${IS_TESTNET ? '<br><small>Make sure you are on the right testnet wallet.</small>' : ''}
        </p></div>`;
      return;
    }

    const apiResult = await enumerateWalletNFTs();
    if (apiResult !== null && apiResult.length >= bal) {
      console.info(`[staking] API returned ${apiResult.length} matching tokens, using API path`);
      walletNFTs = apiResult;
      grid.innerHTML = walletNFTs.map(n => renderCard(n, 'wallet')).join('');
      grid.querySelectorAll('.stake-nft-card').forEach(el => {
        el.addEventListener('click', () => toggleSelection(el, 'wallet'));
        const id = Number(el.dataset.id);
        if (prevSelected.has(id) && walletNFTs.some(n => n.id === id)) {
          selectedWallet.add(id);
          el.classList.add('selected');
        }
      });
      updateActionBars();
      return;
    }

    if (apiResult !== null) {
      console.info(`[staking] API returned ${apiResult.length} but chain says ${bal} — falling through to on-chain scan`);
    }

    grid.innerHTML = '';

    let supportsEnumerable = false;
    try {
      await nftReadContract.tokenOfOwnerByIndex(userAddress, 0);
      supportsEnumerable = true;
    } catch (_) {}

    const BATCH = 50;

    if (supportsEnumerable) {
      for (let i = 0; i < bal; i += BATCH) {
        const size    = Math.min(BATCH, bal - i);
        const indices = Array.from({ length: size }, (_, k) => i + k);
        const results = await Promise.allSettled(
          indices.map(idx => nftReadContract.tokenOfOwnerByIndex(userAddress, idx))
        );
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const nft = { id: Number(r.value), image: '' };
          walletNFTs.push(nft);
          appendCard(grid, nft, 'wallet');
          fetchImageFromRenderer(nft.id).then(img => {
            if (!img) return;
            nft.image = img;
            const el = grid.querySelector(`.stake-nft-card[data-id="${nft.id}"] img`);
            if (el) el.src = img;
          });
        }
      }
    } else {
      console.info('Contract is not ERC721Enumerable — using ownerOf scan.');
      let totalSupply;
      try { totalSupply = Number(await nftReadContract.totalSupply()); }
      catch { totalSupply = 6666; }
      if (!totalSupply || totalSupply > 50000) totalSupply = 6666;

      const userLower = userAddress.toLowerCase();
      let foundCount = 0, scanned = 0;

      const progressEl = document.createElement('div');
      progressEl.className = 'empty-state';
      progressEl.style.gridColumn = '1/-1';
      progressEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="font-size:24px"></i>
        <p style="margin-top:14px">Scanning collection for your Undeads…<br>
        <small id="scanProgress" style="opacity:.7">0 / ${totalSupply}</small></p>`;
      grid.appendChild(progressEl);
      const updateProgress = () => {
        const sp = document.getElementById('scanProgress');
        if (sp) sp.textContent = `${scanned} / ${totalSupply}  ·  ${foundCount} found`;
      };

      console.info(`[staking] Starting ownerOf scan: 1..${totalSupply}, looking for ${userLower}`);
      let rejectedCount = 0, firstReject = null, firstSuccess = null;

      for (let i = 1; i <= totalSupply; i += BATCH) {
        const ids = [];
        for (let j = i; j < i + BATCH && j <= totalSupply; j++) ids.push(j);

        const results = await Promise.allSettled(
          ids.map(id => nftReadContract.ownerOf(id))
        );

        for (let k = 0; k < results.length; k++) {
          const r = results[k];
          scanned++;
          if (r.status !== 'fulfilled') {
            rejectedCount++;
            if (!firstReject) firstReject = { id: ids[k], reason: r.reason?.shortMessage || r.reason?.message || String(r.reason) };
            continue;
          }
          if (!firstSuccess) firstSuccess = { id: ids[k], owner: r.value };
          if (r.value.toLowerCase() !== userLower) continue;
          if (foundCount === 0) progressEl.remove();
          foundCount++;
          const nft = { id: ids[k], image: '' };
          walletNFTs.push(nft);
          appendCard(grid, nft, 'wallet');
          fetchImageFromRenderer(nft.id).then(img => {
            if (!img) return;
            nft.image = img;
            const el = grid.querySelector(`.stake-nft-card[data-id="${nft.id}"] img`);
            if (el) el.src = img;
          });
        }
        updateProgress();
        if (foundCount >= bal) break;
        if (i + BATCH <= totalSupply) await new Promise(r => setTimeout(r, 80));
      }

      if (progressEl.parentNode) progressEl.remove();
      console.info(`[staking] Scan complete: ${scanned} scanned · ${foundCount} owned · ${rejectedCount} rejected`);
      if (firstSuccess) console.info(`[staking] First success: token #${firstSuccess.id} → ${firstSuccess.owner}`);
      if (firstReject)  console.info(`[staking] First rejection: token #${firstReject.id} → ${firstReject.reason}`);
      if (foundCount === 0 && rejectedCount === scanned) {
        console.error(`[staking] ALL ${scanned} ownerOf calls failed — RPC is rate-limiting or unreachable`);
      } else if (foundCount === 0 && rejectedCount < scanned) {
        console.warn(`[staking] Scan succeeded but found 0 matches. Connected: ${userLower}. Sample owner: ${firstSuccess?.owner?.toLowerCase()}`);
      }
    }

    if (walletNFTs.length > 0) {
      document.getElementById('cnt-wallet').textContent = walletNFTs.length;
    }

    if (walletNFTs.length === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="skull">💀</div>
        <p>Scan came up empty, but the chain says you hold ${bal}.<br>
        <small style="opacity:.7">RPC failed. Make sure config.js uses an Alchemy URL, not the public Base RPC.</small></p></div>`;
    }

  } catch (e) {
    console.error('refreshWalletNFTs:', e);
    grid.innerHTML = `<div class="empty-state"><div class="skull">💀</div>
      <p>Error loading NFTs: ${e.message}</p></div>`;
  }
}

async function refreshStakedNFTs () {
  const grid = document.getElementById('stakedGrid');
  try {
    const ids = await stakingContract.getStakedTokens(userAddress);
    stakedNFTs = ids.map(x => ({ id: Number(x), image: '' }));
    document.getElementById('cnt-staked').textContent = stakedNFTs.length;

    const unlock = Number(await stakingContract.timeUntilUnstake(userAddress));

    if (stakedNFTs.length > 0 && unlock > 0) {
      unlockEndTime = Date.now() + (unlock * 1000);
      startUnlockCountdown();
    } else {
      unlockEndTime = 0;
      stopUnlockCountdown();
      const notice = document.getElementById('lockNotice');
      if (notice) {
        notice.innerHTML = stakedNFTs.length > 0
          ? `<div class="timer-display unlocked"><i class="fas fa-unlock"></i> Unlocked — unstake anytime</div>`
          : '';
      }
    }

    if (stakedNFTs.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="skull">☠</div><p>No NFTs staked yet. Choose some in the Wallet tab.</p></div>';
      return;
    }

    const CHUNK = 5;
    for (let i = 0; i < stakedNFTs.length; i += CHUNK) {
      await Promise.all(
        stakedNFTs.slice(i, i + CHUNK).map(async n => {
          try { n.image = await fetchImageFromRenderer(n.id); } catch (_) {}
        })
      );
      if (i + CHUNK < stakedNFTs.length) await new Promise(r => setTimeout(r, 60));
    }

    grid.innerHTML = stakedNFTs.map(n => renderCard(n, 'staked', unlock > 0)).join('');
    grid.querySelectorAll('.stake-nft-card').forEach(el => {
      el.addEventListener('click', () => {
        if (unlock > 0) { notify('⏳ 24 h lock still active', 'info'); return; }
        toggleSelection(el, 'staked');
      });
    });
  } catch (e) { console.warn('refreshStakedNFTs (contract not reachable):', e.code || e.message); }
}

function renderCard (nft, mode, locked = false) {
  const img = nft.image || `https://placehold.co/200x200/0a0505/a01818/png?text=%23${nft.id}`;
  return `
    <div class="stake-nft-card" data-id="${nft.id}" data-mode="${mode}">
      <img src="${img}" alt="#${nft.id}" loading="lazy"
           onerror="this.src='https://placehold.co/200x200/0a0505/a01818/png?text=%23${nft.id}'">
      ${locked ? '<div class="lock-badge"><i class="fas fa-lock"></i> LOCKED</div>' : ''}
      <div class="stake-nft-card-body">
        <div class="stake-nft-id">#${nft.id}</div>
        <div class="stake-nft-card-check"></div>
      </div>
    </div>`;
}

function toggleSelection (el, mode) {
  const id  = Number(el.dataset.id);
  const set = mode === 'wallet' ? selectedWallet : selectedStaked;
  if (set.has(id)) { set.delete(id); el.classList.remove('selected'); }
  else             { set.add(id);    el.classList.add('selected'); }
  updateActionBars();
}

function updateActionBars () {
  document.getElementById('walletSelectedCount').textContent = selectedWallet.size;
  document.getElementById('stakedSelectedCount').textContent = selectedStaked.size;
  const wTop  = document.getElementById('walletSelectedCountTop');
  const sTop  = document.getElementById('stakedSelectedCountTop');
  const wTotal = document.getElementById('walletTotalCount');
  const sTotal = document.getElementById('stakedTotalCount');
  if (wTop)   wTop.textContent   = selectedWallet.size;
  if (sTop)   sTop.textContent   = selectedStaked.size;
  if (wTotal) wTotal.textContent = walletNFTs.length;
  if (sTotal) sTotal.textContent = stakedNFTs.length;

  const showWalletBar = walletNFTs.length > 0;
  document.getElementById('walletActionBar').style.display = showWalletBar ? 'flex' : 'none';
  const wHeader = document.getElementById('walletActionHeader');
  if (wHeader) wHeader.style.display = showWalletBar ? 'flex' : 'none';

  const showStakedBar = stakedNFTs.length > 0;
  document.getElementById('stakedActionBar').style.display = showStakedBar ? 'flex' : 'none';
  const sHeader = document.getElementById('stakedActionHeader');
  if (sHeader) sHeader.style.display = showStakedBar ? 'flex' : 'none';

  const syncSelectAll = (allSelectedNow, allBtnIds, desBtnIds, hasItems) => {
    allBtnIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = (allSelectedNow || !hasItems) ? 'none' : 'inline-flex';
    });
    desBtnIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = (allSelectedNow ? 'inline-flex'
                                  : (selectedSetForId(id).size > 0 ? 'inline-flex' : 'none'));
    });
  };
  function selectedSetForId(id) {
    return id.includes('Wallet') ? selectedWallet : selectedStaked;
  }

  const walletAllSelected = selectedWallet.size === walletNFTs.length && walletNFTs.length > 0;
  syncSelectAll(walletAllSelected,
    ['selectAllWalletBtn', 'selectAllWalletBtnTop'],
    ['deselectAllWalletBtn', 'deselectAllWalletBtnTop'],
    walletNFTs.length > 0);

  const stakedAllSelected = selectedStaked.size === stakedNFTs.length && stakedNFTs.length > 0;
  syncSelectAll(stakedAllSelected,
    ['selectAllStakedBtn', 'selectAllStakedBtnTop'],
    ['deselectAllStakedBtn', 'deselectAllStakedBtnTop'],
    stakedNFTs.length > 0);

  const updateStakeBtn = (id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (selectedWallet.size === 0) {
      btn.innerHTML = `<i class="fas fa-bolt"></i> Stake Selected`;
      btn.disabled = true;
    } else {
      const willBatch = selectedWallet.size > MAX_BATCH_SIZE;
      const batches   = Math.ceil(selectedWallet.size / MAX_BATCH_SIZE);
      btn.innerHTML   = willBatch
        ? `<i class="fas fa-bolt"></i> Stake ${selectedWallet.size} (${batches} txs)`
        : `<i class="fas fa-bolt"></i> Stake ${selectedWallet.size}`;
      btn.disabled = false;
    }
  };
  updateStakeBtn('stakeSelectedBtn');
  updateStakeBtn('stakeSelectedBtnTop');

  const updateUnstakeBtn = (id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (selectedStaked.size === 0) {
      btn.innerHTML = `<i class="fas fa-sign-out-alt"></i> Unstake Selected`;
      btn.disabled = true;
    } else {
      const willBatch = selectedStaked.size > MAX_BATCH_SIZE;
      const batches   = Math.ceil(selectedStaked.size / MAX_BATCH_SIZE);
      btn.innerHTML   = willBatch
        ? `<i class="fas fa-sign-out-alt"></i> Unstake ${selectedStaked.size} (${batches} txs)`
        : `<i class="fas fa-sign-out-alt"></i> Unstake ${selectedStaked.size}`;
      btn.disabled = false;
    }
  };
  updateUnstakeBtn('unstakeSelectedBtn');
  updateUnstakeBtn('unstakeSelectedBtnTop');
}

// ─── ACTIONS: STAKE / UNSTAKE / CLAIM ─────────────────────────
async function doStake (ids) {
  if (!STAKING_ENABLED) { showPreLaunchModal(); return; }
  if (!ids.length) return;
  try {
    const approved = await nftContract.isApprovedForAll(userAddress, NETWORK.STAKING_ADDRESS);
    if (!approved) {
      notify('Approving staking contract…', 'info');
      const tx = await nftContract.setApprovalForAll(NETWORK.STAKING_ADDRESS, true);
      await tx.wait();
    }

    const totalBatches = Math.ceil(ids.length / MAX_BATCH_SIZE);
    let stakedSoFar = 0;

    for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
      const batch    = ids.slice(i, i + MAX_BATCH_SIZE);
      const batchNum = Math.floor(i / MAX_BATCH_SIZE) + 1;

      if (totalBatches > 1) notify(`Staking batch ${batchNum}/${totalBatches} (${batch.length} Undeads)…`, 'info');
      else                  notify(`Staking ${batch.length} Undead(s)…`, 'info');

      const tx = await stakingContract.stake(batch);
      await tx.wait();
      stakedSoFar += batch.length;

      if (totalBatches > 1) notify(`✓ Batch ${batchNum}/${totalBatches} confirmed (${stakedSoFar}/${ids.length} done)`, 'success');
    }

    notify(`✓ Staked ${ids.length} Undead(s) total`, 'success');
    selectedWallet.clear(); updateActionBars();
    await refreshEverything();
  } catch (e) {
    if (e.code === 'ACTION_REJECTED') return notify('Cancelled', 'info');
    notify('Stake failed: ' + (e.shortMessage || e.reason || e.message).slice(0, 160), 'error');
  }
}

async function doUnstake (ids) {
  if (!STAKING_ENABLED) { showPreLaunchModal(); return; }
  if (!ids.length) return;
  try {
    const totalBatches = Math.ceil(ids.length / MAX_BATCH_SIZE);
    let unstakedSoFar = 0;

    for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
      const batch    = ids.slice(i, i + MAX_BATCH_SIZE);
      const batchNum = Math.floor(i / MAX_BATCH_SIZE) + 1;

      if (totalBatches > 1) notify(`Unstaking batch ${batchNum}/${totalBatches} (${batch.length} Undeads)…`, 'info');
      else                  notify(`Unstaking ${batch.length}…`, 'info');

      const tx = await stakingContract.unstake(batch);
      await tx.wait();
      unstakedSoFar += batch.length;

      if (totalBatches > 1) notify(`✓ Batch ${batchNum}/${totalBatches} confirmed (${unstakedSoFar}/${ids.length} done)`, 'success');
    }

    notify(`✓ Unstaked ${ids.length} Undead(s) total`, 'success');
    selectedStaked.clear(); updateActionBars();
    await refreshEverything();
  } catch (e) {
    if (e.code === 'ACTION_REJECTED') return notify('Cancelled', 'info');
    notify('Unstake failed: ' + (e.shortMessage || e.reason || e.message).slice(0, 160), 'error');
  }
}

async function doClaim () {
  if (!STAKING_ENABLED) { showPreLaunchModal(); return; }
  try {
    notify('Claiming rewards…', 'info');
    const tx = await stakingContract.claim();
    await tx.wait();
    notify('✓ Rewards claimed', 'success');
    await refreshEverything();
  } catch (e) {
    if (e.code === 'ACTION_REJECTED') return notify('Cancelled', 'info');
    notify('Claim failed: ' + (e.shortMessage || e.reason || e.message).slice(0, 160), 'error');
  }
}

// ─── LEADERBOARD ─────────────────────────────────────────────
let _lbCache = null;          // { rows, ts } — avoid hammering RPC
let _lbFetching = false;

async function refreshLeaderboard(force = false) {
  const table  = document.getElementById('leaderboardTable');
  const btn    = document.getElementById('lbRefreshBtn');
  if (!table) return;

  // Throttle: re-use cache if fetched < 60 s ago and not forced
  if (!force && _lbCache && (Date.now() - _lbCache.ts) < 60_000) {
    renderLeaderboard(_lbCache.rows);
    return;
  }
  if (_lbFetching) return;
  _lbFetching = true;

  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }

  table.innerHTML = `<div class="lb-empty"><div class="lb-skull" style="font-size:28px;opacity:.5"><i class="fas fa-spinner fa-spin"></i></div><p style="margin-top:12px">Fetching staker data…</p></div>`;

  try {
    // Use MetaMask provider for event queries even without a connected account
    // — window.ethereum is injected on mobile MetaMask before connection
    // — readProvider (Alchemy free) blocks eth_getLogs beyond 10 blocks
    const stakingRead = new ethers.Contract(NETWORK.STAKING_ADDRESS, STAKING_ABI, logsProvider);

    // 1. Collect all unique addresses that ever staked
    let uniqueAddrs = [];
    try {
      const events = await stakingRead.queryFilter(stakingRead.filters.Staked());
      const seen = new Set();
      for (const e of events) {
        const addr = (e.args?.[0] || '').toLowerCase();
        if (addr && !seen.has(addr)) { seen.add(addr); uniqueAddrs.push(addr); }
      }
    } catch (e) {
      console.warn('[leaderboard] queryFilter failed:', e.message);
      table.innerHTML = `<div class="lb-empty"><div class="lb-skull">💀</div><p>Could not load event logs.<br><small style="opacity:.6">RPC may not support eth_getLogs.</small></p></div>`;
      return;
    }

    if (uniqueAddrs.length === 0) {
      table.innerHTML = `<div class="lb-empty"><div class="lb-skull">💀</div><p>No stakers yet — be the first!</p></div>`;
      return;
    }

    // 2. Batch-fetch stakedBalance for every address
    const CHUNK = 20;
    const balances = [];
    for (let i = 0; i < uniqueAddrs.length; i += CHUNK) {
      const slice = uniqueAddrs.slice(i, i + CHUNK);
      const results = await Promise.allSettled(
        slice.map(addr => stakingRead.stakedBalance(addr))
      );
      results.forEach((r, idx) => {
        balances.push({
          addr: slice[idx],
          staked: r.status === 'fulfilled' ? Number(r.value) : 0,
        });
      });
      if (i + CHUNK < uniqueAddrs.length) await new Promise(r => setTimeout(r, 50));
    }

    // 3. Filter out wallets that have unstaked everything, sort descending
    const active = balances
      .filter(b => b.staked > 0)
      .sort((a, b) => b.staked - a.staked);

    if (active.length === 0) {
      table.innerHTML = `<div class="lb-empty"><div class="lb-skull">💀</div><p>No active stakers right now.</p></div>`;
      _lbCache = { rows: active, ts: Date.now() };
      return;
    }

    // 4. Compute total staked for share %
    const total = active.reduce((s, b) => s + b.staked, 0);
    const rows  = active.map((b, i) => ({
      rank:   i + 1,
      addr:   b.addr,
      staked: b.staked,
      share:  total > 0 ? (b.staked / total) * 100 : 0,
    }));

    _lbCache = { rows, ts: Date.now() };
    renderLeaderboard(rows);

  } catch (e) {
    console.error('[leaderboard]', e);
    table.innerHTML = `<div class="lb-empty"><div class="lb-skull">💀</div><p>Error: ${e.message.slice(0, 120)}</p></div>`;
  } finally {
    _lbFetching = false;
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

function renderLeaderboard(rows) {
  const table   = document.getElementById('leaderboardTable');
  if (!table) return;

  const RANK_ICON = { 1: '👑', 2: '💀', 3: '☠' };
  const meAddr    = (userAddress || '').toLowerCase();
  const explorer  = (NETWORK.explorerBase || '').replace(/\/$/, '');

  const shortAddr = a => a.slice(0, 6) + '…' + a.slice(-4);

  const thead = `
    <div class="lb-thead">
      <span>#</span>
      <span>Wallet</span>
      <span>Staked</span>
      <span>Pool Share</span>
      <span>Share Bar</span>
    </div>`;

  const rowsHtml = rows.map((r, idx) => {
    const rankClass = r.rank <= 3 ? `rank-${r.rank}` : '';
    const icon      = RANK_ICON[r.rank] || r.rank;
    const isMe      = r.addr === meAddr;
    const addrLink  = explorer
      ? `<a href="${explorer}/address/${r.addr}" target="_blank" rel="noopener">${shortAddr(r.addr)}</a>`
      : shortAddr(r.addr);
    const youBadge  = isMe ? `<span class="you-badge">You</span>` : '';
    const barWidth  = Math.max(2, Math.min(100, r.share)).toFixed(1);

    return `
      <div class="lb-row animating" data-rank="${r.rank}" style="animation-delay:${idx * 40}ms">
        <div class="lb-rank ${rankClass}">${icon}</div>
        <div class="lb-addr">${addrLink}${youBadge}</div>
        <div class="lb-count ${r.rank === 1 ? 'top' : ''}">${r.staked.toLocaleString()}</div>
        <div class="lb-share">${r.share.toFixed(2)}%</div>
        <div class="lb-share-bar-wrap">
          <div class="lb-share-bar">
            <div class="lb-share-bar-fill" style="width:${barWidth}%"></div>
          </div>
        </div>
      </div>`;
  }).join('');

  table.innerHTML = thead + rowsHtml;

  // Remove animation class after it fires so hover styles work cleanly
  table.querySelectorAll('.lb-row.animating').forEach(el => {
    el.addEventListener('animationend', () => el.classList.remove('animating'), { once: true });
  });
}

// ─── DEMO ROYALTY (TESTNET ONLY) ──────────────────────────────
async function sendDemoRoyalty () {
  if (!IS_TESTNET) return;
  if (!signer) { notify('Connect wallet first.', 'error'); return; }
  try {
    const amt = NETWORK.demoRoyaltyEthAmount;
    notify(`Sending ${amt} ETH as simulated royalty…`, 'info');
    const tx = await signer.sendTransaction({
      to: NETWORK.STAKING_ADDRESS,
      value: ethers.parseEther(amt),
    });
    await tx.wait();
    notify(
      `✓ ${amt} ETH split 50/50 - check claimable above ` +
      `<a href="${NETWORK.explorerBase}/tx/${tx.hash}" target="_blank" style="color:#d9b856;text-decoration:underline">(view tx)</a>`,
      'success'
    );
    await refreshEverything();
  } catch (e) {
    if (e.code === 'ACTION_REJECTED') return notify('Cancelled', 'info');
    notify('Demo royalty failed: ' + (e.shortMessage || e.message).slice(0, 160), 'error');
  }
}

// ─── BOOT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  mountNetworkBadge();

  if (!STAKING_ENABLED) {
    const banner = document.getElementById('preLaunchBanner');
    if (banner) banner.style.display = 'block';
    document.body.classList.add('staking-locked');
    console.info('[staking] Pre-launch mode — staking actions disabled');
  }

  document.getElementById('prelaunchModalClose')?.addEventListener('click', hidePreLaunchModal);
  document.getElementById('prelaunchModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'prelaunchModal') hidePreLaunchModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePreLaunchModal(); });

  document.getElementById('lbRefreshBtn')     ?.addEventListener('click', () => refreshLeaderboard(true));
  document.getElementById('connectBtn')       ?.addEventListener('click', connectWallet);
  document.getElementById('stakeMoreBtn')     ?.addEventListener('click', () => {
    // Switch to the Wallet tab and scroll to it
    const walletTab = document.querySelector('.tab-btn[data-tab="wallet"]');
    if (walletTab) {
      walletTab.click();
      document.getElementById('tabsNav')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  document.getElementById('connectBannerBtn') ?.addEventListener('click', connectWallet);
  document.getElementById('claimBtn')         ?.addEventListener('click', doClaim);
  document.getElementById('demoRoyaltyBtn')   ?.addEventListener('click', sendDemoRoyalty);

  function bindMulti(ids, handler) {
    ids.forEach(id => document.getElementById(id)?.addEventListener('click', handler));
  }

  bindMulti(['selectAllWalletBtn', 'selectAllWalletBtnTop'], () => {
    selectedWallet.clear();
    walletNFTs.forEach(n => selectedWallet.add(n.id));
    document.querySelectorAll('#walletGrid .stake-nft-card').forEach(el => el.classList.add('selected'));
    updateActionBars();
  });
  bindMulti(['deselectAllWalletBtn', 'deselectAllWalletBtnTop'], () => {
    selectedWallet.clear();
    document.querySelectorAll('#walletGrid .stake-nft-card').forEach(el => el.classList.remove('selected'));
    updateActionBars();
  });
  bindMulti(['selectAllStakedBtn', 'selectAllStakedBtnTop'], () => {
    selectedStaked.clear();
    stakedNFTs.forEach(n => selectedStaked.add(n.id));
    document.querySelectorAll('#stakedGrid .stake-nft-card').forEach(el => el.classList.add('selected'));
    updateActionBars();
  });
  bindMulti(['deselectAllStakedBtn', 'deselectAllStakedBtnTop'], () => {
    selectedStaked.clear();
    document.querySelectorAll('#stakedGrid .stake-nft-card').forEach(el => el.classList.remove('selected'));
    updateActionBars();
  });

  bindMulti(['stakeSelectedBtn',   'stakeSelectedBtnTop'],   () => doStake([...selectedWallet]));
  bindMulti(['unstakeSelectedBtn', 'unstakeSelectedBtnTop'], () => doUnstake([...selectedStaked]));

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('panel-' + btn.dataset.tab).style.display = 'block';
    });
  });

  const mBtn  = document.getElementById('mobileMenuBtn');
  const links = document.querySelector('.nav-links');
  if (mBtn && links) {
    mBtn.addEventListener('click', () => {
      links.classList.toggle('mobile-open');
      mBtn.innerHTML = links.classList.contains('mobile-open')
        ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
    });
  }

  // Load public stats (staggered entrance of stat cards)
  setTimeout(() => refreshPublicStats(), 800);

  // Load leaderboard (slightly delayed so public stats render first)
  setTimeout(() => refreshLeaderboard(), 1800);

  // Refresh leaderboard every 2 minutes
  setInterval(() => refreshLeaderboard(), 120_000);

  setInterval(() => {
    if (!userAddress) refreshPublicStats();
  }, 30000);

  if (window.ethereum) {
    window.ethereum.request({ method: 'eth_accounts' }).then(a => {
      if (a.length) {
        // Delay on mobile so MetaMask finishes injecting before we connect
        setTimeout(connectWallet, 300);
      }
    }).catch(() => {});
  }
});