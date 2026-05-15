// js/data.js, BU data layer
const SCAN_CHUNK_SIZE      = 10_000;
const SCAN_DELAY_MS        = 50;   // public RPCs don't rate-limit getLogs
const SCAN_MAX_RETRIES     = 4;
const FULL_LOOKBACK_BLOCKS = 5_000_000;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _isRateLimit(err) {
  if (!err) return false;
  const msg = (err.message||err.toString()||"").toLowerCase();
  return msg.includes("429")||msg.includes("exceeded")||msg.includes("rate limit")||msg.includes("could not coalesce")||msg.includes("compute units");
}

let _logsProvider = null, _logsProviderTried = false;
async function _getLogsProvider() {
  if (_logsProvider) return _logsProvider;
  if (_logsProviderTried) return window.BU.getReadProvider();
  _logsProviderTried = true;
  const fallbacks = window.BU_CONFIG?.activeNetwork?.rpcFallbacks||[];
  for (const url of fallbacks) {
    try {
      const p = new ethers.JsonRpcProvider(url, { chainId: window.BU_CONFIG.activeNetwork.chainId, name: window.BU_CONFIG.activeNetwork.name, staticNetwork: true });
      const latest = await p.getBlockNumber();
      await p.getLogs({ fromBlock: latest-100, toBlock: latest, address: window.BU_CONFIG.contracts.staking });
      _logsProvider = p; console.log("[data] logs provider:", url.split("//")[1].split("/")[0]); return _logsProvider;
    } catch(e) { console.warn("[data] logs RPC failed", url, e.shortMessage||e.message); }
  }
  return window.BU.getReadProvider();
}

async function _withBackoff(fn, label="rpc") {
  let lastErr;
  for (let attempt=0; attempt<SCAN_MAX_RETRIES; attempt++) {
    try { return await fn(); } catch(e) {
      lastErr=e; if (!_isRateLimit(e)) throw e;
      const wait = 500 * Math.pow(2,attempt); console.warn(`[${label}] 429 (attempt ${attempt+1}), backing off ${wait}ms`); await _sleep(wait);
    }
  }
  throw lastErr;
}

async function _safeCall(fn, label, fallback=0n) { try { return await fn(); } catch(e) { console.warn(`[data] ${label} failed:`, e.shortMessage||e.message); return fallback; } }

async function getPoolStats() {
  // Use the already-probed public RPC, not the rate-limited Alchemy key
  const _prov = await _getLogsProvider();
  const s = new ethers.Contract(
    window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, _prov
  );
  const totalStaked      = await _safeCall(() => s.totalStaked(),             "totalStaked");
  const totalReceived    = await _safeCall(() => s.totalRewardsReceived(),    "totalRewardsReceived");
  const totalDistributed = await _safeCall(() => s.totalRewardsDistributed(), "totalRewardsDistributed");
  const unclaimed        = await _safeCall(() => s.unclaimedPool(),           "unclaimedPool");
  const poolBalance      = await _safeCall(() => s.rewardPoolBalance(),       "rewardPoolBalance");
  const lastRoyaltyAmount= await _safeCall(() => s.lastRoyaltyAmount(),       "lastRoyaltyAmount");
  const lastRoyaltyTime  = await _safeCall(() => s.lastRoyaltyTimestamp(),    "lastRoyaltyTimestamp");
  return { totalStaked:Number(totalStaked), totalReceived, totalDistributed, unclaimedPool:unclaimed, poolBalance, lastRoyaltyAmount, lastRoyaltyTime:Number(lastRoyaltyTime) };
}
async function getNFTSupply() { const nft=window.BU.readNFT(); try { return Number(await nft.totalSupply()); } catch { return 0; } }

const ACTIVITY = [];
const STAKER_MAP = new Map();
let LAST_SCANNED_BLOCK = 0;

function _bumpStaker(addr, delta) {
  addr = ethers.getAddress(addr);
  const cur = STAKER_MAP.get(addr)||0, next=cur+delta;
  if (next<=0) STAKER_MAP.delete(addr); else STAKER_MAP.set(addr,next);
}

