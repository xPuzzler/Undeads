// js/page-staking.js, BU Stake page
const SELECTED_OWNED  = new Set();
const SELECTED_STAKED = new Set();
let USER_STATE = null, POOL_STATS = null, IS_APPROVED = false;
let _timers = [];
let _gridsKey = '';         // last rendered owned|staked fingerprint
let _gridScanRunning = false; // concurrency guard

// Run-once flag so the early hydrate doesn't re-render after initLBAndActivity()
// has already populated things from a fresh fetch.
let _quickHydrated = false;

// Render leaderboard + activity from localStorage as soon as the DOM is
// fully parsed. This fires BEFORE the slow awaits in stakePage() complete
// (and well before initLBAndActivity()), so the user sees the previous scan
// within a single frame of the page load instead of seeing "Loading..."
// placeholders for 1-2 seconds.
//
// Why DOMContentLoaded rather than queueMicrotask: the activity renderer
// (window.renderActivityFeed) is defined by a <script> tag that appears
// AFTER page-staking.js in staking.html. The microtask checkpoint after
// page-staking.js fires before that later script tag parses, so a microtask
// would see renderActivityFeed === undefined. DOMContentLoaded fires after
// every script tag has parsed.
function _quickHydrate() {
  if (_quickHydrated) return;
  _quickHydrated = true;
  // Leaderboard.
  try {
    const stored = _lbLsLoad();
    if (stored && Array.isArray(stored.rows) && stored.rows.length > 0
        && typeof _renderLeaderboard === 'function') {
      _lbCache = { rows: stored.rows, ts: Number(stored.ts) || 0 };
      _renderLeaderboard(stored.rows);
    }
  } catch {}
  // Activity. data.js exposes the hydration helper via BUData; if absent we
  // wait for the regular initActivity() call to take care of it.
  try {
    if (window.BUData?.hydrateActivityFromStorage) {
      window.BUData.hydrateActivityFromStorage();
    }
    if (typeof window.renderActivityFeed === 'function') {
      window.renderActivityFeed();
    }
  } catch {}
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _quickHydrate, { once: true });
} else {
  // Document already parsed (scripts at end of body); run on next tick so the
  // inline <script> below page-staking.js has finished defining renderActivityFeed.
  setTimeout(_quickHydrate, 0);
}

(async function stakePage() {
  if (typeof ethers === "undefined") { console.error("ethers failed to load"); return; }
  window.BUUI.renderNetworkPill(); window.BUUI.renderNavSocials(); window.BUUI.bindMobileNav(); window.BUUI.renderFooterAddresses();
  try { await window.BU.loadABIs(); } catch {}
  await window.BU.upgradeProviderFromKeys(); await window.BU.tryEagerConnect(); window.BUUI.renderWalletSlot();
  if (!window.BU.configIsLive()) { showOfflineUI(); return; }
  await refreshPublicStats(); _timers.push(setInterval(refreshPublicStats, window.BU_CONFIG.refreshIntervals.stats));
  await renderUserPanel(); _timers.push(setInterval(renderUserPanel, window.BU_CONFIG.refreshIntervals.userPanel));
  _timers.push(setInterval(tickLock, window.BU_CONFIG.refreshIntervals.lockTick));
  initLBAndActivity();
  window.BU.onAccountChange(() => {
  window.BUUI.renderWalletSlot();
  SELECTED_OWNED.clear(); SELECTED_STAKED.clear(); _gridsKey = '';
  if (window.BUData.clearOwnedCache) window.BUData.clearOwnedCache();
  renderUserPanel();
});
})();

function showOfflineUI() {
  const el=document.getElementById("stake-offline"); if(el) el.style.display="block";
  const c=document.getElementById("stake-content"); if(c) c.style.display="none";
}

async function refreshPublicStats() {
  try {
    POOL_STATS = await window.BUData.getPoolStats();
    setText("ps-total-staked", window.BUUI.fmtNumber(POOL_STATS.totalStaked));
    setText("ps-pool",         window.BUUI.fmtETH(POOL_STATS.unclaimedPool)+" ETH");
    setText("ps-lifetime",     window.BUUI.fmtETH(POOL_STATS.totalReceived)+" ETH");
    setText("ps-distributed",  window.BUUI.fmtETH(POOL_STATS.totalDistributed)+" ETH");
  } catch(e) { console.warn("[stake] pool stats failed",e.message); }
}

