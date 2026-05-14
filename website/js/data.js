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

async function _basescanGetLogs(topic0, apiKey) {
  const STAKING = window.BU_CONFIG.contracts.staking;
  const keyParam = apiKey ? `&apikey=${apiKey}` : '';
  let allLogs = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.basescan.org/api?module=logs&action=getLogs` +
      `&address=${STAKING}&topic0=${topic0}` +
      `&fromBlock=0&toBlock=latest&offset=1000&page=${page}${keyParam}`;
    let d;
    try {
      const r = await fetch(url);
      const text = await r.text();
      try { d = JSON.parse(text); }
      catch { throw new Error('Basescan response not JSON: ' + text.slice(0, 60)); }
    } catch(e) { throw e; }
    if (d.status === '0' && (d.message === 'No records found' || d.result?.length === 0)) break;
    if (d.status !== '1') throw new Error(`Basescan: ${d.message || JSON.stringify(d)}`);
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

async function _initFromBasescan(apiKey) {
  console.info('[data] Basescan: querying per-topic...');
  const [stakedLogs, unstakedLogs, claimedLogs, royaltyLogs] = await Promise.all([
    _basescanGetLogs(_TOPICS.Staked,          apiKey),
    _basescanGetLogs(_TOPICS.Unstaked,        apiKey),
    _basescanGetLogs(_TOPICS.RewardClaimed,   apiKey),
    _basescanGetLogs(_TOPICS.RoyaltyReceived, apiKey),
  ]);
  console.info(`[data] Basescan: staked=${stakedLogs.length} unstaked=${unstakedLogs.length} claimed=${claimedLogs.length} royalty=${royaltyLogs.length}`);

  for (const log of stakedLogs) {
    const user = _topicToAddr(log.topics?.[1]);
    if (!user) continue;
    const ids = _decodeUint256Array(log.data);
    try {
      const addr = ethers.getAddress(user);
      STAKER_MAP.set(addr, (STAKER_MAP.get(addr) || 0) + ids.length);
    } catch {}
  }
  for (const log of unstakedLogs) {
    const user = _topicToAddr(log.topics?.[1]);
    if (!user) continue;
    const ids = _decodeUint256Array(log.data);
    try {
      const addr = ethers.getAddress(user);
      const next = (STAKER_MAP.get(addr) || 0) - ids.length;
      if (next <= 0) STAKER_MAP.delete(addr); else STAKER_MAP.set(addr, next);
    } catch {}
  }

  const allEvents = [];
  for (const log of stakedLogs) {
    const user = _topicToAddr(log.topics?.[1]);
    const ids = _decodeUint256Array(log.data);
    allEvents.push({ kind: 'stake', user: user||null, tokenIds: ids, amount: null, blockNumber: parseInt(log.blockNumber,16), txHash: log.transactionHash });
  }
  for (const log of unstakedLogs) {
    const user = _topicToAddr(log.topics?.[1]);
    const ids = _decodeUint256Array(log.data);
    allEvents.push({ kind: 'unstake', user: user||null, tokenIds: ids, amount: null, blockNumber: parseInt(log.blockNumber,16), txHash: log.transactionHash });
  }
  for (const log of claimedLogs) {
    const user = _topicToAddr(log.topics?.[1]);
    const amount = _decodeUint256(log.data);
    allEvents.push({ kind: 'claim', user: user||null, tokenIds: [], amount, blockNumber: parseInt(log.blockNumber,16), txHash: log.transactionHash });
  }
  for (const log of royaltyLogs) {
    allEvents.push({ kind: 'royalty', user: null, tokenIds: [], amount: null, blockNumber: parseInt(log.blockNumber,16), txHash: log.transactionHash });
  }

  allEvents.sort((a, b) => b.blockNumber - a.blockNumber);
  const maxRows = (window.BU_CONFIG.activity?.maxRows ?? 30) * 4;
  ACTIVITY.push(...allEvents.slice(0, maxRows));
  console.info(`[data] Basescan done: ${STAKER_MAP.size} stakers, ${ACTIVITY.length} events`);
}

async function initActivity(onProgress) {
  // Wait up to 3 s for the api-keys fetch in staking.html to set BASESCAN_KEY.
  // Without this wait the key is always '' when we first read it, causing NOTOK.
  let apiKey = window.BASESCAN_KEY || null;
  if (!apiKey) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (window.BASESCAN_KEY) { apiKey = window.BASESCAN_KEY; break; }
    }
  }
  try {
    await _initFromBasescan(apiKey);
    if (onProgress) onProgress();
  } catch(e) {
    console.warn('[data] Basescan failed:', e.message, '— falling back to RPC scan');
    try {
      const provider = await _getLogsProvider();
      const latest = await provider.getBlockNumber();
      const from = Math.max(0, latest - FULL_LOOKBACK_BLOCKS);
      await _scanFromTo(from, latest, onProgress);
      LAST_SCANNED_BLOCK = latest;
    } catch(e2) { console.warn('[data] RPC fallback also failed:', e2.message); }
    return;
  }
  try {
    const provider = await _getLogsProvider();
    LAST_SCANNED_BLOCK = await provider.getBlockNumber();
  } catch(_) {}
}

async function refreshActivity() {
  const provider = await _getLogsProvider();
  const latest = await provider.getBlockNumber();
  if (latest <= LAST_SCANNED_BLOCK) return;
  await _scanFromTo(LAST_SCANNED_BLOCK+1, latest); LAST_SCANNED_BLOCK = latest;
}

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

window.BUData = {
  getPoolStats, getNFTSupply,
  initActivity, refreshActivity, getLeaderboard, getActivity,
  getUserState, getUserOwnedTokens, clearOwnedCache, calcPoolShare,
  isStakingApproved, approveStaking,
  stakeTokens, unstakeTokens, stakeAndClaim, claimRewards,
};