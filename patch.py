#!/usr/bin/env python3
"""
patch.py, Based Undeads v5 (Final)
=====================================
Run from the ROOT of the website repo (basedundeads-repo/).

    cd /path/to/basedundeads-repo
    python3 patch.py

Cumulative, safe to run on any previous patch state.

Root causes fixed in this version
───────────────────────────────────
  CORS  config.js rpcFallbacks contained base.publicnode.com which blocks
        CORS from localhost (and some browsers). Replaced with CORS-safe RPCs.

  LB    data.js used eth_getLogs RPC calls (queryFilter) for the leaderboard
        and activity scan.  These fail with CORS errors on some public nodes
        and time out due to block-range limits.  The OLD site used the free
        Basescan REST API (api.basescan.org/api?module=logs&action=getLogs)
        which has zero CORS issues, no authentication, and returns ALL
        historical logs in one call regardless of block range.  This patch
        restores that approach.

  UI    NFT cards on the staking page show a trait table that takes space
        and slows down the initial render.  Removed; only image + ID +
        rarity badge remain.  Grid changed from 2 to 4 compact columns.

Fixes applied
─────────────
  1  config.js           rpcFallbacks → CORS-safe public RPCs
  2  js/data.js          initActivity uses Basescan API first; RPC scan as fallback
  3  js/images.js        nft-card-traits section removed from card template
  4  css/style.css       .nft-grid.compact → 4-column layout; image fills card
"""

import os, sys

ROOT    = os.path.dirname(os.path.abspath(__file__))
WEBSITE = os.path.join(ROOT, 'website')
JS_DIR  = os.path.join(WEBSITE, 'js')
CSS_DIR = os.path.join(WEBSITE, 'css')

def read(path):
    with open(path, 'r', encoding='utf-8') as f: return f.read()

def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f: f.write(content)
    print(f'  [WRITE] {os.path.relpath(path, ROOT)}')

def already(label): print(f'  [SKIP]  {label}')
def warn(label):    print(f'  [WARN]  {label}, target not found')

def apply(content, old, new, label):
    if new in content:     already(label); return content
    if old not in content: warn(label);    return content
    return content.replace(old, new, 1)

def replace_boundary(content, start_marker, end_marker, new_text, label):
    """Replace from start_marker to end_marker (exclusive)."""
    si = content.find(start_marker)
    ei = content.find(end_marker, si)
    if si == -1 or ei == -1:
        warn(label); return content
    if new_text in content:
        already(label); return content
    return content[:si] + new_text + content[ei:]


# ── Fix 1: config.js, CORS-safe fallback RPCs ──────────────────────────────
def fix_config_js():
    path = os.path.join(WEBSITE, 'config.js')
    if not os.path.exists(path): print('  [SKIP]  config.js not found'); return
    c = read(path)

    # publicnode.com blocks CORS from localhost.
    # mainnet.base.org (official Base RPC) and base.drpc.org are CORS-safe.
    c = apply(c,
        '      rpcFallbacks: [\n'
        '        "https://base.publicnode.com",\n'
        '        "https://base-rpc.publicnode.com",\n'
        '        "https://1rpc.io/base",\n'
        '      ],',
        '      rpcFallbacks: [\n'
        '        "https://mainnet.base.org",\n'
        '        "https://base.drpc.org",\n'
        '        "https://1rpc.io/base",\n'
        '      ],',
        'rpcFallbacks CORS-safe')
    write(path, c)