async function renderUserPanel() {
  const wrap=document.getElementById("user-panel"), prompt=document.getElementById("connect-prompt");
  if (!window.BU.isConnected()) {
    if(wrap) wrap.style.display="none"; if(prompt) prompt.style.display="block"; return;
  }
  if(prompt) prompt.style.display="none"; if(wrap) wrap.style.display="block";
  const addr=window.BU.getUserAddress();
  try { USER_STATE=await window.BUData.getUserState(addr); IS_APPROVED=await window.BUData.isStakingApproved(addr); }
  catch(e) { console.warn("[stake] user state failed",e.message); return; }
  const share=window.BUData.calcPoolShare(USER_STATE.stakedBalance, POOL_STATS?.totalStaked||0);
  setText("us-balance", window.BUUI.fmtNumber(USER_STATE.nftBalance));
  setText("us-staked",  window.BUUI.fmtNumber(USER_STATE.stakedBalance));
  setText("us-share",   share.toFixed(2)+"%");
  setText("us-earned",  window.BUUI.fmtETH(USER_STATE.earnedWei,6)+" ETH");
  setText("us-lock",    USER_STATE.timeUntilUnstake>0?window.BUUI.fmtTime(USER_STATE.timeUntilUnstake):"Ready");
  const claimBtn=document.getElementById("us-claim-btn");
  if (claimBtn) {
    const has=USER_STATE.earnedWei>0n; claimBtn.disabled=!has;
    claimBtn.onclick=async()=>{ claimBtn.disabled=true; try { await window.BUUI.trackTx("Claim Rewards",window.BUData.claimRewards()); await renderUserPanel(); await refreshPublicStats(); } catch{} finally{claimBtn.disabled=false;} };
  }
  renderLockBanner(); await renderStakeGrids();
}

function renderLockBanner() {
  const banner=document.getElementById("lock-banner"); if(!banner) return;
  if (!USER_STATE||USER_STATE.stakedBalance===0) { banner.style.display="none"; return; }
  banner.style.display="flex";
  const lockSecs=window.BU_CONFIG.collection.cooldownHours*3600, remaining=USER_STATE.timeUntilUnstake;
  const elapsed=Math.max(0,lockSecs-remaining), pct=Math.min(100,(elapsed/lockSecs)*100);
  banner.classList.toggle("ready",remaining===0); banner.dataset.remaining=remaining;
  banner.innerHTML=`<span class="lb-label">${remaining===0?"Unlocked":"Lock Active"}</span><span class="lb-timer">${window.BUUI.fmtTime(remaining)}</span><div class="lb-body">${remaining===0?"Your stake is fully unlocked. You can unstake any or all tokens now.":"Adding tokens resets this 24-hour lock. After the lock ends you can unstake freely."}<div class="lb-bar"><div class="lb-bar-fill" style="width:${pct}%"></div></div></div>`;
}

function tickLock() {
  if (!USER_STATE||USER_STATE.timeUntilUnstake===0) return;
  USER_STATE.timeUntilUnstake=Math.max(0,USER_STATE.timeUntilUnstake-1);
  renderLockBanner(); setText("us-lock",USER_STATE.timeUntilUnstake>0?window.BUUI.fmtTime(USER_STATE.timeUntilUnstake):"Ready");
  updateStakeActionButtons();
}

async function renderStakeGrids() {
  if (_gridScanRunning) return; // prevent overlapping scans
  _gridScanRunning = true;
  try {
    const ownedGrid=document.getElementById("owned-grid"), stakedGrid=document.getElementById("staked-grid");
    if (!ownedGrid||!stakedGrid) return;
    const addr=window.BU.getUserAddress();
    const isFirst = _gridsKey === '';
    if (isFirst) {
      ownedGrid.innerHTML=`<div class="loading">Reading the registry</div>`;
      stakedGrid.innerHTML=`<div class="loading">Reading the registry</div>`;
    }
    let owned=[];
    try { owned=await window.BUData.getUserOwnedTokens(addr); } catch(e) { console.warn("[stake] owned scan failed",e.message); }
    const stakedIds=USER_STATE?.stakedTokenIds||[];
    const newKey=owned.join(',')+'|'+stakedIds.join(',');
    if (!isFirst && newKey===_gridsKey) { updateStakeActionButtons(); return; }
    _gridsKey=newKey;
    ownedGrid.innerHTML="";
    if (owned.length===0) { ownedGrid.innerHTML=`<div class="empty">Nothing in this wallet.</div>`; }
    else { for (const id of owned) { const node=window.BUImages.card(id,{state:"idle",selectable:true,onSelect:(tid,sel)=>{sel?SELECTED_OWNED.add(tid):SELECTED_OWNED.delete(tid);updateStakeActionButtons();}}); if(SELECTED_OWNED.has(id)) node.classList.add("selected"); ownedGrid.appendChild(node); } }
    stakedGrid.innerHTML="";
    if (stakedIds.length===0) { stakedGrid.innerHTML=`<div class="empty">Nothing perched yet. Stake to earn.</div>`; }
    else { for (const id of stakedIds) { const node=window.BUImages.card(id,{state:"staked",selectable:true,onSelect:(tid,sel)=>{sel?SELECTED_STAKED.add(tid):SELECTED_STAKED.delete(tid);updateStakeActionButtons();}}); if(SELECTED_STAKED.has(id)) node.classList.add("selected"); stakedGrid.appendChild(node); } }
    setText("owned-count",  `(${owned.length})`);
    setText("staked-count", `(${stakedIds.length})`);
    updateStakeActionButtons();
  } finally { _gridScanRunning = false; }
}

