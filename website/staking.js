
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
// Read from config.js. When false: wallet/NFTs visible but
// stake/unstake/claim blocked with the "not yet live" modal.
const STAKING_ENABLED = !!(NETWORK && NETWORK.stakingEnabled);

// Maximum tokenIds per stake/unstake transaction. Higher batches
// risk gas spikes and indexer lag (OpenSea took ~1h to catch up
// after a 200+ batch). 50 is the sweet spot.
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
// Ticks every second on its own — doesn't need refresh cycles.
function startUnlockCountdown() {
  stopUnlockCountdown();
  tickUnlockCountdown(); // immediate first paint
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

  const remainingMs = unlockEndTime - Date.now();
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));

  if (remainingSec <= 0) {
    // Just unlocked — switch to the "Unlocked" badge and refresh state once
    notice.innerHTML = `<div class="timer-display unlocked"><i class="fas fa-unlock"></i> Unlocked — unstake anytime</div>`;
    stopUnlockCountdown();
    unlockEndTime = 0;
    // Re-fetch staked state so any per-card lock badges clear out
    if (stakingContract && userAddress) refreshStakedNFTs();
    return;
  }

  notice.innerHTML = `<div class="timer-display locked"><i class="fas fa-lock"></i> Unlocks in ${fmtDuration(remainingSec)}</div>`;
}
// ── Renderer image fetch (testnet fallback - mirrors validator.html) ──────
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

// ─── CURSOR + SCROLL (same as rest of site) ───────────────────
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

// ─── NETWORK BADGE (top of page shows TESTNET in big red letters) ─
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

// ─── READ-ONLY PROVIDER (works even before wallet connects) ───
// Initially uses the public Base RPC from config.js. The api-keys
// fetch in staking.html will swap this out for the Alchemy URL
// (which has the key) once it resolves.
readProvider = new ethers.JsonRpcProvider(NETWORK.rpcUrl);
let nftReadContract     = new ethers.Contract(NETWORK.NFT_ADDRESS,     NFT_ABI,     readProvider);
let stakingReadContract = new ethers.Contract(NETWORK.STAKING_ADDRESS, STAKING_ABI, readProvider);

// Upgrade the read provider once api-keys returns the Alchemy RPC URL.
// Called from staking.html. Safe to call multiple times — no-op if same URL.
window.upgradeReadProvider = function(rpcUrl) {
  if (!rpcUrl || rpcUrl === NETWORK.rpcUrl) return;
  console.info('[staking] Upgraded read provider to Alchemy RPC');
  readProvider = new ethers.JsonRpcProvider(rpcUrl);
  nftReadContract     = new ethers.Contract(NETWORK.NFT_ADDRESS,     NFT_ABI,     readProvider);
  stakingReadContract = new ethers.Contract(NETWORK.STAKING_ADDRESS, STAKING_ABI, readProvider);
  NETWORK.rpcUrl = rpcUrl;
  // Re-fetch public stats with the better RPC
  refreshPublicStats();
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
      provider = new ethers.BrowserProvider(window.ethereum);
    }

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

    // Update every connect button
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
    const personalStats = document.getElementById('personalStatsSection');
    if (personalStats) personalStats.style.display = 'block';
    if (IS_TESTNET) {
      const demo = document.getElementById('demoRoyaltyCard');
      if (demo) demo.style.display = 'block';
    }

    notify(`✓ Connected to ${NETWORK.label}`, 'success');

    // Attach live event listeners
    stakingContract.on('Staked',        (u) => u.toLowerCase() === userAddress.toLowerCase() && refreshEverything());
    stakingContract.on('Unstaked',      (u) => u.toLowerCase() === userAddress.toLowerCase() && refreshEverything());
    stakingContract.on('RewardClaimed', (u) => u.toLowerCase() === userAddress.toLowerCase() && refreshEverything());
    stakingContract.on('RoyaltyReceived', () => refreshEverything());

    await refreshEverything();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshRewards, 30000);

    window.ethereum.on('accountsChanged', () => {
      stopUnlockCountdown();
      window.location.reload();
    });
    window.ethereum.on('chainChanged', () => {
      stopUnlockCountdown();
      window.location.reload();
    });

  } catch (e) {
    console.error(e);
    notify('Connection failed: ' + (e.shortMessage || e.message), 'error');
  }
}