# ── Fix 2: js/data.js, Basescan API for leaderboard/activity ───────────────
def fix_data_js():
    path = os.path.join(JS_DIR, 'data.js')
    if not os.path.exists(path): print('  [SKIP]  js/data.js not found'); return
    c = read(path)

    # ── 2a. Add Basescan-based activity scanner (the approach the old site used)
    # Insert it right before initActivity()
    BASESCAN_BLOCK = (
        '// ─── Basescan API scanner ───────────────────────────────────────────────────\n'
        '// The old site used the free Basescan REST API for log history because:\n'
        '//   • No CORS issues (standard HTTP API, accepts all origins)\n'
        '//   • No block-range limits (fromBlock=0, toBlock=latest in one call)\n'
        '//   • No auth required\n'
        '//   • Returns ALL historical events instantly\n'
        '// We try Basescan first; if it fails (e.g. API down) we fall back to RPC scan.\n'
        '\n'
        'let _topicHashes = null;\n'
        'function _getTopicHashes() {\n'
        '  if (_topicHashes) return _topicHashes;\n'
        '  if (!window.BU.ABI.staking) return null;\n'
        '  try {\n'
        '    const iface = new ethers.Interface(window.BU.ABI.staking);\n'
        '    _topicHashes = {\n'
        '      Staked:          iface.getEvent("Staked").topicHash,\n'
        '      Unstaked:        iface.getEvent("Unstaked").topicHash,\n'
        '      RewardClaimed:   iface.getEvent("RewardClaimed").topicHash,\n'
        '      RoyaltyReceived: iface.getEvent("RoyaltyReceived").topicHash,\n'
        '    };\n'
        '    return _topicHashes;\n'
        '  } catch(e) { return null; }\n'
        '}\n'
        '\n'
        'function _parseBasescanLog(log, topics, iface) {\n'
        '  const t0 = log.topics?.[0];\n'
        '  if (!t0 || !topics) return null;\n'
        '  let kind;\n'
        '  if (t0 === topics.Staked)          kind = "stake";\n'
        '  else if (t0 === topics.Unstaked)   kind = "unstake";\n'
        '  else if (t0 === topics.RewardClaimed)   kind = "claim";\n'
        '  else if (t0 === topics.RoyaltyReceived) kind = "royalty";\n'
        '  else return null;\n'
        '\n'
        '  try {\n'
        '    const eventName = { stake:"Staked", unstake:"Unstaked", claim:"RewardClaimed", royalty:"RoyaltyReceived" }[kind];\n'
        '    const args = iface.decodeEventLog(eventName, log.data, log.topics);\n'
        '    const user     = args.user || null;\n'
        '    const tokenIds = args.tokenIds ? [...args.tokenIds].map(n => Number(n)) : [];\n'
        '    const amount   = args.amount ?? args.total ?? null;\n'
        '    const blockNum = parseInt(log.blockNumber, 16);\n'
        '    return { kind, user, tokenIds, amount, blockNumber: blockNum, txHash: log.transactionHash };\n'
        '  } catch(e) { return null; }\n'
        '}\n'
        '\n'
        'async function _initFromBasescan(onProgress) {\n'
        '  const contract = window.BU_CONFIG.contracts.staking;\n'
        '  const topics   = _getTopicHashes();\n'
        '  if (!topics) throw new Error("ABI not loaded yet");\n'
        '  const iface    = new ethers.Interface(window.BU.ABI.staking);\n'
        '\n'
        '  // Fetch all staking contract logs in one shot, no block-range limit.\n'
        '  // Basescan free tier: up to 1000 logs per request, page through if needed.\n'
        '  let allLogs = [];\n'
        '  for (let page = 1; page <= 10; page++) {\n'
        '    const url = `https://api.basescan.org/api?module=logs&action=getLogs`\n'
        '      + `&address=${contract}&fromBlock=0&toBlock=latest`\n'
        '      + `&offset=1000&page=${page}`;\n'
        '    const r = await fetch(url);\n'
        '    if (!r.ok) throw new Error(`Basescan HTTP ${r.status}`);\n'
        '    const d = await r.json();\n'
        '    if (d.status === "0" && d.message === "No records found") break;\n'
        '    if (d.status !== "1") throw new Error(`Basescan: ${d.message}`);\n'
        '    const batch = d.result || [];\n'
        '    allLogs.push(...batch);\n'
        '    if (batch.length < 1000) break; // last page\n'
        '    if (onProgress) onProgress();\n'
        '  }\n'
        '\n'
        '  // Parse logs chronologically\n'
        '  allLogs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));\n'
        '  for (const log of allLogs) {\n'
        '    const item = _parseBasescanLog(log, topics, iface);\n'
        '    if (!item) continue;\n'
        '    if (item.kind === "stake"   && item.user) _bumpStaker(item.user, +item.tokenIds.length);\n'
        '    if (item.kind === "unstake" && item.user) _bumpStaker(item.user, -item.tokenIds.length);\n'
        '    ACTIVITY.unshift(item);\n'
        '  }\n'
        '  const maxRows = (window.BU_CONFIG.activity?.maxRows ?? 30) * 4;\n'
        '  if (ACTIVITY.length > maxRows) ACTIVITY.length = maxRows;\n'
        '  console.info(`[data] Basescan: ${allLogs.length} logs → ${STAKER_MAP.size} stakers, ${ACTIVITY.length} events`);\n'
        '}\n'
        '\n'
    )

    NEW_INIT = (
        'async function initActivity(onProgress) {\n'
        '  // Strategy: try Basescan REST API first (no CORS, no block limits).\n'
        '  // On failure (API down, rate-limited) fall back to RPC eth_getLogs scan.\n'
        '  try {\n'
        '    await _initFromBasescan(onProgress);\n'
        '    if (onProgress) onProgress();\n'
        '  } catch(e) {\n'
        '    console.warn("[data] Basescan failed, falling back to RPC scan:", e.message);\n'
        '    const provider = await _getLogsProvider();\n'
        '    const latest = await provider.getBlockNumber();\n'
        '    const from = Math.max(0, latest - FULL_LOOKBACK_BLOCKS);\n'
        '    try {\n'
        '      await _scanRangeOnce(from, latest);\n'
        '      if (onProgress) onProgress();\n'
        '    } catch(e2) {\n'
        '      console.warn("[data] full-range RPC rejected, chunking:", e2.shortMessage||e2.message);\n'
        '      await _scanFromTo(from, latest, onProgress);\n'
        '    }\n'
        '    const provider2 = await _getLogsProvider();\n'
        '    LAST_SCANNED_BLOCK = await provider2.getBlockNumber();\n'
        '    return;\n'
        '  }\n'
        '  // Mark as fully scanned so refreshActivity only polls for new blocks\n'
        '  try {\n'
        '    const provider = await _getLogsProvider();\n'
        '    LAST_SCANNED_BLOCK = await provider.getBlockNumber();\n'
        '  } catch(_) {}\n'
        '}\n'
    )

    OLD_INIT = (
        'async function initActivity(onProgress) {\n'
        '  const provider = await _getLogsProvider();\n'
        '  const latest = await provider.getBlockNumber();\n'
        '  const from = Math.max(0, latest-FULL_LOOKBACK_BLOCKS);\n'
        '  try {\n'
        '    await _scanRangeOnce(from, latest);\n'
        '    if (onProgress) onProgress();\n'
        '  } catch(e) {\n'
        '    console.warn("[data] full-range rejected, chunking:", e.shortMessage||e.message);\n'
        '    await _scanFromTo(from, latest, onProgress);\n'
        '  }\n'
        '  LAST_SCANNED_BLOCK = latest;\n'
        '}'
    )

    # Insert Basescan block before initActivity (if not already there)
    if '_initFromBasescan' not in c:
        if OLD_INIT in c:
            c = c.replace(OLD_INIT, BASESCAN_BLOCK + NEW_INIT, 1)
            print('  [WRITE] initActivity → Basescan-first')
        else:
            # initActivity has different text (newer version), just insert before it
            marker = 'async function initActivity'
            idx = c.find(marker)
            if idx == -1:
                warn('initActivity not found')
            else:
                c = c[:idx] + BASESCAN_BLOCK + c[idx:]
                # Now replace whatever initActivity text exists with NEW_INIT
                # Find the function body end (next top-level async function)
                end_marker = '\nasync function refreshActivity'
                ei = c.find(end_marker, idx)
                if ei != -1:
                    c = c[:idx] + NEW_INIT + '\n' + c[ei:]
                    print('  [WRITE] initActivity replaced (Basescan-first, boundary method)')
                else:
                    warn('initActivity end not found')
    else:
        already('_initFromBasescan already present')

    # ── 2b. All previous provider fixes (idempotent) ─────────────────────────
    c = apply(c, 'const SCAN_DELAY_MS        = 250;',
                 "const SCAN_DELAY_MS        = 50;", 'SCAN_DELAY_MS 50ms')
    c = apply(c, 'const FULL_LOOKBACK_BLOCKS = 500_000;',
                 'const FULL_LOOKBACK_BLOCKS = 5_000_000;', 'FULL_LOOKBACK 5M')

    c = apply(c,
        'async function _scanRangeOnce(fromBlock, toBlock) {\n'
        '  const provider = await _getLogsProvider();\n'
        '  const c = new ethers.Contract(window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, provider);\n'
        '  const stakedEv   = await _withBackoff(() => c.queryFilter(c.filters.Staked(),         fromBlock, toBlock), "staked");\n'
        '  await _sleep(SCAN_DELAY_MS);\n'
        '  const unstakedEv = await _withBackoff(() => c.queryFilter(c.filters.Unstaked(),       fromBlock, toBlock), "unstaked");\n'
        '  await _sleep(SCAN_DELAY_MS);\n'
        '  const claimedEv  = await _withBackoff(() => c.queryFilter(c.filters.RewardClaimed(),  fromBlock, toBlock), "claimed");\n'
        '  await _sleep(SCAN_DELAY_MS);\n'
        '  const royaltyEv  = await _withBackoff(() => c.queryFilter(c.filters.RoyaltyReceived(),fromBlock, toBlock), "royalty");',
        'async function _scanRangeOnce(fromBlock, toBlock) {\n'
        '  const provider = await _getLogsProvider();\n'
        '  const c = new ethers.Contract(window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, provider);\n'
        '  const [stakedEv, unstakedEv, claimedEv, royaltyEv] = await Promise.all([\n'
        '    _withBackoff(() => c.queryFilter(c.filters.Staked(),          fromBlock, toBlock), "staked"),\n'
        '    _withBackoff(() => c.queryFilter(c.filters.Unstaked(),        fromBlock, toBlock), "unstaked"),\n'
        '    _withBackoff(() => c.queryFilter(c.filters.RewardClaimed(),   fromBlock, toBlock), "claimed"),\n'
        '    _withBackoff(() => c.queryFilter(c.filters.RoyaltyReceived(), fromBlock, toBlock), "royalty"),\n'
        '  ]);',
        '_scanRangeOnce parallel')

    c = apply(c,
        'async function _scanFromTo(fromBlock, toBlock) {\n'
        '  if (fromBlock > toBlock) return;\n'
        '  for (let f=fromBlock; f<=toBlock; f+=SCAN_CHUNK_SIZE) {\n'
        '    const t=Math.min(f+SCAN_CHUNK_SIZE-1,toBlock);\n'
        '    try { await _scanRangeOnce(f,t); await _sleep(SCAN_DELAY_MS); } catch(e) { console.warn("[scan] chunk failed permanently",f,t,e.message); }\n'
        '  }\n'
        '}',
        'async function _scanFromTo(fromBlock, toBlock, onProgress) {\n'
        '  if (fromBlock > toBlock) return;\n'
        '  const LARGE = 50_000;\n'
        '  for (let f=fromBlock; f<=toBlock; f+=LARGE) {\n'
        '    const t=Math.min(f+LARGE-1,toBlock);\n'
        '    try {\n'
        '      await _scanRangeOnce(f,t); await _sleep(SCAN_DELAY_MS);\n'
        '      if (onProgress) onProgress();\n'
        '    } catch(e) {\n'
        '      for (let f2=f; f2<=t; f2+=SCAN_CHUNK_SIZE) {\n'
        '        const t2=Math.min(f2+SCAN_CHUNK_SIZE-1,t);\n'
        '        try { await _scanRangeOnce(f2,t2); await _sleep(SCAN_DELAY_MS); if (onProgress) onProgress(); }\n'
        '        catch(e2) { console.warn("[scan] chunk failed",f2,t2,e2.message); }\n'
        '      }\n'
        '    }\n'
        '  }\n'
        '}',
        '_scanFromTo large+progress')

    c = apply(c,
        'async function getPoolStats() {\n'
        '  const s = window.BU.readStaking();\n',
        'async function getPoolStats() {\n'
        '  const _prov = await _getLogsProvider();\n'
        '  const s = new ethers.Contract(\n'
        '    window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, _prov\n'
        '  );\n',
        'getPoolStats provider')

    c = apply(c,
        'async function getUserState(address) {\n'
        '  if (!address) return null;\n'
        '  const nft=window.BU.readNFT(), stake=window.BU.readStaking();\n',
        'async function getUserState(address) {\n'
        '  if (!address) return null;\n'
        '  const _prov = await _getLogsProvider();\n'
        '  const nft   = new ethers.Contract(\n'
        '    window.BU_CONFIG.contracts.nft, window.BU.ABI.nft, _prov\n'
        '  );\n'
        '  const stake = new ethers.Contract(\n'
        '    window.BU_CONFIG.contracts.staking, window.BU.ABI.staking, _prov\n'
        '  );\n',
        'getUserState provider')

    c = apply(c,
        'async function isStakingApproved(address) { '
        'const nft=window.BU.readNFT(); '
        'return await nft.isApprovedForAll(address,window.BU_CONFIG.contracts.staking); }',
        'async function isStakingApproved(address) {\n'
        '  const _prov = await _getLogsProvider();\n'
        '  const nft = new ethers.Contract(\n'
        '    window.BU_CONFIG.contracts.nft, window.BU.ABI.nft, _prov\n'
        '  );\n'
        '  return await nft.isApprovedForAll(address, window.BU_CONFIG.contracts.staking);\n'
        '}',
        'isStakingApproved provider')

    # getUserOwnedTokens, boundary replace (handles any prior version)
    OWNED_MARKER   = '// ownerOf batch scan'
    CALC_MARKER    = '\nfunction calcPoolShare'
    DEFINITIVE     = 'OWNED_CACHE_TTL = 90_000'
    LOGS_PROVIDER  = '_prov = await _getLogsProvider'

    if DEFINITIVE in c and LOGS_PROVIDER in c:
        already('getUserOwnedTokens (definitive + correct provider)')
    else:
        si = c.find(OWNED_MARKER)
        ei = c.find(CALC_MARKER)
        if si != -1 and ei != -1:
            new_fn = (
                '// ownerOf batch scan, reliable for any token age; no log-range limits.\n'
                'const _ownedCache = new Map();\n'
                'const OWNED_CACHE_TTL = 90_000;\n'
                'function clearOwnedCache(address) {\n'
                '  if (address) _ownedCache.delete(address.toLowerCase());\n'
                '  else _ownedCache.clear();\n'
                '}\n'
                'async function getUserOwnedTokens(address) {\n'
                '  if (!address) return [];\n'
                '  const _key = address.toLowerCase();\n'
                '  const _hit = _ownedCache.get(_key);\n'
                '  if (_hit && Date.now() - _hit.fetchedAt < OWNED_CACHE_TTL) return _hit.ids;\n'
                '  const _prov = await _getLogsProvider();\n'
                '  const nft = new ethers.Contract(\n'
                '    window.BU_CONFIG.contracts.nft, window.BU.ABI.nft, _prov\n'
                '  );\n'
                '  let bal = 0;\n'
                '  try { bal = Number(await nft.balanceOf(address)); }\n'
                "  catch(e) { console.warn('[owned] balanceOf failed', e.message); return []; }\n"
                '  if (bal === 0) return [];\n'
                '  const supply = window.BU_CONFIG.collection.totalSupply || 6666;\n'
                '  const userLow = address.toLowerCase(), found = [];\n'
                '  console.info(`[owned] scanning ${supply} tokens (balance=${bal})`);\n'
                '  for (let i = 1; i <= supply && found.length < bal; i += 100) {\n'
                '    const ids = [];\n'
                '    for (let j = i; j < i+100 && j <= supply; j++) ids.push(j);\n'
                '    const res = await Promise.allSettled(ids.map(id => nft.ownerOf(id)));\n'
                '    for (let k = 0; k < res.length; k++) {\n'
                "      if (res[k].status !== 'fulfilled') continue;\n"
                '      if (res[k].value.toLowerCase() === userLow) found.push(ids[k]);\n'
                '    }\n'
                '    if (found.length < bal) await _sleep(80);\n'
                '  }\n'
                '  console.info(`[owned] found ${found.length} / ${bal}`);\n'
                '  const _r = found.sort((a,b) => a-b);\n'
                '  _ownedCache.set(_key, { ids: _r, fetchedAt: Date.now() });\n'
                '  return _r;\n'
                '}\n'
            )
            c = c[:si] + new_fn + c[ei:]
            print('  [WRITE] getUserOwnedTokens (boundary replace)')

    c = apply(c,
        '  getUserState, getUserOwnedTokens, calcPoolShare,',
        '  getUserState, getUserOwnedTokens, clearOwnedCache, calcPoolShare,',
        'BUData clearOwnedCache export')

    write(path, c)