function updateStakeActionButtons() {
  const stakeBtn=document.getElementById("stake-selected-btn"), stakeAll=document.getElementById("stake-all-btn");
  const unstakeBtn=document.getElementById("unstake-selected-btn"), unstakeAll=document.getElementById("unstake-all-btn");
  const stakingEnabled=window.BU_CONFIG.stakingEnabled, needsApproval=!IS_APPROVED;
  if (stakeBtn) { const n=SELECTED_OWNED.size; if(!stakingEnabled){stakeBtn.disabled=true;stakeBtn.textContent="Staking soon";} else if(needsApproval){stakeBtn.disabled=n===0;stakeBtn.textContent=n>0?`Approve & Stake ${n}`:"Stake Selected";} else{stakeBtn.disabled=n===0;stakeBtn.textContent=n>0?`Stake ${n}`:"Stake Selected";} }
  if (stakeAll) { const ownedCount=document.getElementById("owned-grid")?.querySelectorAll(".nft-card").length||0; stakeAll.disabled=!stakingEnabled||ownedCount===0; stakeAll.textContent=needsApproval&&ownedCount>0?`Approve & Stake All`:`Stake All`; }
  const lockRemaining=USER_STATE?.timeUntilUnstake||0;
  if (unstakeBtn) { const n=SELECTED_STAKED.size; if(lockRemaining>0){unstakeBtn.disabled=true;unstakeBtn.textContent=`Locked · ${window.BUUI.fmtTime(lockRemaining)}`;} else{unstakeBtn.disabled=n===0;unstakeBtn.textContent=n>0?`Unstake ${n}`:"Unstake Selected";} }
  if (unstakeAll) { const stakedCount=document.getElementById("staked-grid")?.querySelectorAll(".nft-card").length||0; unstakeAll.disabled=lockRemaining>0||stakedCount===0; unstakeAll.textContent=lockRemaining>0?`Locked · ${window.BUUI.fmtTime(lockRemaining)}`:"Unstake All"; }
}

function bindStakeActions() {
  document.getElementById("stake-selected-btn")?.addEventListener("click", ()=>doStake([...SELECTED_OWNED]));
  document.getElementById("stake-all-btn")?.addEventListener("click", ()=>{ const grid=document.getElementById("owned-grid"); const ids=[...grid.querySelectorAll(".nft-card")].map(n=>Number(n.dataset.tokenId)).filter(Boolean); doStake(ids); });
  document.getElementById("unstake-selected-btn")?.addEventListener("click", ()=>doUnstake([...SELECTED_STAKED]));
  document.getElementById("unstake-all-btn")?.addEventListener("click", ()=>{ const grid=document.getElementById("staked-grid"); const ids=[...grid.querySelectorAll(".nft-card")].map(n=>Number(n.dataset.tokenId)).filter(Boolean); doUnstake(ids); });
}
async function doStake(ids) {
  if (!ids||ids.length===0) return;
  try { if(!IS_APPROVED){await window.BUUI.trackTx("Approve Staking",window.BUData.approveStaking());IS_APPROVED=true;} await window.BUUI.trackTx(`Stake ${ids.length}`,window.BUData.stakeTokens(ids)); SELECTED_OWNED.clear(); await renderUserPanel(); } catch {}
}
async function doUnstake(ids) {
  if (!ids||ids.length===0) return;
  try { await window.BUUI.trackTx(`Unstake ${ids.length}`,window.BUData.unstakeTokens(ids)); SELECTED_STAKED.clear(); await renderUserPanel(); } catch {}
}
bindStakeActions();