async function _scanRangeOnce(fromBlock, toBlock) {
  const provider = await _getLogsProvider();
  const c = new ethers.Contract(window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, provider);
  // Fetch all 4 event types in parallel, 4x faster than sequential
  const [stakedEv, unstakedEv, claimedEv, royaltyEv] = await Promise.all([
    _withBackoff(() => c.queryFilter(c.filters.Staked(),          fromBlock, toBlock), "staked"),
    _withBackoff(() => c.queryFilter(c.filters.Unstaked(),        fromBlock, toBlock), "unstaked"),
    _withBackoff(() => c.queryFilter(c.filters.RewardClaimed(),   fromBlock, toBlock), "claimed"),
    _withBackoff(() => c.queryFilter(c.filters.RoyaltyReceived(), fromBlock, toBlock), "royalty"),
  ]);
  const all = [...stakedEv.map(e=>({kind:"stake",ev:e})),...unstakedEv.map(e=>({kind:"unstake",ev:e})),...claimedEv.map(e=>({kind:"claim",ev:e})),...royaltyEv.map(e=>({kind:"royalty",ev:e}))];
  all.sort((a,b) => a.ev.blockNumber-b.ev.blockNumber || (a.ev.index??a.ev.transactionIndex??0)-(b.ev.index??b.ev.transactionIndex??0));
  for (const item of all) {
    const e=item.ev, args=e.args;
    const tokenIds = args.tokenIds?args.tokenIds.map(n=>Number(n)):[];
    const user = args.user||null, count=tokenIds.length;
    if (item.kind==="stake"   && user) _bumpStaker(user,+count);
    if (item.kind==="unstake" && user) _bumpStaker(user,-count);
    ACTIVITY.unshift({ kind:item.kind, user, tokenIds, amount:args.amount??args.total??null, blockNumber:e.blockNumber, txHash:e.transactionHash });
  }
  const maxRows = (window.BU_CONFIG.activity?.maxRows??30)*4;
  if (ACTIVITY.length > maxRows) ACTIVITY.length = maxRows;
}

async function _scanFromTo(fromBlock, toBlock, onProgress) {
  if (fromBlock > toBlock) return;
  const LARGE = 50_000;
  for (let f=fromBlock; f<=toBlock; f+=LARGE) {
    const t=Math.min(f+LARGE-1,toBlock);
    try {
      await _scanRangeOnce(f,t); await _sleep(SCAN_DELAY_MS);
      if (onProgress) onProgress();
    } catch(e) {
      for (let f2=f; f2<=t; f2+=SCAN_CHUNK_SIZE) {
        const t2=Math.min(f2+SCAN_CHUNK_SIZE-1,t);
        try { await _scanRangeOnce(f2,t2); await _sleep(SCAN_DELAY_MS); if (onProgress) onProgress(); }
        catch(e2) { console.warn("[scan] chunk failed",f2,t2,e2.message); }
      }
    }
  }
}

// ─── Basescan API scanner ───────────────────────────────────────────────────
// Uses the Basescan REST API, free, no auth needed, no block-range limit.
// Queries each event type by its topic0 hash individually, then decodes manually.
// This avoids any ABI-loading race condition.
//
// Correct topic0 hashes (from keccak256 of the event signature):
const _TOPICS = {
  Staked:          '0x134b166c6094cc1ccbf1e3353ce5c3cd9fd29869051bdb999895854d77cc5ef6',
  Unstaked:        '0x20748b935fd9f21155c2e98cb2bd5df6fe86f21b193cebaae8d9ad7db0ba5416',
  RewardClaimed:   '0x106f923f993c2149d49b4255ff723acafa1f2d94393f561d3eda32ae348f7241',
  RoyaltyReceived: '0x725846d8fc0c7badc4b32254062afa7128344a531bfb7cc3c0cfcf6a6e218713',
};

// Etherscan V2 unified endpoint. Basescan V1 was deprecated 2025; same API
// key now works across all chains via chainid=8453 for Base.
// Docs: https://docs.etherscan.io/v2-migration
const _ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const _CHAIN_ID     = 8453;

