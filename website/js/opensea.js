// js/opensea.js, OpenSea v2 API integration
const OS = {
  apiHost:        "https://api.opensea.io",
  webBase:        "https://opensea.io/assets/base",
  collectionUrl:  "https://opensea.io/collection/basedundeads/overview",
  collectionSlug: "basedundeads",
  apiKey:         null,
};
const NFT_CONTRACT = (window.BU_CONFIG?.contracts?.nft || "").toLowerCase();

async function loadOpenSeaKey() {
  try {
    const r = await fetch("/.netlify/functions/api-keys", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    if (d.apiKeys?.opensea) { OS.apiKey = Array.isArray(d.apiKeys.opensea) ? d.apiKeys.opensea[0] : d.apiKeys.opensea; console.log("[opensea] API key loaded"); }
  } catch(e) { console.warn("[opensea] no API key proxy available, using public API (limited)"); }
}
function _headers() { const h = { accept: "application/json" }; if (OS.apiKey) h["x-api-key"] = OS.apiKey; return h; }
function _timeAgo(ts) {
  const d = Math.floor(Date.now()/1000)-ts;
  if (d<60) return `${d}s ago`; if (d<3600) return `${Math.floor(d/60)}m ago`;
  if (d<86400) return `${Math.floor(d/3600)}h ago`; return `${Math.floor(d/86400)}d ago`;
}
function _placeholder(tokenId) {
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 220'><rect width='220' height='220' fill='%230a0c10'/><text x='110' y='118' text-anchor='middle' fill='%234ed98a' font-family='monospace' font-size='28' font-weight='600'>%23${tokenId}</text></svg>`;
}

async function loadSales(days) {
  const after = Math.floor((Date.now()/1000)-days*86400);
  const events = []; let next = null;
  const maxPages = days===1 ? 3 : 6;
  for (let page=0; page<maxPages; page++) {
    const params = new URLSearchParams({ event_type:"sale", after:after.toString(), limit:"50" });
    if (next) params.append("next", next);
    try {
      const url = `${OS.apiHost}/api/v2/events/collection/${OS.collectionSlug}?${params}`;
      const r = await fetch(url, { headers: _headers() }); if (!r.ok) break;
      const d = await r.json(); if (d.asset_events) events.push(...d.asset_events);
      next = d.next; if (!next) break;
      await new Promise(res => setTimeout(res, 200));
    } catch(e) { console.warn("[opensea sales]", e.message); break; }
  }
  return events;
}

function renderSaleCard(ev) {
  const nft=ev.nft||{}, tokenId=nft.identifier||"?", img=nft.image_url||nft.display_image_url||_placeholder(tokenId);
  const name=nft.name||`Undead #${tokenId}`, payment=ev.payment||{};
  const price=payment.quantity?(parseFloat(payment.quantity)/Math.pow(10,payment.decimals||18)).toFixed(4):"—";
  const symbol=payment.symbol||"ETH";
  const openseaUrl=NFT_CONTRACT?`${OS.webBase}/${NFT_CONTRACT}/${tokenId}`:OS.collectionUrl;
  const ts=ev.event_timestamp||ev.closing_date||Math.floor(Date.now()/1000);
  return `<a href="${openseaUrl}" target="_blank" rel="noopener" class="sale-card"><img src="${img}" alt="${name}" loading="lazy" onerror="this.src='${_placeholder(tokenId).replace(/'/g,"%27")}'"><span class="sale-card-badge">SOLD</span><div class="sale-card-body"><div class="sale-card-id">#${tokenId}</div><div class="sale-card-price">${price} ${symbol}</div><div class="sale-card-time">${_timeAgo(ts)}</div></div></a>`;
}

async function renderSalesForRange(days) {
  const events = await loadSales(days);
  let totalVolume=0; const uniqueBuyers=new Set();
  for (const ev of events) {
    const p=ev.payment||{}; if (p.quantity) totalVolume+=parseFloat(p.quantity)/Math.pow(10,p.decimals||18);
    if (ev.buyer) uniqueBuyers.add(ev.buyer.toLowerCase());
  }
  const count=events.length;
  const setText=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  if (days===1) {
    setText("stat-1d-count", count||"0"); setText("stat-1d-volume", totalVolume.toFixed(3));
    setText("stat-1d-avg", count>0?(totalVolume/count).toFixed(4)+" Ξ":"—");
    const scroller=document.getElementById("salesScroller1d");
    if (scroller) { scroller.innerHTML = count===0?`<div class="sales-loading">No sales in the last 24 hours.</div>`:events.slice(0,30).map(renderSaleCard).join(""); }
  } else if (days===7) {
    setText("stat-7d-count",count); setText("stat-7d-volume",totalVolume.toFixed(2)+" Ξ"); setText("stat-7d-unique",uniqueBuyers.size);
  } else if (days===30) {
    setText("stat-30d-count",count); setText("stat-30d-volume",totalVolume.toFixed(2)+" Ξ"); setText("stat-30d-unique",uniqueBuyers.size);
  }
}

async function loadCollectionStats() {
  try {
    const r=await fetch(`${OS.apiHost}/api/v2/collections/${OS.collectionSlug}/stats`,{headers:_headers()});
    if (!r.ok) return;
    const d=await r.json();
    const floor=d.total?.floor_price??d.intervals?.[0]?.floor_price;
    if (floor) { const el=document.getElementById("stat-1d-floor"); if (el) el.textContent=parseFloat(floor).toFixed(4)+" Ξ"; }
  } catch(e) { console.warn("[opensea stats]",e.message); }
}

async function loadFloorListings() {
  const grid=document.getElementById("floorGrid"); if (!grid) return;
  try {
    const r=await fetch(`${OS.apiHost}/api/v2/listings/collection/${OS.collectionSlug}/all?limit=20`,{headers:_headers()});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json(), listings=d.listings||[];
    if (listings.length===0) { grid.innerHTML=`<div class="sales-loading" style="grid-column:1/-1">No active listings.</div>`; return; }
    // Deduplicate: one entry per tokenId, keeping the cheapest listing.
    // OpenSea returns multiple listings per token (re-lists, competing orders).
    const priceMap = new Map();
    for (const l of listings) {
      const offer = l.protocol_data?.parameters?.offer?.[0];
      const tokenId = offer?.identifierOrCriteria;
      if (!tokenId) continue;
      const consideration = l.protocol_data?.parameters?.consideration || [];
      let totalWei = 0n;
      for (const c of consideration) { try { totalWei += BigInt(c.startAmount); } catch(e) {} }
      const priceEth = Number(totalWei) / 1e18;
      // Keep cheapest listing per token
      if (!priceMap.has(tokenId) || priceEth < priceMap.get(tokenId).priceEth) {
        priceMap.set(tokenId, { tokenId, priceEth });
      }
    }
    const withPrices = [...priceMap.values()]
      .filter(x => x.priceEth > 0)
      .sort((a, b) => a.priceEth - b.priceEth)
      .slice(0, 15);
    grid.innerHTML=withPrices.map(item=>{
      const url=NFT_CONTRACT?`${OS.webBase}/${NFT_CONTRACT}/${item.tokenId}`:OS.collectionUrl;
      return `<a href="${url}" target="_blank" rel="noopener" class="floor-item" data-token="${item.tokenId}"><div class="floor-item-image"><img src="${_placeholder(item.tokenId).replace(/'/g,"%27")}" alt="Undead #${item.tokenId}" data-token="${item.tokenId}" loading="lazy"></div><div class="floor-item-arrow">↗</div><div class="floor-item-body"><div class="floor-item-id">#${item.tokenId}</div><div class="floor-item-price">${item.priceEth.toFixed(4)} Ξ</div></div></a>`;
    }).join("");
    if (window.BUImages?.get) {
      withPrices.forEach(async item => {
        try { const src=await window.BUImages.get(item.tokenId); if (!src) return; const img=grid.querySelector(`img[data-token="${item.tokenId}"]`); if (img) img.src=src; } catch {}
      });
    }
  } catch(e) {
    console.warn("[opensea listings]",e.message);
    grid.innerHTML=`<div class="sales-loading" style="grid-column:1/-1">Listings unavailable. <a href="${OS.collectionUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">View on OpenSea →</a></div>`;
  }
}

function bindSalesTabs() {
  const tabs=document.querySelectorAll(".sales-tab");
  tabs.forEach(tab=>{
    tab.addEventListener("click", ()=>{
      const range=tab.dataset.range;
      tabs.forEach(t=>t.classList.remove("active")); tab.classList.add("active");
      document.querySelectorAll(".sales-panel").forEach(p=>p.classList.remove("active"));
      const panel=document.getElementById(`salesPanel-${range}`); if (panel) panel.classList.add("active");
    });
  });
}

window.BUOpenSea = { loadOpenSeaKey, renderSalesForRange, loadCollectionStats, loadFloorListings, bindSalesTabs, OS };