// ─── Leaderboard + Activity ──────────────────────────────────────────────
let _lbCache = null, _lbFetching = false;
const LB_LS_KEY        = 'bu_lb_cache_v1';
const LB_REFRESH_MS    = 3_600_000;   // 1 hour between auto-refreshes
const LB_RENDER_TTL_MS = 60_000;      // re-use in-memory cache for this long

function _lbLsLoad() {
  try { const v = localStorage.getItem(LB_LS_KEY); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
function _lbLsSave(cache) {
  try { localStorage.setItem(LB_LS_KEY, JSON.stringify(cache)); }
  catch { /* quota / private mode → ignore */ }
}

async function initLBAndActivity() {
  // Hydrate leaderboard from localStorage so the table renders instantly
  // on reload while the fresh scan runs in the background.
  const stored = _lbLsLoad();
  if (stored && Array.isArray(stored.rows) && stored.rows.length > 0) {
    _lbCache = { rows: stored.rows, ts: Number(stored.ts) || 0 };
    _renderLeaderboard(stored.rows);
  }

  setTimeout(() => refreshLeaderboard(), 800);
  _timers.push(setInterval(() => refreshLeaderboard(), LB_REFRESH_MS));

  // initActivity() hydrates from localStorage synchronously and then kicks
  // off a background sweep loop in data.js. The loop polls for new blocks
  // every ACTIVITY_POLL_MS, so no extra refresh interval is needed here.
  // The progress callback re-renders the activity panel: once immediately
  // after hydration so cached events appear on reload without delay, and
  // again any time the background sweep emits a chunk-complete signal.
  if (window.BUData?.initActivity) {
    const onProgress = () => {
      if (typeof window.renderActivityFeed === 'function') {
        try { window.renderActivityFeed(); } catch {}
      }
    };
    setTimeout(() => {
      window.BUData.initActivity(onProgress).catch(e => console.warn('[activity] init failed:', e.message));
    }, 600);
  }
}

// Enumerate active stakers by scanning the on-chain tokenStaker(id) mapping.
// Why this approach: as of late 2025, free-tier Etherscan V2 dropped Base
// coverage ("Free API access is not supported for this chain") and free-tier
// Alchemy caps eth_getLogs at a 10-block range. Both legacy log paths
// (Basescan v1, Alchemy direct eth_getLogs) now fail on free plans, so the
// leaderboard is rebuilt from contract state instead of from event history.
// tokenStaker(uint256) returns the current staker of each token id
// (address(0) when unstaked). A simple eth_call is cheap and unrestricted on
// every plan tier.
async function _fetchStakerBalancesViaTokenStaker() {
  const provider = window.BU.getReadProvider();
  const staking  = new ethers.Contract(window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, provider);
  const totalSupply = window.BU_CONFIG?.collection?.totalSupply || 6666;

  // Short-circuit when nothing is staked. Saves ~133 batch round-trips.
  let totalStaked = 0;
  try { totalStaked = Number(await staking.totalStaked()); } catch {}
  if (totalStaked === 0) return [];

  const counts = new Map();      // addr (lowercase) → active count
  const ZERO   = '0x0000000000000000000000000000000000000000';
  const BATCH  = 50;             // parallel eth_call fan-out
  const GAP_MS = 60;             // breathing room for free-tier RPCs

  for (let i = 1; i <= totalSupply; i += BATCH) {
    const ids = [];
    for (let j = i; j < i + BATCH && j <= totalSupply; j++) ids.push(j);
    const res = await Promise.allSettled(ids.map(id => staking.tokenStaker(id)));
    for (const r of res) {
      if (r.status !== 'fulfilled') continue;
      const a = (r.value || '').toLowerCase();
      if (!a || a === ZERO) continue;
      counts.set(a, (counts.get(a) || 0) + 1);
    }
    // Early exit: once we have totalStaked tokens accounted for, stop scanning.
    let accounted = 0; for (const v of counts.values()) accounted += v;
    if (accounted >= totalStaked) break;
    if (i + BATCH <= totalSupply) await new Promise(r => setTimeout(r, GAP_MS));
  }

  const out = [];
  for (const [addr, staked] of counts.entries()) out.push({ addr, staked });
  return out;
}

async function refreshLeaderboard(force = false) {
  const table = document.getElementById('leaderboardTable');
  const btn   = document.getElementById('lbRefreshBtn');
  if (!table) return;

  if (!force && _lbCache && (Date.now() - _lbCache.ts) < LB_RENDER_TTL_MS) {
    _renderLeaderboard(_lbCache.rows); return;
  }
  if (_lbFetching) return;
  _lbFetching = true;
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  // Only show the "Fetching..." placeholder when the table is empty.
  // If we already rendered cached rows, leave them visible so the user
  // sees the previous scan while the fresh scan runs in the background.
  const hasVisibleRows = !!table.querySelector('.lb-row');
  if (!hasVisibleRows) {
    table.innerHTML = `<div class="lb-empty"><div class="lb-skull" style="font-size:28px;opacity:.5">⌛</div><p style="margin-top:12px">Fetching staker data…</p></div>`;
  }

  try {
    const balances = await _fetchStakerBalancesViaTokenStaker();
    const active = balances.filter(b => b.staked > 0).sort((a, b) => b.staked - a.staked);
    if (active.length === 0) {
      // Only overwrite the table when we have nothing cached to show.
      if (!hasVisibleRows) {
        table.innerHTML = `<div class="lb-empty"><div class="lb-skull">💀</div><p>No active stakers right now.</p></div>`;
      }
      _lbCache = { rows: [], ts: Date.now() };
      _lbLsSave(_lbCache);
      return;
    }

    const total = active.reduce((s, b) => s + b.staked, 0);
    const rows  = active.map((b, i) => ({ rank: i+1, addr: b.addr, staked: b.staked, share: total > 0 ? (b.staked/total)*100 : 0 }));
    _lbCache = { rows, ts: Date.now() };
    _lbLsSave(_lbCache);
    _renderLeaderboard(rows);

  } catch(e) {
    console.warn('[leaderboard]', e.shortMessage || e.message);
    // Don't replace cached rows with an error message; leave the previous
    // scan visible. Only show the error when nothing was rendered before.
    if (!hasVisibleRows) {
      table.innerHTML = `<div class="lb-empty"><div class="lb-skull">💀</div><p>Couldn't load leaderboard right now. Try again in a moment.</p></div>`;
    }
  } finally {
    _lbFetching = false;
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

function _renderLeaderboard(rows) {
  const table   = document.getElementById('leaderboardTable'); if (!table) return;
  const ICONS   = { 1: '👑', 2: '💀', 3: '☠' };
  const me      = (window.BU.getUserAddress() || '').toLowerCase();
  const explorer = window.BU_CONFIG.activeNetwork.explorerUrl.replace(/\/$/, '');
  const short   = a => a.slice(0,6) + '…' + a.slice(-4);

  const thead = `<div class="lb-thead"><span>#</span><span>Wallet</span><span>Staked</span><span>Pool Share</span><span>Share Bar</span></div>`;
  const rowsHtml = rows.map((r, idx) => {
    const rc       = r.rank <= 3 ? `rank-${r.rank}` : '';
    const icon     = ICONS[r.rank] || r.rank;
    const isMe     = r.addr === me;
    const addrLink = explorer ? `<a href="${explorer}/address/${r.addr}" target="_blank" rel="noopener">${short(r.addr)}</a>` : short(r.addr);
    const badge    = isMe ? `<span class="you-badge">You</span>` : '';
    const bar      = Math.max(2, Math.min(100, r.share)).toFixed(1);
    return `<div class="lb-row animating" data-rank="${r.rank}" style="animation-delay:${idx*40}ms">
      <div class="lb-rank ${rc}">${icon}</div>
      <div class="lb-addr">${addrLink}${badge}</div>
      <div class="lb-count ${r.rank===1?'top':''}">${r.staked.toLocaleString()}</div>
      <div class="lb-share">${r.share.toFixed(2)}%</div>
      <div class="lb-share-bar-wrap"><div class="lb-share-bar"><div class="lb-share-bar-fill" style="width:${bar}%"></div></div></div>
    </div>`;
  }).join('');

  table.innerHTML = thead + rowsHtml;
  table.querySelectorAll('.lb-row.animating').forEach(el =>
    el.addEventListener('animationend', () => el.classList.remove('animating'), { once: true })
  );
}

function setText(id,t) { const el=document.getElementById(id); if(el) el.textContent=t; }