async function _basescanGetLogs(topic0, apiKey) {
  const STAKING = window.BU_CONFIG.contracts.staking;
  const keyParam = apiKey ? `&apikey=${apiKey}` : '';
  let allLogs = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${_ETHERSCAN_V2}?chainid=${_CHAIN_ID}&module=logs&action=getLogs` +
      `&address=${STAKING}&topic0=${topic0}` +
      `&fromBlock=0&toBlock=latest&offset=1000&page=${page}${keyParam}`;
    console.info('[act-es] GET page', page, '→', url.replace(/apikey=[^&]+/, 'apikey=***'));
    let d, text;
    try {
      const r = await fetch(url);
      text = await r.text();
      try { d = JSON.parse(text); }
      catch { throw new Error('Etherscan response not JSON: ' + text.slice(0, 120)); }
    } catch(e) { console.error('[act-es] fetch error:', e.message); throw e; }
    console.info('[act-es] response status=', d.status, 'message=', d.message,
      'result is', Array.isArray(d.result) ? `array len=${d.result.length}` : typeof d.result);
    if (d.status === '0' && (d.message === 'No records found' || d.result?.length === 0)) break;
    if (d.status !== '1') {
      // Surface the FULL detail string. Common causes: deprecated V1, missing/invalid key, rate limit.
      const detail = typeof d.result === 'string' ? d.result : (d.message || 'no detail');
      console.error('[act-es] non-OK body:', text.slice(0, 300));
      throw new Error(`Etherscan ${d.message || 'error'}: ${detail}`.slice(0, 220));
    }
    const batch = d.result || [];
    allLogs = allLogs.concat(batch);
    if (batch.length < 1000) break;
  }
  return allLogs;
}

function _topicToAddr(topic) {
  if (!topic) return null;
  return ('0x' + topic.slice(26)).toLowerCase();
}

function _decodeUint256Array(hexData) {
  try {
    const d = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
    if (d.length < 128) return [];
    const len = parseInt(d.slice(64, 128), 16);
    const ids = [];
    for (let i = 0; i < len; i++) {
      ids.push(parseInt(d.slice(128 + i * 64, 128 + i * 64 + 64), 16));
    }
    return ids;
  } catch { return []; }
}

function _decodeUint256(hexData) {
  try {
    const d = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
    return BigInt('0x' + d.slice(0, 64));
  } catch { return 0n; }
}

// Direct JSON-RPC eth_getLogs against Alchemy. Bypasses ethers' JsonRpcProvider
// batcher (which raises "could not coalesce error" when one batched sub-call
// fails). Chunked at 9500 blocks to stay under Alchemy's 10k-block free-tier
// limit. Returns raw log objects (same shape as Etherscan: {topics, data, blockNumber, transactionHash}).
async function _alchemyGetLogs(topic0, fromBlock, toBlock) {
  const STAKING = window.BU_CONFIG.contracts.staking;
  // Prefer the private Alchemy key from /.netlify/functions/api-keys if it has
  // been published as window.ALCHEMY_KEY; otherwise fall through to the public
  // rpcUrl in config.js (which is already an Alchemy endpoint).
  const rpc = (typeof window.ALCHEMY_KEY === 'string' && window.ALCHEMY_KEY)
    ? `https://base-mainnet.g.alchemy.com/v2/${window.ALCHEMY_KEY}`
    : window.BU_CONFIG.activeNetwork.rpcUrl;
  const STEP = 9_500;
  const out = [];
  let chunks = 0, errors = 0;
  for (let f = fromBlock; f <= toBlock; f += STEP) {
    const t = Math.min(f + STEP - 1, toBlock);
    const body = {
      jsonrpc: '2.0', id: chunks + 1, method: 'eth_getLogs',
      params: [{ address: STAKING, topics: [topic0],
                 fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }],
    };
    try {
      const r = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) {
        console.warn(`[act-alc] chunk ${f}-${t} error:`, JSON.stringify(d.error).slice(0, 240));
        errors++; continue;
      }
      const arr = Array.isArray(d.result) ? d.result : [];
      out.push(...arr);
    } catch(e) {
      console.warn(`[act-alc] chunk ${f}-${t} fetch failed:`, e.message);
      errors++;
    }
    chunks++;
    if (chunks % 25 === 0) await new Promise(r => setTimeout(r, 30));
  }
  console.info(`[act-alc] topic ${topic0.slice(0,10)}…: ${chunks} chunks, ${errors} errors, ${out.length} logs`);
  return out;
}

async function _initFromAlchemy() {
  const provider = await _getLogsProvider();
  const latest = await provider.getBlockNumber();
  const from   = Math.max(0, latest - FULL_LOOKBACK_BLOCKS);
  console.info('[act-alc] direct Alchemy scan', from, '→', latest);
  const [stakedLogs, unstakedLogs, claimedLogs, royaltyLogs] = await Promise.all([
    _alchemyGetLogs(_TOPICS.Staked,          from, latest),
    _alchemyGetLogs(_TOPICS.Unstaked,        from, latest),
    _alchemyGetLogs(_TOPICS.RewardClaimed,   from, latest),
    _alchemyGetLogs(_TOPICS.RoyaltyReceived, from, latest),
  ]);
  console.info(`[act-alc] total: staked=${stakedLogs.length} unstaked=${unstakedLogs.length} claimed=${claimedLogs.length} royalty=${royaltyLogs.length}`);
  _populateFromRawLogs(stakedLogs, unstakedLogs, claimedLogs, royaltyLogs);
  LAST_SCANNED_BLOCK = latest;
}