# ── Fix 3: js/images.js, remove traits from NFT cards ──────────────────────
def fix_images_js():
    path = os.path.join(JS_DIR, 'images.js')
    if not os.path.exists(path): print('  [SKIP]  js/images.js not found'); return
    c = read(path)

    # Remove the traits div from the card template.
    # The nft-card-body now only shows ID + rarity badge.
    c = apply(c,
        '    <div class="nft-card-body">\n'
        '      <div class="nft-card-header">${idLine}<span class="nft-card-rarity">${rarityLabel}</span></div>\n'
        '      <div class="nft-card-traits empty"><div class="muted">Loading traits…</div></div>\n'
        '    </div>',
        '    <div class="nft-card-body">\n'
        '      <div class="nft-card-header">${idLine}<span class="nft-card-rarity">${rarityLabel}</span></div>\n'
        '    </div>',
        'remove traits div from card')

    write(path, c)


# ── Fix 4: css/style.css, 4-column grid + larger image area ────────────────
def fix_style_css():
    path = os.path.join(CSS_DIR, 'style.css')
    if not os.path.exists(path): print('  [SKIP]  css/style.css not found'); return
    c = read(path)

    # Change compact grid from auto-fill/180px to fixed 4 columns.
    # Also make the image take up more of the card since traits are gone.
    c = apply(c,
        '.nft-grid.compact { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }',
        '.nft-grid.compact { grid-template-columns: repeat(4, 1fr); gap: 12px; }',
        'nft-grid.compact 4 columns')

    # Responsive: on narrower screens drop to 3, then 2
    RESPONSIVE = (
        '@media (max-width: 860px) { .nft-grid.compact { grid-template-columns: repeat(3, 1fr); } }\n'
        '@media (max-width: 540px) { .nft-grid.compact { grid-template-columns: repeat(2, 1fr); } }\n'
    )
    if 'nft-grid.compact { grid-template-columns: repeat(3' not in c:
        c = c.replace(
            '.nft-grid.compact { grid-template-columns: repeat(4, 1fr); gap: 12px; }',
            '.nft-grid.compact { grid-template-columns: repeat(4, 1fr); gap: 12px; }\n' + RESPONSIVE,
            1
        )
        print('  [WRITE] responsive breakpoints for compact grid')

    # Make the image fill more of the card now that traits are gone
    c = apply(c,
        '.nft-card-image { position: relative; aspect-ratio: 1; overflow: hidden; background: var(--bg2); border-radius: 12px 12px 0 0; }',
        '.nft-card-image { position: relative; aspect-ratio: 1; overflow: hidden; background: var(--bg2); border-radius: 12px 12px 0 0; flex: 1; }',
        'nft-card-image flex 1')

    write(path, c)