// ─── REFRESHERS ───────────────────────────────────────────────
async function refreshEverything () {
  if (!userAddress) return;
  await Promise.all([
    refreshPublicStats(),       // keep public stats live for connected user too
    refreshStats(),
    refreshRewards(),
    refreshWalletNFTs(),
    refreshStakedNFTs(),
    fetchEthPrice(),
  ]);
}

// ─── PUBLIC STATS — always visible, works without wallet connect ─
// Reads through the always-available stakingReadContract so anyone
// visiting the page sees live numbers.
async function refreshPublicStats () {
  // Safe textContent setter — silently no-ops if element doesn't exist.
  // Keeps the function from crashing if the HTML edit was incomplete.
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
    else console.warn(`[staking] Element #${id} not found in DOM`);
  };

  try {
    const [total, poolReceived, poolDistrib] = await Promise.all([
      stakingReadContract.totalStaked(),
      stakingReadContract.totalRewardsReceived(),
      stakingReadContract.totalRewardsDistributed(),
    ]);

    setText('totalStakedGlobal', Number(total).toLocaleString());

    // Reward pool = total received - total already distributed (un-claimed)
    const poolEth = parseFloat(ethers.formatEther(poolReceived - poolDistrib));
    setText('totalRewardPool', poolEth.toFixed(4) + ' Ξ');

    // Total stakers — chunked log query to dodge Alchemy free tier's
    // 10-block range limit AND public Base RPC's even stricter limits.
    // We grab all `Staked` events from contract deploy block to current,
    // 500 blocks at a time, then dedupe and check current balance.
    try {
      const STAKING_DEPLOY_BLOCK = 45258665;  // BasedUndeads staking deployment block on Base
      const CHUNK = 500;                       // safe under all tier limits

      const currentBlock = await readProvider.getBlockNumber();
      const filter = stakingReadContract.filters.Staked();
      const allEvents = [];

      // Run in parallel batches of 5 chunks at a time to avoid spamming
      const chunks = [];
      for (let from = STAKING_DEPLOY_BLOCK; from <= currentBlock; from += CHUNK) {
        const to = Math.min(from + CHUNK - 1, currentBlock);
        chunks.push({ from, to });
      }

      const PARALLEL = 5;
      for (let i = 0; i < chunks.length; i += PARALLEL) {
        const batch = chunks.slice(i, i + PARALLEL);
        const results = await Promise.all(
          batch.map(c =>
            stakingReadContract.queryFilter(filter, c.from, c.to).catch(() => [])
          )
        );
        results.forEach(r => allEvents.push(...r));
      }

      // Dedupe by address
      const uniqueAddresses = [...new Set(allEvents.map(e => e.args[0].toLowerCase()))];

      // Of those, count how many still have a positive staked balance
      const balances = await Promise.all(
        uniqueAddresses.map(addr =>
          stakingReadContract.stakedBalance(addr).catch(() => 0n)
        )
      );
      const activeCount = balances.filter(b => BigInt(b) > 0n).length;
      setText('totalStakers', activeCount.toLocaleString());

      // Cache result so we don't re-scan on every refresh
      window.__cachedStakerCount = { count: activeCount, scannedTo: currentBlock, ts: Date.now() };

    } catch (e) {
      console.warn('[staking] totalStakers fetch failed:', e.message);
      setText('totalStakers', '—');
    }

  } catch (e) {
    console.warn('[staking] refreshPublicStats failed:', e.message);
    setText('totalStakedGlobal', '—');
    setText('totalStakers', '—');
    setText('totalRewardPool', '—');
  }
}

async function refreshStats () {
  try {
    const [bal, staked, total, earned] = await Promise.all([
      nftContract.balanceOf(userAddress),
      stakingContract.stakedBalance(userAddress),
      stakingContract.totalStaked(),
      stakingContract.earned(userAddress),
    ]);
    const el = id => document.getElementById(id);
    el('nftsInWallet').textContent = bal.toString();
    el('nftsStaked').textContent = staked.toString();

    const tot = Number(total), mine = Number(staked);
    el('poolShare').textContent = tot > 0 ? ((mine / tot) * 100).toFixed(2) + '%' : '0%';
    el('claimableEth').textContent = parseFloat(ethers.formatEther(earned)).toFixed(6);
  } catch (e) { console.error('refreshStats', e); }
}