function _populateFromRawLogs(stakedLogs, unstakedLogs, claimedLogs, royaltyLogs) {
  // STAKER_MAP from staked/unstaked
  for (const log of stakedLogs) {
    const user = _topicToAddr(log.topics?.[1]); if (!user) continue;
    const ids = _decodeUint256Array(log.data);
    try { const a = ethers.getAddress(user); STAKER_MAP.set(a, (STAKER_MAP.get(a)||0) + ids.length); } catch {}
  }
  for (const log of unstakedLogs) {
    const user = _topicToAddr(log.topics?.[1]); if (!user) continue;
    const ids = _decodeUint256Array(log.data);
    try {
      const a = ethers.getAddress(user);
      const next = (STAKER_MAP.get(a)||0) - ids.length;
      if (next <= 0) STAKER_MAP.delete(a); else STAKER_MAP.set(a, next);
    } catch {}
  }
  // Merged activity list, newest first
  const all = [];
  for (const log of stakedLogs) all.push({ kind:'stake',   user:_topicToAddr(log.topics?.[1]), tokenIds:_decodeUint256Array(log.data), amount:null, blockNumber:parseInt(log.blockNumber,16), txHash:log.transactionHash });
  for (const log of unstakedLogs) all.push({ kind:'unstake', user:_topicToAddr(log.topics?.[1]), tokenIds:_decodeUint256Array(log.data), amount:null, blockNumber:parseInt(log.blockNumber,16), txHash:log.transactionHash });
  for (const log of claimedLogs)  all.push({ kind:'claim',   user:_topicToAddr(log.topics?.[1]), tokenIds:[], amount:_decodeUint256(log.data), blockNumber:parseInt(log.blockNumber,16), txHash:log.transactionHash });
  for (const log of royaltyLogs)  all.push({ kind:'royalty', user:null, tokenIds:[], amount:null, blockNumber:parseInt(log.blockNumber,16), txHash:log.transactionHash });
  all.sort((a, b) => b.blockNumber - a.blockNumber);
  const maxRows = (window.BU_CONFIG.activity?.maxRows ?? 30) * 4;
  ACTIVITY.push(...all.slice(0, maxRows));
  console.info(`[act] populated: ${STAKER_MAP.size} stakers, ${ACTIVITY.length} events`);
}

async function _initFromBasescan(apiKey) {
  console.info('[act-es] querying per-topic, key=', apiKey ? 'present' : 'MISSING');
  const [stakedLogs, unstakedLogs, claimedLogs, royaltyLogs] = await Promise.all([
    _basescanGetLogs(_TOPICS.Staked,          apiKey),
    _basescanGetLogs(_TOPICS.Unstaked,        apiKey),
    _basescanGetLogs(_TOPICS.RewardClaimed,   apiKey),
    _basescanGetLogs(_TOPICS.RoyaltyReceived, apiKey),
  ]);
  console.info(`[act-es] total: staked=${stakedLogs.length} unstaked=${unstakedLogs.length} claimed=${claimedLogs.length} royalty=${royaltyLogs.length}`);
  _populateFromRawLogs(stakedLogs, unstakedLogs, claimedLogs, royaltyLogs);
}

// Recent-window activity scan.
// Why this approach: as of late 2025, free-tier Etherscan V2 dropped Base
// ("Free API access is not supported for this chain") and free-tier Alchemy
// caps eth_getLogs at a 10-block range. Both _initFromBasescan and
// _initFromAlchemy (above) are kept for reference / future paid-key use,
// but on free infra they fail loudly and pollute the console. Instead we
// scan forward from the staking-contract deploy block in small chunks via
// _getLogsProvider() (which probes public RPC fallbacks like
// base.publicnode.com). Progress is persisted to localStorage so reloads
// resume where the previous scan left off rather than starting from scratch.
const STAKING_DEPLOY_BLOCK     = 45258665;  // BasedUndeads staking contract on Base
const ACTIVITY_CHUNK_BLOCKS    = 500;       // safe on free public RPCs
const ACTIVITY_CHUNK_DELAY_MS  = 300;       // slow sweep, easy on the RPC
const ACTIVITY_POLL_MS         = 30_000;    // poll for new blocks once caught up
const ACTIVITY_CHUNK_RETRIES   = 2;         // retries before skipping a chunk
const ACTIVITY_MAX_STORED      = 500;       // cap persisted events (~5KB JSON)
const ACTIVITY_LS_KEY          = 'bu_activity_v1';

// ── localStorage helpers (private-mode browsers throw; swallow silently) ──
function _lsGet(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
function _lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* quota / private mode / serialize error → ignore */ }
}