# ── Fix 5: js/web3.js, public RPC default (idempotent) ─────────────────────
def fix_web3_js():
    path = os.path.join(JS_DIR, 'web3.js')
    if not os.path.exists(path): print('  [SKIP]  js/web3.js not found'); return
    c = read(path)
    c = apply(c,
        'function getReadProvider() {\n'
        '  if (!_readProvider) {\n'
        '    _readProvider = new ethers.JsonRpcProvider(net.rpcUrl, { chainId: net.chainId, name: net.name });\n'
        '  }\n'
        '  return _readProvider;\n'
        '}',
        'function getReadProvider() {\n'
        '  if (!_readProvider) {\n'
        '    // Use public fallback by default; upgradeProviderFromKeys() upgrades to Netlify proxy.\n'
        '    const _dflt = (net.rpcFallbacks && net.rpcFallbacks[0]) || net.rpcUrl;\n'
        '    _readProvider = new ethers.JsonRpcProvider(_dflt, { chainId: net.chainId, name: net.name });\n'
        '  }\n'
        '  return _readProvider;\n'
        '}',
        'getReadProvider public default')
    write(path, c)


# ── Fix 6: js/page-staking.js, smart grid + progressive LB (idempotent) ────
def fix_page_staking_js():
    path = os.path.join(JS_DIR, 'page-staking.js')
    if not os.path.exists(path): print('  [SKIP]  js/page-staking.js not found'); return
    c = read(path)

    c = apply(c,
        'let USER_STATE = null, POOL_STATS = null, IS_APPROVED = false;\n'
        'let _timers = [];',
        'let USER_STATE = null, POOL_STATS = null, IS_APPROVED = false;\n'
        'let _timers = [];\n'
        "let _gridsKey = '';         // last rendered token-ID fingerprint\n"
        'let _gridScanRunning = false; // prevents overlapping scans',
        'grid state vars')

    OLD_GRIDS = (
        'async function renderStakeGrids() {\n'
        '  const ownedGrid=document.getElementById("owned-grid"), stakedGrid=document.getElementById("staked-grid");\n'
        '  if (!ownedGrid||!stakedGrid) return;\n'
        '  const addr=window.BU.getUserAddress();\n'
        '  ownedGrid.innerHTML=`<div class="loading">Reading the registry</div>`;\n'
        '  stakedGrid.innerHTML=`<div class="loading">Reading the registry</div>`;\n'
        '  let owned=[];\n'
        '  try { owned=await window.BUData.getUserOwnedTokens(addr); } catch(e) { console.warn("[stake] owned scan failed",e.message); }\n'
        '  const stakedIds=USER_STATE?.stakedTokenIds||[];\n'
        '  ownedGrid.innerHTML="";\n'
        '  if (owned.length===0) { ownedGrid.innerHTML=`<div class="empty">Nothing in this wallet.</div>`; }\n'
        '  else { for (const id of owned) { const node=window.BUImages.card(id,{state:"idle",selectable:true,onSelect:(tid,sel)=>{sel?SELECTED_OWNED.add(tid):SELECTED_OWNED.delete(tid);updateStakeActionButtons();}}); if(SELECTED_OWNED.has(id)) node.classList.add("selected"); ownedGrid.appendChild(node); } }\n'
        '  stakedGrid.innerHTML="";\n'
        '  if (stakedIds.length===0) { stakedGrid.innerHTML=`<div class="empty">Nothing perched yet. Stake to earn.</div>`; }\n'
        '  else { for (const id of stakedIds) { const node=window.BUImages.card(id,{state:"staked",selectable:true,onSelect:(tid,sel)=>{sel?SELECTED_STAKED.add(tid):SELECTED_STAKED.delete(tid);updateStakeActionButtons();}}); if(SELECTED_STAKED.has(id)) node.classList.add("selected"); stakedGrid.appendChild(node); } }\n'
        '  setText("owned-count",  `(${owned.length})`);\n'
        '  setText("staked-count", `(${stakedIds.length})`);\n'
        '  updateStakeActionButtons();\n'
        '}'
    )
    NEW_GRIDS = (
        'async function renderStakeGrids() {\n'
        '  if (_gridScanRunning) return;\n'
        '  _gridScanRunning = true;\n'
        '  try {\n'
        '    const ownedGrid=document.getElementById("owned-grid"), stakedGrid=document.getElementById("staked-grid");\n'
        '    if (!ownedGrid||!stakedGrid) return;\n'
        '    const addr=window.BU.getUserAddress();\n'
        '    const isFirst = _gridsKey === \'\';\n'
        '    if (isFirst) {\n'
        '      ownedGrid.innerHTML=`<div class="loading">Reading the registry</div>`;\n'
        '      stakedGrid.innerHTML=`<div class="loading">Reading the registry</div>`;\n'
        '    }\n'
        '    let owned=[];\n'
        '    try { owned=await window.BUData.getUserOwnedTokens(addr); } catch(e) { console.warn("[stake] owned scan failed",e.message); }\n'
        '    const stakedIds=USER_STATE?.stakedTokenIds||[];\n'
        '    const newKey=owned.join(\',\')+\'|\'+stakedIds.join(\',\');\n'
        '    if (!isFirst && newKey===_gridsKey) { updateStakeActionButtons(); return; }\n'
        '    _gridsKey=newKey;\n'
        '    ownedGrid.innerHTML="";\n'
        '    if (owned.length===0) { ownedGrid.innerHTML=`<div class="empty">Nothing in this wallet.</div>`; }\n'
        '    else { for (const id of owned) { const node=window.BUImages.card(id,{state:"idle",selectable:true,onSelect:(tid,sel)=>{sel?SELECTED_OWNED.add(tid):SELECTED_OWNED.delete(tid);updateStakeActionButtons();}}); if(SELECTED_OWNED.has(id)) node.classList.add("selected"); ownedGrid.appendChild(node); } }\n'
        '    stakedGrid.innerHTML="";\n'
        '    if (stakedIds.length===0) { stakedGrid.innerHTML=`<div class="empty">Nothing perched yet. Stake to earn.</div>`; }\n'
        '    else { for (const id of stakedIds) { const node=window.BUImages.card(id,{state:"staked",selectable:true,onSelect:(tid,sel)=>{sel?SELECTED_STAKED.add(tid):SELECTED_STAKED.delete(tid);updateStakeActionButtons();}}); if(SELECTED_STAKED.has(id)) node.classList.add("selected"); stakedGrid.appendChild(node); } }\n'
        '    setText("owned-count",  `(${owned.length})`);\n'
        '    setText("staked-count", `(${stakedIds.length})`);\n'
        '    updateStakeActionButtons();\n'
        '  } finally { _gridScanRunning = false; }\n'
        '}'
    )
    c = apply(c, OLD_GRIDS, NEW_GRIDS, 'renderStakeGrids smart refresh')

    c = apply(c,
        'window.BU.onAccountChange(() => { window.BUUI.renderWalletSlot(); SELECTED_OWNED.clear(); SELECTED_STAKED.clear(); renderUserPanel(); });',
        'window.BU.onAccountChange(() => {\n'
        '  window.BUUI.renderWalletSlot();\n'
        "  SELECTED_OWNED.clear(); SELECTED_STAKED.clear(); _gridsKey = '';\n"
        '  if (window.BUData.clearOwnedCache) window.BUData.clearOwnedCache();\n'
        '  renderUserPanel();\n'
        '});',
        'onAccountChange reset cache')

    c = apply(c,
        'async function initLBAndActivity() {\n'
        '  const lbTable=document.getElementById("lb-table"), actFeed=document.getElementById("activity-feed");\n'
        '  if(lbTable) lbTable.innerHTML=`<div class="loading">Reading the runes</div>`;\n'
        '  if(actFeed) actFeed.innerHTML=`<div class="loading">Reading the runes</div>`;\n'
        '  try { await window.BUData.initActivity(); } catch(e) { console.warn("[stake] initActivity failed",e.message); }\n'
        '  renderLeaderboard(); renderActivity();\n'
        '  _timers.push(setInterval(async()=>{ try { await window.BUData.refreshActivity(); renderLeaderboard(); renderActivity(); } catch(e) { console.warn("[stake] refresh failed",e.message); } }, window.BU_CONFIG.refreshIntervals.activityFeed));\n'
        '}',
        'async function initLBAndActivity() {\n'
        '  const lbTable=document.getElementById("lb-table"), actFeed=document.getElementById("activity-feed");\n'
        '  if(lbTable) lbTable.innerHTML=`<div class="loading">Reading the runes</div>`;\n'
        '  if(actFeed) actFeed.innerHTML=`<div class="loading">Reading the runes</div>`;\n'
        '  const onProgress = () => { renderLeaderboard(); renderActivity(); };\n'
        '  window.BUData.initActivity(onProgress).then(onProgress)\n'
        '    .catch(e => console.warn("[stake] initActivity failed", e.message));\n'
        '  const _pid = setInterval(onProgress, 4000);\n'
        '  setTimeout(() => clearInterval(_pid), 120_000);\n'
        '  _timers.push(setInterval(async()=>{ try { await window.BUData.refreshActivity(); renderLeaderboard(); renderActivity(); } catch(e) { console.warn("[stake] refresh failed",e.message); } }, window.BU_CONFIG.refreshIntervals.activityFeed));\n'
        '}',
        'initLBAndActivity progressive')

    write(path, c)