async function refreshRewards () {
  if (!stakingContract || !userAddress) return;
  try {
    const [earned, poolTotal, poolDistrib] = await Promise.all([
      stakingContract.earned(userAddress),
      stakingContract.totalRewardsReceived(),
      stakingContract.totalRewardsDistributed(),
    ]);
    const eth = parseFloat(ethers.formatEther(earned));
    const poolE = parseFloat(ethers.formatEther(poolTotal - poolDistrib));
    document.getElementById('rewardsAmount').textContent = eth.toFixed(6) + ' ETH';
    document.getElementById('rewardsUsd').textContent    = (eth * ethPriceUsd).toFixed(2);
    document.getElementById('claimableEth').textContent  = eth.toFixed(6);
    document.getElementById('claimBtn').disabled         = eth <= 0;
    const poolEl = document.getElementById('poolBalance');
    if (poolEl) poolEl.textContent = poolE.toFixed(6) + ' ETH';
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
// Returns array of {id, image} OR null if APIs aren't reliable.
// Caller is responsible for verifying against on-chain balance and
// falling back to bounded ownerOf scan if APIs are stale/missing.
async function enumerateWalletNFTs() {
  // Give the async Alchemy-key fetch up to 2s to resolve
  if (!window.ALCHEMY_KEY) {
    await new Promise(r => setTimeout(r, 2000));
  }

  // Priority 1: Alchemy (only if a key is actually set) — PAGINATES via pageKey
  if (typeof window.ALCHEMY_KEY === 'string' && window.ALCHEMY_KEY.length > 0) {
    try {
      const all = [];
      let pageKey = null;
      let pageNum = 0;
      const MAX_PAGES = 100; // safety cap (10,000 NFTs max)

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

  // Priority 2: OpenSea (only attempt with a real API key)
  if (!IS_TESTNET && window.OPENSEA_KEY) {
    try {
      const url = `${NETWORK.openseaApiHost}/api/v2/chain/${NETWORK.openseaChain}` +
        `/account/${userAddress}/nfts?collection=${NETWORK.collectionSlug}&limit=50`;
      const r = await fetch(url, {
        headers: { 'x-api-key': window.OPENSEA_KEY }
      });
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

  // Signal to caller that on-chain scan should be used
  return null;
}

// Helper - appends one card to grid and wires click handler
function appendCard(grid, nft, mode, locked = false) {
  const tmp = document.createElement('div');
  tmp.innerHTML = renderCard(nft, mode, locked);
  const card = tmp.firstElementChild;
  card.addEventListener('click', () => toggleSelection(card, mode));
  grid.appendChild(card);
}

async function refreshWalletNFTs() {
  const grid = document.getElementById('walletGrid');
  grid.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin" style="font-size:28px"></i><p>Summoning your Undeads…</p></div>';
  walletNFTs = [];
  selectedWallet.clear();
  updateActionBars();

  try {
    // ── ALWAYS read on-chain balance FIRST. This is the source of truth. ──
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

    // ── Path A: Try APIs but ONLY trust them if they match on-chain balance ──
    const apiResult = await enumerateWalletNFTs();
    if (apiResult !== null && apiResult.length >= bal) {
      // API has indexed the full set — use it (with images included, faster)
      console.info(`[staking] API returned ${apiResult.length} matching tokens, using API path`);
      walletNFTs = apiResult;
      grid.innerHTML = walletNFTs.map(n => renderCard(n, 'wallet')).join('');
      grid.querySelectorAll('.stake-nft-card').forEach(el =>
        el.addEventListener('click', () => toggleSelection(el, 'wallet')));
      return;
    }

    if (apiResult !== null) {
      console.info(`[staking] API returned ${apiResult.length} but chain says ${bal} — falling through to on-chain scan`);
    }

    grid.innerHTML = ''; // clear spinner - cards stream in below

    // ── Probe: does this contract support ERC721Enumerable? ──────────────
    let supportsEnumerable = false;
    try {
      await nftReadContract.tokenOfOwnerByIndex(userAddress, 0);
      supportsEnumerable = true;
    } catch (_) {}

    const BATCH = 50; // parallel eth_calls per round

    if (supportsEnumerable) {
      // ── Path B: tokenOfOwnerByIndex - fast, no range limits ─────────
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
      // ── Path C: Bounded ownerOf scan ─────────────────────────────────
      // The NFT contract is plain ERC721 (not Enumerable), and public RPCs
      // cap eth_getLogs to 10k blocks — so event scans don't work at scale.
      // Instead, scan ownerOf(1)..ownerOf(totalSupply) in parallel batches.
      // For a 6666-token collection this finishes in seconds.
      console.info('Contract is not ERC721Enumerable — using ownerOf scan.');

      let totalSupply;
      try {
        totalSupply = Number(await nftReadContract.totalSupply());
      } catch {
        totalSupply = 6666; // hardcoded ceiling matches MAX_SUPPLY in UndeadNFT.sol
      }
      if (!totalSupply || totalSupply > 50000) totalSupply = 6666; // sanity clamp

      const userLower = userAddress.toLowerCase();
      let foundCount = 0;
      let scanned = 0;

      // Show a live progress message while scanning
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
      let rejectedCount = 0;
      let firstReject = null;
      let firstSuccess = null;

      // Scan id=1..totalSupply in parallel batches
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

          // Hit — this user owns this token. Stream the card in.
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

        // Bail early if we've found everything (matches balanceOf)
        if (foundCount >= bal) break;

        // Tiny pacing between batches to keep public RPC happy
        if (i + BATCH <= totalSupply) {
          await new Promise(r => setTimeout(r, 80));
        }
      }

      // Clean up progress element if still present (e.g. balance was 0)
      if (progressEl.parentNode) progressEl.remove();

      // Diagnostic summary
      console.info(`[staking] Scan complete: ${scanned} scanned · ${foundCount} owned · ${rejectedCount} rejected (likely unminted)`);
      if (firstSuccess) console.info(`[staking] First success: token #${firstSuccess.id} → ${firstSuccess.owner}`);
      if (firstReject) console.info(`[staking] First rejection: token #${firstReject.id} → ${firstReject.reason}`);
      if (foundCount === 0 && rejectedCount === scanned) {
        console.error(`[staking] ALL ${scanned} ownerOf calls failed — RPC is rate-limiting or unreachable`);
      } else if (foundCount === 0 && rejectedCount < scanned) {
        console.warn(`[staking] Scan succeeded but found 0 matches. Connected: ${userLower}. Sample owner: ${firstSuccess?.owner?.toLowerCase()}`);
      }
    }

    // Final count update — ONLY overwrite if scan actually found tokens.
    // Otherwise the on-chain balanceOf shown earlier is the source of truth.
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

    // Capture the absolute unlock time so the live ticker can tick down
    // independently of refresh cycles
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

    // Fetch staked NFT images. Strategy:
    //   1. Render cards immediately with placeholder
    //   2. Stream real images in via the onchain renderer (always free,
    //      always works, no rate limits). 5 parallel requests at a time
    //      to avoid overwhelming the RPC.
    // We don't use Alchemy here because it gets rate-limited (429) on
    // wallets with many staked tokens. The renderer is faster anyway
    // since it's just direct chain calls through our existing provider.
    const CHUNK = 5;
    for (let i = 0; i < stakedNFTs.length; i += CHUNK) {
      await Promise.all(
        stakedNFTs.slice(i, i + CHUNK).map(async n => {
          try {
            n.image = await fetchImageFromRenderer(n.id);
          } catch (_) {}
        })
      );
      // Tiny pause between chunks to keep RPC happy
      if (i + CHUNK < stakedNFTs.length) {
        await new Promise(r => setTimeout(r, 60));
      }
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
  const id = Number(el.dataset.id);
  const set = mode === 'wallet' ? selectedWallet : selectedStaked;
  if (set.has(id)) { set.delete(id); el.classList.remove('selected'); }
  else              { set.add(id);    el.classList.add('selected'); }
  updateActionBars();
}

function updateActionBars () {
  // ── Update count displays (both top and bottom)
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

  // ── Wallet bars: visible whenever there are NFTs to stake
  const showWalletBar = walletNFTs.length > 0;
  document.getElementById('walletActionBar').style.display = showWalletBar ? 'flex' : 'none';
  const wHeader = document.getElementById('walletActionHeader');
  if (wHeader) wHeader.style.display = showWalletBar ? 'flex' : 'none';

  // ── Staked bars: visible whenever there are staked NFTs
  const showStakedBar = stakedNFTs.length > 0;
  document.getElementById('stakedActionBar').style.display = showStakedBar ? 'flex' : 'none';
  const sHeader = document.getElementById('stakedActionHeader');
  if (sHeader) sHeader.style.display = showStakedBar ? 'flex' : 'none';

  // ── Helper: sync Select All / Deselect All visibility for a pair (top + bottom)
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

  // helper to figure out which selection set a deselect-all button refers to
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

  // ── Stake button labels (both top and bottom)
  const updateStakeBtn = (id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (selectedWallet.size === 0) {
      btn.innerHTML = `<i class="fas fa-bolt"></i> Stake Selected`;
      btn.disabled = true;
    } else {
      const willBatch = selectedWallet.size > MAX_BATCH_SIZE;
      const batches = Math.ceil(selectedWallet.size / MAX_BATCH_SIZE);
      btn.innerHTML = willBatch
        ? `<i class="fas fa-bolt"></i> Stake ${selectedWallet.size} (${batches} txs)`
        : `<i class="fas fa-bolt"></i> Stake ${selectedWallet.size}`;
      btn.disabled = false;
    }
  };
  updateStakeBtn('stakeSelectedBtn');
  updateStakeBtn('stakeSelectedBtnTop');

  // ── Unstake button labels (both top and bottom)
  const updateUnstakeBtn = (id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (selectedStaked.size === 0) {
      btn.innerHTML = `<i class="fas fa-sign-out-alt"></i> Unstake Selected`;
      btn.disabled = true;
    } else {
      const willBatch = selectedStaked.size > MAX_BATCH_SIZE;
      const batches = Math.ceil(selectedStaked.size / MAX_BATCH_SIZE);
      btn.innerHTML = willBatch
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

    // Chunk into batches of MAX_BATCH_SIZE to avoid gas spikes and indexer lag
    const totalBatches = Math.ceil(ids.length / MAX_BATCH_SIZE);
    let stakedSoFar = 0;

    for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
      const batch = ids.slice(i, i + MAX_BATCH_SIZE);
      const batchNum = Math.floor(i / MAX_BATCH_SIZE) + 1;

      if (totalBatches > 1) {
        notify(`Staking batch ${batchNum}/${totalBatches} (${batch.length} Undeads)…`, 'info');
      } else {
        notify(`Staking ${batch.length} Undead(s)…`, 'info');
      }

      const tx = await stakingContract.stake(batch);
      await tx.wait();
      stakedSoFar += batch.length;

      if (totalBatches > 1) {
        notify(`✓ Batch ${batchNum}/${totalBatches} confirmed (${stakedSoFar}/${ids.length} done)`, 'success');
      }
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
      const batch = ids.slice(i, i + MAX_BATCH_SIZE);
      const batchNum = Math.floor(i / MAX_BATCH_SIZE) + 1;

      if (totalBatches > 1) {
        notify(`Unstaking batch ${batchNum}/${totalBatches} (${batch.length} Undeads)…`, 'info');
      } else {
        notify(`Unstaking ${batch.length}…`, 'info');
      }

      const tx = await stakingContract.unstake(batch);
      await tx.wait();
      unstakedSoFar += batch.length;

      if (totalBatches > 1) {
        notify(`✓ Batch ${batchNum}/${totalBatches} confirmed (${unstakedSoFar}/${ids.length} done)`, 'success');
      }
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

// ─── DEMO ROYALTY (TESTNET ONLY) ──────────────────────────────
// Sends a tiny amount of ETH to the staking contract. The
// contract's receive() does the 50/50 split automatically, so
// rewardPerTokenStored rises and all stakers see their earned()
// increase. Exactly how mainnet royalties will work - just
// triggered manually here instead of by OpenSea.
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

  // ─── Pre-launch UI: banner + dim buttons + modal close handlers ───
  if (!STAKING_ENABLED) {
    const banner = document.getElementById('preLaunchBanner');
    if (banner) banner.style.display = 'block';
    document.body.classList.add('staking-locked');
    console.info('[staking] Pre-launch mode — staking actions disabled');
  }

  // Modal close handlers (work regardless of pre-launch state)
  document.getElementById('prelaunchModalClose')?.addEventListener('click', hidePreLaunchModal);
  document.getElementById('prelaunchModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'prelaunchModal') hidePreLaunchModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePreLaunchModal();
  });

  document.getElementById('connectBtn')       ?.addEventListener('click', connectWallet);
  document.getElementById('connectBannerBtn') ?.addEventListener('click', connectWallet);
  document.getElementById('claimBtn')         ?.addEventListener('click', doClaim);
  document.getElementById('demoRoyaltyBtn')   ?.addEventListener('click', sendDemoRoyalty);

  // ── Helper: bind a click handler to multiple element IDs (top + bottom buttons)
  function bindMulti(ids, handler) {
    ids.forEach(id => document.getElementById(id)?.addEventListener('click', handler));
  }

  // Select All — Wallet (top + bottom)
  bindMulti(['selectAllWalletBtn', 'selectAllWalletBtnTop'], () => {
    selectedWallet.clear();
    walletNFTs.forEach(n => selectedWallet.add(n.id));
    document.querySelectorAll('#walletGrid .stake-nft-card').forEach(el => el.classList.add('selected'));
    updateActionBars();
  });

  // Deselect All — Wallet (top + bottom)
  bindMulti(['deselectAllWalletBtn', 'deselectAllWalletBtnTop'], () => {
    selectedWallet.clear();
    document.querySelectorAll('#walletGrid .stake-nft-card').forEach(el => el.classList.remove('selected'));
    updateActionBars();
  });

  // Select All — Staked (top + bottom)
  bindMulti(['selectAllStakedBtn', 'selectAllStakedBtnTop'], () => {
    selectedStaked.clear();
    stakedNFTs.forEach(n => selectedStaked.add(n.id));
    document.querySelectorAll('#stakedGrid .stake-nft-card').forEach(el => el.classList.add('selected'));
    updateActionBars();
  });

  // Deselect All — Staked (top + bottom)
  bindMulti(['deselectAllStakedBtn', 'deselectAllStakedBtnTop'], () => {
    selectedStaked.clear();
    document.querySelectorAll('#stakedGrid .stake-nft-card').forEach(el => el.classList.remove('selected'));
    updateActionBars();
  });

  // Stake / Unstake — wire BOTH top and bottom buttons
  bindMulti(['stakeSelectedBtn', 'stakeSelectedBtnTop'], () => doStake([...selectedWallet]));
  bindMulti(['unstakeSelectedBtn', 'unstakeSelectedBtnTop'], () => doUnstake([...selectedStaked]));

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('panel-' + btn.dataset.tab).style.display = 'block';
    });
  });

  const mBtn = document.getElementById('mobileMenuBtn');
  const links = document.querySelector('.nav-links');
  if (mBtn && links) {
    mBtn.addEventListener('click', () => {
      links.classList.toggle('mobile-open');
      mBtn.innerHTML = links.classList.contains('mobile-open')
        ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
    });
  }

  // ── PUBLIC STATS — load immediately, no wallet required
  // Wait briefly for the api-keys fetch to upgrade the RPC, then load.
  // (If it doesn't upgrade in time, public Base RPC will work too.)
  setTimeout(() => refreshPublicStats(), 500);

  // Refresh public stats every 30 seconds so the page stays "live"
  setInterval(() => refreshPublicStats(), 30000);

  if (window.ethereum) {
    window.ethereum.request({ method: 'eth_accounts' }).then(a => {
      if (a.length) connectWallet();
    });
  }
});