// Serialized form: { lastScannedBlock, events: [{kind,user,tokenIds,amountStr,blockNumber,txHash}, ...] }
// BigInt amounts are stored as strings; rehydrated to BigInt on load.
function _activityHydrate() {
  const data = _lsGet(ACTIVITY_LS_KEY);
  if (!data || !Array.isArray(data.events)) return 0;
  ACTIVITY.length = 0;
  STAKER_MAP.clear();
  // Events are newest-first in storage; walk oldest-first to rebuild STAKER_MAP correctly.
  const ordered = data.events.slice().sort((a, b) => a.blockNumber - b.blockNumber);
  for (const e of ordered) {
    const amount = e.amountStr ? BigInt(e.amountStr) : null;
    if (e.kind === 'stake'   && e.user) _bumpStaker(e.user,  (e.tokenIds||[]).length);
    if (e.kind === 'unstake' && e.user) _bumpStaker(e.user, -(e.tokenIds||[]).length);
    ACTIVITY.unshift({ kind:e.kind, user:e.user, tokenIds:e.tokenIds||[], amount, blockNumber:e.blockNumber, txHash:e.txHash });
  }
  LAST_SCANNED_BLOCK = Number(data.lastScannedBlock) || 0;
  return ACTIVITY.length;
}

function _activityPersist() {
  // Cap stored events to most recent N to bound localStorage usage.
  const trimmed = ACTIVITY.slice(0, ACTIVITY_MAX_STORED).map(e => ({
    kind:        e.kind,
    user:        e.user,
    tokenIds:    e.tokenIds || [],
    amountStr:   (e.amount != null) ? e.amount.toString() : null,
    blockNumber: e.blockNumber,
    txHash:      e.txHash,
  }));
  _lsSet(ACTIVITY_LS_KEY, { lastScannedBlock: LAST_SCANNED_BLOCK, events: trimmed });
}

// Scan a single block range. Returns true on success, false on failure.
// Only fetches Staked / Unstaked / RewardClaimed (no Royalty, per UI spec).
async function _scanActivityRange(c, from, to) {
  try {
    const [stakedEv, unstakedEv, claimedEv] = await Promise.all([
      c.queryFilter(c.filters.Staked(),        from, to),
      c.queryFilter(c.filters.Unstaked(),      from, to),
      c.queryFilter(c.filters.RewardClaimed(), from, to),
    ]);
    const all = [
      ...stakedEv  .map(e => ({ kind:'stake',   ev:e })),
      ...unstakedEv.map(e => ({ kind:'unstake', ev:e })),
      ...claimedEv .map(e => ({ kind:'claim',   ev:e })),
    ];
    all.sort((a,b) => a.ev.blockNumber - b.ev.blockNumber || (a.ev.index ?? a.ev.transactionIndex ?? 0) - (b.ev.index ?? b.ev.transactionIndex ?? 0));
    for (const item of all) {
      const e = item.ev, args = e.args || {};
      const tokenIds = args.tokenIds ? args.tokenIds.map(n => Number(n)) : [];
      const user = args.user || null;
      if (item.kind === 'stake'   && user) _bumpStaker(user,  tokenIds.length);
      if (item.kind === 'unstake' && user) _bumpStaker(user, -tokenIds.length);
      ACTIVITY.unshift({ kind:item.kind, user, tokenIds, amount:args.amount ?? null, blockNumber:e.blockNumber, txHash:e.transactionHash });
    }
    return true;
  } catch {
    return false;
  }
}