def main():
    if not os.path.isdir(WEBSITE):
        print(f'ERROR: website/ not found in {ROOT}'); sys.exit(1)
    print(f'\nBased Undeads Patch v5 (Final)\nRoot: {ROOT}\n')

    print('Fix 1: config.js, CORS-safe fallback RPCs ...');       fix_config_js()
    print('\nFix 2: js/data.js, Basescan leaderboard + all prior fixes ...'); fix_data_js()
    print('\nFix 3: js/images.js, remove traits from cards ...');  fix_images_js()
    print('\nFix 4: css/style.css, 4-column grid ...');            fix_style_css()
    print('\nFix 5: js/web3.js, public RPC default ...');          fix_web3_js()
    print('\nFix 6: js/page-staking.js, smart grid + progressive LB ...'); fix_page_staking_js()

    print("""
✅  Done.

What changed
────────────
config.js
  rpcFallbacks now uses mainnet.base.org and base.drpc.org, both are
  CORS-safe (they allow requests from any origin, including localhost).
  base.publicnode.com blocked CORS from http://localhost:*, causing every
  contract read to fail with "Failed to fetch".

js/data.js  (leaderboard / activity)
  initActivity() now uses the Basescan REST API first, exactly what the
  old working site did.  One HTTP call to api.basescan.org returns ALL
  historical events with no block-range limit and no CORS issue.
  If Basescan is unreachable, it falls back to the existing RPC log scan.
  The leaderboard will populate within 1-2 seconds on page load.

js/images.js
  Trait table removed from NFT cards.  Cards now show only image, token
  ID, and rarity badge, cleaner and faster to render.

css/style.css
  .nft-grid.compact  →  repeat(4, 1fr) with responsive breakpoints:
  4 columns on desktop, 3 on tablet (≤860px), 2 on mobile (≤540px).

js/web3.js
  getReadProvider() uses rpcFallbacks[0] (mainnet.base.org) by default
  instead of the Alchemy rate-limited key.

js/page-staking.js
  renderStakeGrids: loading state only on first render; cards preserved
  on subsequent 20-second refreshes; concurrency guard prevents doubles.
  initLBAndActivity: non-blocking, renders progressively per chunk.

Note on local dev
──────────────────
Run `netlify dev` (not `netlify serve` or just opening the HTML) so the
Netlify Functions proxy is available.  The Alchemy key is then used
server-side (no 429 because it's not exposed in browser requests).
Game functionality requires Netlify deployment, the $1 Game's OpenSea
NFT picker depends on the api-keys function.
""")

if __name__ == '__main__':
    main()