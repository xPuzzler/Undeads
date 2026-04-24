
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
// ── Renderer image fetch (testnet fallback — mirrors validator.html) ──────
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
    <strong>TESTNET MODE</strong> — ${NETWORK.label} ·
    you are testing with simulated royalties; mainnet activity will be live
  `;
  document.body.prepend(badge);
}

// ─── READ-ONLY PROVIDER (works even before wallet connects) ───
readProvider = new ethers.JsonRpcProvider(NETWORK.rpcUrl);
// Read-only contract for scanning — bypasses MetaMask rate limiter
let nftReadContract = new ethers.Contract(NETWORK.NFT_ADDRESS, NFT_ABI, readProvider);

// ─── WALLET CONNECT ───────────────────────────────────────────
async function connectWallet () {
  if (!window.ethereum) {
    notify('No wallet detected — install MetaMask or similar.', 'error');
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
      notify('Contract addresses not set for this network — edit config.js', 'error');
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

    window.ethereum.on('accountsChanged', () => window.location.reload());
    window.ethereum.on('chainChanged',    () => window.location.reload());

  } catch (e) {
    console.error(e);
    notify('Connection failed: ' + (e.shortMessage || e.message), 'error');
  }
}

// ─── REFRESHERS ───────────────────────────────────────────────
async function refreshEverything () {
  if (!userAddress) return;
  await Promise.all([
    refreshStats(),
    refreshRewards(),
    refreshWalletNFTs(),
    refreshStakedNFTs(),
    fetchEthPrice(),
  ]);
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
async function enumerateWalletNFTs() {
  // Priority 1: Alchemy
  if (typeof window.ALCHEMY_KEY === 'string' && window.ALCHEMY_KEY.length > 0) {
    try {
      const url = `${NETWORK.alchemyHost}/nft/v3/${window.ALCHEMY_KEY}/getNFTsForOwner` +
        `?owner=${userAddress}&contractAddresses[]=${NETWORK.NFT_ADDRESS}` +
        `&withMetadata=true&pageSize=100`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        return (d.ownedNfts || []).map(n => ({
          id:    Number(n.tokenId),
          image: n.image?.cachedUrl || n.image?.originalUrl || n.image?.pngUrl || '',
        }));
      }
    } catch (_) {}
  }

  // Priority 2: OpenSea (mainnet only — testnet API is shut down)
  if (!IS_TESTNET) {
    try {
      const url = `${NETWORK.openseaApiHost}/api/v2/chain/${NETWORK.openseaChain}` +
        `/account/${userAddress}/nfts?collection=${NETWORK.collectionSlug}&limit=50`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        return (d.nfts || []).map(n => ({
          id:    Number(n.identifier),
          image: n.image_url || n.display_image_url || '',
        }));
      }
    } catch (_) {}
  }

  // Signal to caller that progressive mode should be used
  return null;
}

// Helper — appends one card to grid and wires click handler
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
    // ── Path A: Alchemy or OpenSea returned results with images ─────────
    const apiResult = await enumerateWalletNFTs();
    if (apiResult !== null) {
      walletNFTs = apiResult;
      document.getElementById('cnt-wallet').textContent = walletNFTs.length;
      if (walletNFTs.length === 0) {
        grid.innerHTML = `<div class="empty-state"><div class="skull">💀</div><p>No Undeads in this wallet.</p></div>`;
        return;
      }
      grid.innerHTML = walletNFTs.map(n => renderCard(n, 'wallet')).join('');
      grid.querySelectorAll('.stake-nft-card').forEach(el =>
        el.addEventListener('click', () => toggleSelection(el, 'wallet')));
      return;
    }

    // ── No API key — read balance then pick the fastest scan method ──────
    const bal = Number(await nftReadContract.balanceOf(userAddress));
    document.getElementById('cnt-wallet').textContent = bal; // show correct count immediately

    if (bal === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="skull">💀</div>
        <p>No Undeads in this wallet.
        ${IS_TESTNET ? '<br><small>Make sure you are on the right testnet wallet.</small>' : ''}
        </p></div>`;
      return;
    }

    grid.innerHTML = ''; // clear spinner — cards stream in below

    // ── Probe: does this contract support ERC721Enumerable? ──────────────
    let supportsEnumerable = false;
    try {
      await nftReadContract.tokenOfOwnerByIndex(userAddress, 0);
      supportsEnumerable = true;
    } catch (_) {}

    const BATCH = 25; // parallel eth_calls per round

    if (supportsEnumerable) {
      // ── Path B: tokenOfOwnerByIndex — fast, no range limits ─────────
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
          // load image in background — update card src when ready
          fetchImageFromRenderer(nft.id).then(img => {
            if (!img) return;
            nft.image = img;
            const el = grid.querySelector(`.stake-nft-card[data-id="${nft.id}"] img`);
            if (el) el.src = img;
          });
        }
      }

    } else {
      // ── Path C: ownerOf scan bounded by totalSupply ───────────────────
      console.warn('Contract is not ERC721Enumerable — using ownerOf scan.');
      const supply = Number(
        await nftReadContract.totalSupply().catch(() => BigInt(6666))
      );

      for (let id = 1; id <= supply && walletNFTs.length < bal; id += BATCH) {
        const ids = [];
        for (let j = id; j < id + BATCH && j <= supply; j++) ids.push(j);

        const results = await Promise.allSettled(
          ids.map(i => nftReadContract.ownerOf(i))
        );

        for (let k = 0; k < results.length; k++) {
          const r = results[k];
          if (r.status !== 'fulfilled') continue;
          if (r.value.toLowerCase() !== userAddress.toLowerCase()) continue;
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
      }
    }

    // Final count update (Path C may have found fewer than bal if supply < 6666)
    document.getElementById('cnt-wallet').textContent = walletNFTs.length;

    if (walletNFTs.length === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="skull">💀</div>
        <p>No Undeads found. The contract may not expose token enumeration.<br>
        Add an Alchemy key in staking.html to guarantee detection.</p></div>`;
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
    const notice = document.getElementById('lockNotice');
    if (stakedNFTs.length > 0 && unlock > 0) {
      notice.innerHTML = `<div class="timer-display locked"><i class="fas fa-lock"></i> Unlocks in ${fmtDuration(unlock)}</div>`;
    } else if (stakedNFTs.length > 0) {
      notice.innerHTML = `<div class="timer-display unlocked"><i class="fas fa-unlock"></i> Unlocked — unstake anytime</div>`;
    } else {
      notice.innerHTML = '';
    }

    if (stakedNFTs.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="skull">☠</div><p>No NFTs staked yet. Choose some in the Wallet tab.</p></div>';
      return;
    }

    // Fetch staked NFT images — Alchemy if key present, renderer otherwise
    if (typeof window.ALCHEMY_KEY === 'string' && window.ALCHEMY_KEY.length > 0) {
      await Promise.all(stakedNFTs.map(async n => {
        try {
          const r = await fetch(`${NETWORK.alchemyHost}/nft/v3/${window.ALCHEMY_KEY}/getNFTMetadata` +
            `?contractAddress=${NETWORK.NFT_ADDRESS}&tokenId=${n.id}`);
          const d = await r.json();
          n.image = d.image?.cachedUrl || d.image?.originalUrl || '';
        } catch (_) {}
      }));
    } else {
      // Fallback: renderer contract (always works on testnet, no API key needed)
      const CHUNK = 6;
      for (let i = 0; i < stakedNFTs.length; i += CHUNK) {
        await Promise.all(
          stakedNFTs.slice(i, i + CHUNK).map(async n => {
            n.image = await fetchImageFromRenderer(n.id);
          })
        );
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
  document.getElementById('walletSelectedCount').textContent = selectedWallet.size;
  document.getElementById('stakedSelectedCount').textContent = selectedStaked.size;
  document.getElementById('walletActionBar').style.display = selectedWallet.size ? 'flex' : 'none';
  document.getElementById('stakedActionBar').style.display = selectedStaked.size ? 'flex' : 'none';
}

// ─── ACTIONS: STAKE / UNSTAKE / CLAIM ─────────────────────────
async function doStake (ids) {
  if (!ids.length) return;
  try {
    const approved = await nftContract.isApprovedForAll(userAddress, NETWORK.STAKING_ADDRESS);
    if (!approved) {
      notify('Approving staking contract…', 'info');
      const tx = await nftContract.setApprovalForAll(NETWORK.STAKING_ADDRESS, true);
      await tx.wait();
    }
    notify(`Staking ${ids.length} Undead(s)…`, 'info');
    const tx = await stakingContract.stake(ids);
    await tx.wait();
    notify(`✓ Staked ${ids.length} Undead(s)`, 'success');
    selectedWallet.clear(); updateActionBars();
    await refreshEverything();
  } catch (e) {
    if (e.code === 'ACTION_REJECTED') return notify('Cancelled', 'info');
    notify('Stake failed: ' + (e.shortMessage || e.reason || e.message).slice(0, 160), 'error');
  }
}

async function doUnstake (ids) {
  if (!ids.length) return;
  try {
    notify(`Unstaking ${ids.length}…`, 'info');
    const tx = await stakingContract.unstake(ids);
    await tx.wait();
    notify(`✓ Unstaked ${ids.length} Undead(s)`, 'success');
    selectedStaked.clear(); updateActionBars();
    await refreshEverything();
  } catch (e) {
    if (e.code === 'ACTION_REJECTED') return notify('Cancelled', 'info');
    notify('Unstake failed: ' + (e.shortMessage || e.reason || e.message).slice(0, 160), 'error');
  }
}

async function doClaim () {
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
// increase. Exactly how mainnet royalties will work — just
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
      `✓ ${amt} ETH split 50/50 — check claimable above ` +
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

  document.getElementById('connectBtn')       ?.addEventListener('click', connectWallet);
  document.getElementById('connectBannerBtn') ?.addEventListener('click', connectWallet);
  document.getElementById('claimBtn')         ?.addEventListener('click', doClaim);
  document.getElementById('stakeSelectedBtn') ?.addEventListener('click', () => doStake([...selectedWallet]));
  document.getElementById('stakeAllBtn')      ?.addEventListener('click', () => doStake(walletNFTs.map(n => n.id)));
  document.getElementById('unstakeSelectedBtn')?.addEventListener('click',() => doUnstake([...selectedStaked]));
  document.getElementById('unstakeAllBtn')    ?.addEventListener('click', () => doUnstake(stakedNFTs.map(n => n.id)));
  document.getElementById('demoRoyaltyBtn')   ?.addEventListener('click', sendDemoRoyalty);

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

  if (window.ethereum) {
    window.ethereum.request({ method: 'eth_accounts' }).then(a => {
      if (a.length) connectWallet();
    });
  }
});