// Background sweep loop. Walks forward from LAST_SCANNED_BLOCK (or the
// staking deploy block on first run) to chain head, then idles and polls.
// Runs forever; safe to call once. Re-entrancy guarded by _activityLoopRunning.
// If onProgress is supplied, it is invoked after every chunk that produced
// at least one new event, throttled to avoid spamming the UI.
let _activityLoopRunning = false;
async function _activityLoop(onProgress) {
  if (_activityLoopRunning) return;
  _activityLoopRunning = true;
  try {
    while (true) {
      let provider, latest;
      try { provider = await _getLogsProvider(); }
      catch { await _sleep(ACTIVITY_POLL_MS); continue; }
      try { latest = await provider.getBlockNumber(); }
      catch { await _sleep(ACTIVITY_POLL_MS); continue; }

      const c = new ethers.Contract(window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, provider);
      let cursor = LAST_SCANNED_BLOCK > 0 ? LAST_SCANNED_BLOCK + 1 : STAKING_DEPLOY_BLOCK;

      // Catch-up sweep: scan forward in chunks to chain head.
      let lastNotifyTs = 0;
      while (cursor <= latest) {
        const to = Math.min(cursor + ACTIVITY_CHUNK_BLOCKS - 1, latest);
        const beforeLen = ACTIVITY.length;
        let ok = false;
        for (let attempt = 0; attempt <= ACTIVITY_CHUNK_RETRIES && !ok; attempt++) {
          if (attempt > 0) await _sleep(500 * Math.pow(2, attempt));
          ok = await _scanActivityRange(c, cursor, to);
        }
        // Whether ok or skipped, advance cursor so a permanently-bad chunk
        // doesn't stall the loop forever. Lossy chunks are an acceptable
        // tradeoff for keeping the feed live.
        LAST_SCANNED_BLOCK = to;
        // Trim in-memory list so it doesn't grow unbounded over long sweeps.
        const maxRows = (window.BU_CONFIG.activity?.maxRows ?? 30) * 4;
        if (ACTIVITY.length > maxRows) ACTIVITY.length = maxRows;
        _activityPersist();
        // Notify the UI when this chunk produced new events, throttled to
        // once every 2 s so a fast historical sweep doesn't spam re-renders.
        if (onProgress && ACTIVITY.length !== beforeLen) {
          const now = Date.now();
          if (now - lastNotifyTs > 2000) {
            lastNotifyTs = now;
            try { onProgress(); } catch {}
          }
        }
        cursor = to + 1;
        await _sleep(ACTIVITY_CHUNK_DELAY_MS);
      }

      // Caught up. Final notify so the UI reflects the latest state, then idle.
      if (onProgress) { try { onProgress(); } catch {} }
      await _sleep(ACTIVITY_POLL_MS);
    }
  } finally {
    _activityLoopRunning = false;
  }
}

// Public entrypoint. Synchronously hydrates from localStorage (so the UI
// renders cached events on reload), then kicks off the background sweep.
// Returns once hydration is done; the sweep continues in the background.
// onProgress is called: (1) immediately after hydration, and (2) by the
// background loop after each chunk that produced new events.
async function initActivity(onProgress) {
  _activityHydrate();
  if (onProgress) { try { onProgress(); } catch {} }
  // Fire-and-forget the background loop.
  _activityLoop(onProgress);
}

// No-op kept for backwards compatibility with page-staking.js's periodic
// refresh interval. The background loop in _activityLoop already polls for
// new blocks every ACTIVITY_POLL_MS, so an explicit refresh is unnecessary.
async function refreshActivity() { /* handled by background _activityLoop */ }

function getLeaderboard(maxRows) {
  const list=[]; for (const [addr,count] of STAKER_MAP.entries()) list.push({address:addr,active:count});
  list.sort((a,b)=>b.active-a.active); return list.slice(0,maxRows??window.BU_CONFIG.leaderboard.maxRows);
}
function getActivity(maxRows) { return ACTIVITY.slice(0,maxRows??window.BU_CONFIG.activity.maxRows); }

async function getUserState(address) {
  if (!address) return null;
  // Use the already-probed public RPC, not the rate-limited Alchemy key
  const _prov = await _getLogsProvider();
  const nft   = new ethers.Contract(
    window.BU_CONFIG.contracts.nft, window.BU.ABI.nft, _prov
  );
  const stake = new ethers.Contract(
    window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, _prov
  );
  const nftBalance         = await _safeCall(()=>nft.balanceOf(address),         "balanceOf",        0n);
  const stakedBalance      = await _safeCall(()=>stake.stakedBalance(address),   "stakedBalance",    0n);
  const earnedBn           = await _safeCall(()=>stake.earned(address),          "earned",           0n);
  const stakedTokenIds     = await _safeCall(()=>stake.getStakedTokens(address), "getStakedTokens",  []);
  const timeUntilUnstakeBn = await _safeCall(()=>stake.timeUntilUnstake(address),"timeUntilUnstake", 0n);
  return { address, nftBalance:Number(nftBalance), stakedBalance:Number(stakedBalance), earnedWei:earnedBn, stakedTokenIds:(stakedTokenIds||[]).map(n=>Number(n)), timeUntilUnstake:Number(timeUntilUnstakeBn) };
}

// ─── Owned-token enumeration ────────────────────────────────────────────────
// Strategy (mirrors the working old site):
//   1. Alchemy NFT API, single REST call, instant, returns all tokens
//   2. OpenSea account API, fallback if Alchemy unavailable
//   3. ownerOf scan, final fallback, batched at 50 with 80ms delay
//
// window.ALCHEMY_KEY is set by the inline <script> in staking.html before
// this file runs (loaded from /.netlify/functions/api-keys).

