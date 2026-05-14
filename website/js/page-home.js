// js/page-home.js, BU Home page renderer
(async function homePage() {
  if (typeof ethers === "undefined") { console.error("ethers failed to load"); return; }
  window.BUUI.renderNetworkPill();
  window.BUUI.renderNavSocials();
  window.BUUI.bindMobileNav();
  window.BUUI.renderFooterAddresses();
  window.BUUI.bindFAQ();
  try { await window.BU.loadABIs(); } catch(e) { console.warn("[home] ABI load failed", e); }
  await window.BU.upgradeProviderFromKeys();
  await window.BU.tryEagerConnect();
  window.BUUI.renderWalletSlot();
  build3x3AboutGrid();
  buildMarquee("featured-marquee-top",    14, "left",  { excludeLegends: true });
  buildLegendsGrid();
  buildMarquee("featured-marquee-bottom", 14, "right", { excludeLegends: false });
  renderRoyaltyDonut();
  await window.BUOpenSea.loadOpenSeaKey();
  window.BUOpenSea.bindSalesTabs();
  window.BUOpenSea.renderSalesForRange(1);
  window.BUOpenSea.renderSalesForRange(7);
  window.BUOpenSea.renderSalesForRange(30);
  window.BUOpenSea.loadCollectionStats();
  window.BUOpenSea.loadFloorListings();
  initProjectsViewer();
  if (window.BU.configIsLive()) {
    refreshLiveStats();
    setInterval(refreshLiveStats, window.BU_CONFIG.refreshIntervals.stats);
  }
  window.BU.onAccountChange(() => window.BUUI.renderWalletSlot());
})();

async function refreshLiveStats() {
  try {
    const [supply, poolStats] = await Promise.all([window.BUData.getNFTSupply(), window.BUData.getPoolStats()]);
    setText("stat-supply",     window.BUUI.fmtNumber(supply));
    setText("stat-supply-sub", `of ${window.BUUI.fmtNumber(window.BU_CONFIG.collection.totalSupply)}`);
    setText("stat-staked",     window.BUUI.fmtNumber(poolStats.totalStaked));
    setText("stat-pool",       window.BUUI.fmtETH(poolStats.unclaimedPool) + " ETH");
    setText("stat-lifetime",   window.BUUI.fmtETH(poolStats.totalReceived) + " ETH");
    updateStatusBanner(poolStats);
  } catch(e) { console.warn("[home] stats refresh failed:", e.message); }
}

function updateStatusBanner(poolStats) {
  const banner = document.getElementById("status-banner"); if (!banner) return;
  const stakingOn = window.BU_CONFIG.stakingEnabled; let body;
  if (!stakingOn) { body = `Staking is preparing to go live. Get ready.`; }
  else if (poolStats.totalStaked === 0) { body = `Staking is <strong>live</strong>. Be the first to perch.`; }
  else { body = `<strong>${window.BUUI.fmtNumber(poolStats.totalStaked)}</strong> Undeads currently staked · <strong>${window.BUUI.fmtETH(poolStats.unclaimedPool)} ETH</strong> in the pool`; }
  banner.innerHTML = `<span class="sb-label">Status</span><span class="sb-status">${body}</span><a href="./staking.html" class="btn btn-sm btn-ghost" style="white-space:nowrap;">Stake</a>`;
}

function build3x3AboutGrid() {
  const grid = document.getElementById("about-undeads-grid"); if (!grid) return;
  const ids = window.BUImages.randomTokenIds(3, true); grid.innerHTML = "";
  for (const id of ids) grid.appendChild(window.BUImages.card(id, { openOnClick: true }));
}

function buildMarquee(containerId, count, direction, opts={}) {
  const container = document.getElementById(containerId); if (!container) return;
  const ids = window.BUImages.randomTokenIds(count, opts.excludeLegends);
  const track = document.createElement("div"); track.className = "marquee-track";
  const make = (id) => window.BUImages.card(id, { openOnClick: true });
  for (const id of ids) track.appendChild(make(id));
  for (const id of ids) track.appendChild(make(id));
  container.className = `marquee${direction==="right"?" marquee-right":""}`;
  container.innerHTML = ""; container.appendChild(track);
}

function buildLegendsGrid() {
  const grid = document.getElementById("legends-grid"); if (!grid) return;
  const ids = window.BUImages.legendIds(); grid.innerHTML = "";
  for (const id of ids) grid.appendChild(window.BUImages.card(id, { openOnClick:true, rarity:"legend", rarityLabel:"Legendary" }));
}

function renderRoyaltyDonut() {
  const wrap = document.getElementById("royalty-donut"); if (!wrap) return;
  const r = window.BU_CONFIG.collection.royalty, total=r.totalBps, poolPct=(r.toPoolBps/total)*100;
  const radius=80, stroke=26, c=2*Math.PI*radius, poolLen=(poolPct/100)*c;
  wrap.innerHTML = `<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="${radius}" fill="none" stroke="#8b1a1a" stroke-width="${stroke}"/><circle cx="100" cy="100" r="${radius}" fill="none" stroke="#4ed98a" stroke-width="${stroke}" stroke-dasharray="${poolLen} ${c-poolLen}"/></svg><div class="center"><div class="pct">${(total/100).toFixed(1).replace(/\.0$/,"")}%</div><div class="lbl">Royalty</div></div>`;
}

function initProjectsViewer() {
  const frame=document.getElementById("squiggleFrame"), replay=document.getElementById("squiggleReplay");
  const rand=document.getElementById("squiggleRandom"), fs=document.getElementById("squiggleFullscreen");
  const display=document.getElementById("squiggleTokenDisplay"), puzzle=document.getElementById("puzzleFrame");
  const puzzleNew=document.getElementById("puzzleNew");
  if (!frame) return;
  const SQUIGGLE_MAX=10000, randomId=()=>Math.floor(Math.random()*SQUIGGLE_MAX)+1;
  let tid=randomId();
  const setToken=(n)=>{ tid=n; frame.src=`https://squiggler.netlify.app/?tid=${n}`; if(display) display.textContent="#"+String(n).padStart(4,"0"); };
  setToken(tid);
  replay && replay.addEventListener("click", ()=>setToken(tid));
  rand   && rand.addEventListener("click",   ()=>setToken(randomId()));
  fs     && fs.addEventListener("click",     ()=>frame.requestFullscreen?.());
  puzzleNew && puzzleNew.addEventListener("click", ()=>{ if(puzzle) puzzle.src=puzzle.src; });
}

function setText(id,t) { const el=document.getElementById(id); if(el) el.textContent=t; }