const _ownedCache = new Map();
const OWNED_CACHE_TTL = 90_000; // 90s, survives the 20s refresh cycle
function clearOwnedCache(address) {
  if (address) _ownedCache.delete(address.toLowerCase());
  else _ownedCache.clear();
}

// Enumerate every NFT currently held by the staking contract via Alchemy's
// NFT API. This is the same approach as the Python collection script the
// project owner verified works: a single paginated REST call returns the
// authoritative list of staked token IDs, far cheaper than scanning all
// 6666 token IDs via tokenStaker(id). Returns [] if the Alchemy key isn't
// available; throws if pagination fails partway (callers must distinguish
// "no NFT-API access" from "partial result" so they don't persist an
// undercount as if it were complete).
async function getStakingContractTokens() {
  const STAKING_ADDR = window.BU_CONFIG.contracts.staking;
  const NFT_ADDRESS  = window.BU_CONFIG.contracts.nft;
  const alchemyHost  = window.BU_CONFIG.activeNetwork.alchemyHost
                       || 'https://base-mainnet.g.alchemy.com';
  const alchemyKey   = window.ALCHEMY_KEY;
  if (typeof alchemyKey !== 'string' || alchemyKey.length === 0) return [];

  const all = [];
  let pageKey = null, pageNum = 0;
  do {
    const params = new URLSearchParams({
      owner: STAKING_ADDR,
      'contractAddresses[]': NFT_ADDRESS,
      withMetadata: 'false',
      pageSize: '100',
    });
    if (pageKey) params.set('pageKey', pageKey);
    const url = `${alchemyHost}/nft/v3/${alchemyKey}/getNFTsForOwner?${params}`;
    let r;
    try { r = await fetch(url); }
    catch (e) {
      if (pageNum === 0) return [];           // page 1 failed → signal "no data"
      throw new Error(`Alchemy NFT API failed mid-pagination on page ${pageNum+1}: ${e.message}`);
    }
    if (!r.ok) {
      if (pageNum === 0) {                    // page 1 non-OK → signal "no data"
        console.warn('[staked-tokens] Alchemy page 1 HTTP', r.status);
        return [];
      }
      throw new Error(`Alchemy NFT API page ${pageNum+1} HTTP ${r.status}`);
    }
    const d = await r.json();
    (d.ownedNfts || []).forEach(n => {
      const raw = String(n.tokenId);
      const id  = raw.startsWith('0x') || raw.startsWith('0X')
        ? parseInt(raw, 16)
        : parseInt(raw, 10);
      if (Number.isFinite(id) && id >= 0) all.push(id);
    });
    pageKey = d.pageKey || null;
    pageNum++;
    if (pageKey) await _sleep(150);
  } while (pageKey && pageNum < 100);
  return all;
}

async function getUserOwnedTokens(address) {
  if (!address) return [];
  const _key = address.toLowerCase();
  const _hit = _ownedCache.get(_key);
  if (_hit && Date.now() - _hit.fetchedAt < OWNED_CACHE_TTL) return _hit.ids;

  const NFT_ADDRESS  = window.BU_CONFIG.contracts.nft;
  const alchemyHost  = window.BU_CONFIG.activeNetwork.alchemyHost
                       || 'https://base-mainnet.g.alchemy.com';
  const openseaHost  = 'https://api.opensea.io';
  const openseaChain = 'base';
  const slug         = 'basedundeads';

  // ── Path 1: Alchemy NFT API (fastest, single call) ──────────────────────
  const alchemyKey = window.ALCHEMY_KEY;
  if (typeof alchemyKey === 'string' && alchemyKey.length > 0) {
    try {
      const all = [];
      let pageKey = null, pageNum = 0;
      do {
        const params = new URLSearchParams({
          owner: address,
          'contractAddresses[]': NFT_ADDRESS,
          withMetadata: 'false',
          pageSize: '100',
        });
        if (pageKey) params.set('pageKey', pageKey);
        const url = `${alchemyHost}/nft/v3/${alchemyKey}/getNFTsForOwner?${params}`;
        const r = await fetch(url);
        if (!r.ok) { console.warn('[owned] Alchemy page', pageNum+1, 'HTTP', r.status); break; }
        const d = await r.json();
        (d.ownedNfts || []).forEach(n => all.push(Number(n.tokenId)));
        pageKey = d.pageKey || null;
        pageNum++;
      } while (pageKey && pageNum < 20);
      if (all.length > 0) {
        console.info(`[owned] Alchemy: ${all.length} tokens`);
        const sorted = all.sort((a,b) => a-b);
        _ownedCache.set(_key, { ids: sorted, fetchedAt: Date.now() });
        return sorted;
      }
      console.info('[owned] Alchemy returned 0, trying next method');
    } catch(e) {
      console.info('[owned] Alchemy failed:', e.message);
    }
  }

  // ── Path 2: OpenSea account API ───────────────────────────────────────────
  const opensea = window.OPENSEA_KEY;
  if (typeof opensea === 'string' && opensea.length > 0) {
    try {
      const url = `${openseaHost}/api/v2/chain/${openseaChain}/account/${address}/nfts` +
                  `?collection=${slug}&limit=200`;
      const r = await fetch(url, { headers: { 'x-api-key': opensea } });
      if (r.ok) {
        const d = await r.json();
        const arr = (d.nfts || []).map(n => Number(n.identifier));
        if (arr.length > 0) {
          console.info(`[owned] OpenSea: ${arr.length} tokens`);
          const sorted = arr.sort((a,b) => a-b);
          _ownedCache.set(_key, { ids: sorted, fetchedAt: Date.now() });
          return sorted;
        }
        console.info('[owned] OpenSea returned 0, falling to ownerOf scan');
      }
    } catch(e) {
      console.info('[owned] OpenSea failed:', e.message);
    }
  }

  // ── Path 3: ownerOf scan (last resort, slow but always works) ───────────
  const _prov = await _getLogsProvider();
  const nft = new ethers.Contract(NFT_ADDRESS, window.BU.ABI.nft, _prov);
  let bal = 0;
  try { bal = Number(await nft.balanceOf(address)); }
  catch(e) { console.warn('[owned] balanceOf failed', e.message); return []; }
  if (bal === 0) return [];
  const supply = window.BU_CONFIG.collection.totalSupply || 6666;
  const userLow = address.toLowerCase(), found = [];
  console.info(`[owned] ownerOf scan: ${supply} tokens, balance=${bal}`);
  const BATCH = 50;
  for (let i = 1; i <= supply && found.length < bal; i += BATCH) {
    const ids = [];
    for (let j = i; j < i+BATCH && j <= supply; j++) ids.push(j);
    const res = await Promise.allSettled(ids.map(id => nft.ownerOf(id)));
    for (let k = 0; k < res.length; k++) {
      if (res[k].status !== 'fulfilled') continue;
      if (res[k].value.toLowerCase() === userLow) found.push(ids[k]);
    }
    if (found.length < bal) await _sleep(80);
  }
  console.info(`[owned] ownerOf scan done: ${found.length}/${bal}`);
  const sorted = found.sort((a,b) => a-b);
  _ownedCache.set(_key, { ids: sorted, fetchedAt: Date.now() });
  return sorted;
}

function calcPoolShare(userActive, totalActive) { if (!totalActive||totalActive===0) return 0; return (userActive/totalActive)*100; }

async function isStakingApproved(address) {
  const _prov = await _getLogsProvider();
  const nft = new ethers.Contract(
    window.BU_CONFIG.contracts.nft, window.BU.ABI.nft, _prov
  );
  return await nft.isApprovedForAll(address, window.BU_CONFIG.contracts.staking);
}
async function approveStaking() { const c=window.BU.writeNFT(); if(!c) throw new Error("Connect wallet first"); return c.setApprovalForAll(window.BU_CONFIG.contracts.staking,true); }
async function stakeTokens(ids) { const c=window.BU.writeStaking(); if(!c) throw new Error("Connect wallet first"); return c.stake(ids); }
async function unstakeTokens(ids) { const c=window.BU.writeStaking(); if(!c) throw new Error("Connect wallet first"); return c.unstake(ids); }
async function stakeAndClaim(ids) { const c=window.BU.writeStaking(); if(!c) throw new Error("Connect wallet first"); return c.stakeAndClaim(ids); }
async function claimRewards() { const c=window.BU.writeStaking(); if(!c) throw new Error("Connect wallet first"); return c.claim(); }

// Public alias so page-staking.js can hydrate ACTIVITY from localStorage
// at DOMContentLoaded — before the slow stakePage() awaits complete and
// initActivity() actually runs.
function hydrateActivityFromStorage() { _activityHydrate(); }

window.BUData = {
  getPoolStats, getNFTSupply,
  initActivity, refreshActivity, hydrateActivityFromStorage,
  getLeaderboard, getActivity,
  getUserState, getUserOwnedTokens, getStakingContractTokens, clearOwnedCache, calcPoolShare,
  isStakingApproved, approveStaking,
  stakeTokens, unstakeTokens, stakeAndClaim, claimRewards,
};