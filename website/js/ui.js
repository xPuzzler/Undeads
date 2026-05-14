// js/ui.js, UI utilities
function fmtETH(wei, decimals = 4) {
  if (wei == null) return "0";
  try {
    const s = ethers.formatEther(wei);
    const [w, frac = ""] = s.split(".");
    if (!frac) return w;
    return w + "." + (frac.slice(0, decimals).replace(/0+$/, "") || "0");
  } catch { return "0"; }
}
function fmtETHPrecise(wei) { if (wei == null) return "0"; try { return ethers.formatEther(wei); } catch { return "0"; } }
function fmtTime(seconds) {
  if (seconds <= 0) return "Ready";
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
function fmtRelativeTime(unixSec) {
  if (!unixSec) return "—";
  const now = Math.floor(Date.now() / 1000), d = now - unixSec;
  if (d < 60) return `${d}s ago`; if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`; return `${Math.floor(d/86400)}d ago`;
}
function fmtNumber(n) { if (n == null) return "0"; return Number(n).toLocaleString("en-US"); }

function ensureToastContainer() {
  let c = document.getElementById("toast-container");
  if (!c) { c = document.createElement("div"); c.id = "toast-container"; c.className = "toast-container"; document.body.appendChild(c); }
  return c;
}
function toast(opts) {
  if (typeof opts === "string") opts = { body: opts };
  const { title, body, kind = "info", link, linkLabel, duration = 5000 } = opts;
  const container = ensureToastContainer();
  const el = document.createElement("div"); el.className = `toast ${kind}`;
  if (title) { const t = document.createElement("div"); t.className = "toast-title"; t.textContent = title; el.appendChild(t); }
  if (body) { const b = document.createElement("div"); b.className = "toast-body"; b.textContent = body; el.appendChild(b); }
  if (link) { const a = document.createElement("a"); a.href = link; a.target = "_blank"; a.rel = "noopener"; a.textContent = linkLabel || "View on Explorer ↗"; el.appendChild(a); }
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(110%)"; el.style.transition = "all 0.3s"; setTimeout(() => el.remove(), 320); }, duration);
}
function explainError(err) {
  if (!err) return "Unknown error";
  if (err.code === 4001 || err.code === "ACTION_REJECTED" || /rejected/i.test(err.message || "")) return "Transaction rejected";
  const reason = err.reason || err.shortMessage || err.message || String(err);
  return reason.replace(/^execution reverted:?\s*/i, "").trim().slice(0, 220);
}
async function trackTx(label, txPromise) {
  try {
    const tx = await txPromise;
    toast({ title: label, body: "Submitted", kind: "info", link: window.BU.explorerTx(tx.hash) });
    const receipt = await tx.wait();
    toast({ title: label, body: "Confirmed onchain", kind: "success", link: window.BU.explorerTx(receipt.hash) });
    return receipt;
  } catch (e) { toast({ title: label, body: explainError(e), kind: "error" }); throw e; }
}

function walletIconSVG(kind) {
  if (kind === "metamask") return `<svg class="wallet-option-icon" viewBox="0 0 32 32"><path fill="#E2761B" d="M28 4 18 11l2-5z"/><path fill="#E4761B" d="M4 4l10 7-2-5zM24 22l-3 4 6 2 2-6zM2 22l2 6 6-2-3-4z"/><path fill="#D7C1B3" d="M9 14l-2 3 6 .5L13 14zM23 14l-4 .5.5 3 6-.5z"/><path fill="#233447" d="M10 26l4-2-3-2zM18 24l4 2v-4z"/></svg>`;
  if (kind === "coinbase") return `<svg class="wallet-option-icon" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0052FF"/><path fill="#fff" d="M16 9.5c-3.6 0-6.5 2.9-6.5 6.5s2.9 6.5 6.5 6.5 6.5-2.9 6.5-6.5-2.9-6.5-6.5-6.5zm-2 8.5v-4h4v4h-4z"/></svg>`;
  if (kind === "rabby") return `<svg class="wallet-option-icon" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7084FF"/><circle cx="16" cy="14" r="6" fill="#fff"/><circle cx="13" cy="13" r="1.5" fill="#7084FF"/><circle cx="19" cy="13" r="1.5" fill="#7084FF"/></svg>`;
  if (kind === "brave") return `<svg class="wallet-option-icon" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#F25E25"/><path fill="#fff" d="M16 6l-4 4-4-2v6l4 4 4 6 4-6 4-4V8l-4 2z"/></svg>`;
  return `<svg class="wallet-option-icon" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a3a1f"/><path fill="#00ff88" d="M8 12h16v8H8z"/><circle cx="22" cy="16" r="2" fill="#0a3a1f"/></svg>`;
}

function openWalletModal() {
  let overlay = document.getElementById("wallet-modal");
  if (overlay) { overlay.classList.add("open"); return; }
  overlay = document.createElement("div"); overlay.id = "wallet-modal"; overlay.className = "modal-overlay open";
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Close">×</button><div class="modal-head"><span class="eyebrow">Open The Crypt</span><h3>Connect Wallet</h3></div><div id="wallet-options" class="wallet-options"></div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });
  overlay.querySelector(".modal-close").addEventListener("click", () => overlay.classList.remove("open"));
  document.body.appendChild(overlay);
  const optionsEl = overlay.querySelector("#wallet-options");
  const providers = window.BU.getInjectedProviders();
  if (providers.length === 0) {
    optionsEl.innerHTML = `<div style="padding:8px 4px;color:var(--fg-2);font-family:var(--font-mono);font-size:11px;line-height:1.85;">No EVM wallet detected. Install one of:<br>· <a href="https://metamask.io" target="_blank" rel="noopener" style="color:var(--accent)">MetaMask</a><br>· <a href="https://www.coinbase.com/wallet" target="_blank" rel="noopener" style="color:var(--accent)">Coinbase Wallet</a><br>· <a href="https://rabby.io" target="_blank" rel="noopener" style="color:var(--accent)">Rabby</a></div>`;
    return;
  }
  for (const { provider, name, icon } of providers) {
    const btn = document.createElement("button"); btn.className = "wallet-option";
    btn.innerHTML = `${walletIconSVG(icon)}<span>${name}</span>`;
    btn.addEventListener("click", async () => {
      try {
        await window.BU.connectWallet(provider); overlay.classList.remove("open");
        toast({ title: "Connected", body: window.BU.shortAddr(window.BU.getUserAddress()), kind: "success" });
      } catch (e) { toast({ title: "Connect failed", body: explainError(e), kind: "error" }); }
    });
    optionsEl.appendChild(btn);
  }
}

function openNFTModal(tokenId) {
  let overlay = document.getElementById("nft-modal"); if (overlay) overlay.remove();
  const cfg = window.BU_CONFIG, openseaUrl = cfg.openseaUrl(tokenId);
  const explorerUrl = `${cfg.activeNetwork.explorerUrl}/token/${cfg.contracts.nft}?a=${tokenId}`;
  overlay = document.createElement("div"); overlay.id = "nft-modal"; overlay.className = "modal-overlay open";
  overlay.innerHTML = `<div class="modal nft-detail" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Close">×</button><div class="modal-head"><span class="eyebrow">BasedUndead</span><h3>#${String(tokenId).padStart(4,"0")}</h3></div><div id="nft-detail-card"></div><div class="modal-actions"><a href="${openseaUrl}" target="_blank" rel="noopener" class="btn btn-primary">View on OpenSea ↗</a><a href="${explorerUrl}" target="_blank" rel="noopener" class="btn btn-ghost">Explorer ↗</a></div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.classList.remove("open"); setTimeout(() => overlay.remove(), 250); } });
  overlay.querySelector(".modal-close").addEventListener("click", () => { overlay.classList.remove("open"); setTimeout(() => overlay.remove(), 250); });
  const cardWrap = overlay.querySelector("#nft-detail-card");
  const cardNode = window.BUImages.card(tokenId, { hideId: false }); cardNode.style.cursor = "default";
  cardWrap.appendChild(cardNode); document.body.appendChild(overlay);
  const onEsc = (e) => { if (e.key === "Escape") { overlay.classList.remove("open"); setTimeout(() => overlay.remove(), 250); document.removeEventListener("keydown", onEsc); } };
  document.addEventListener("keydown", onEsc);
}

function renderNavSocials() {
  const slot = document.getElementById("nav-socials-slot"); if (!slot) return;
  const s = window.BU_CONFIG.social || {};
  const openseaSVG = `<svg viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg"><path d="M45 0a45 45 0 1 0 45 45A45 45 0 0 0 45 0M22.2 46.5l.2-.3 12.3-19.3a.4.4 0 0 1 .7 0 36.5 36.5 0 0 1 3 18.6.4.4 0 0 1-.4.4H22.5a.3.3 0 0 1-.3-.5zm52.6 7.7v.4a17 17 0 0 1-1.5 2.2 14.6 14.6 0 0 0-2.4 4.9c-.3 1.7-.8 3.3-1.6 4.9-3 6-9.6 10.1-15.4 10.1H27.7c-8.6 0-15.6-6.9-15.6-15.5v-.3c0-.2.2-.3.4-.3h13.7c.2 0 .4.2.4.4 0 .9.3 1.7 1 2.3.6.6 1.5 1 2.3 1H37c2 0 3.7-1.7 3.7-3.8 0-2.1-1.7-3.8-3.7-3.8h-3.4l4 .1 3.5.1c2.5.1 5-1 6.4-3l.3-.4 7.6-11.3a.4.4 0 0 0 0-.4l-2.7-3.8a.3.3 0 0 1 0-.4l7.8-11.3a.3.3 0 0 1 .4 0c2 1.7 6 6.6 6.6 7.4l8.4 11.6a.3.3 0 0 1 0 .4l-2 2.8a.3.3 0 0 0 0 .4l3.4 4.3.3.3a.3.3 0 0 1 0 .4z" fill="currentColor"/></svg>`;
  const xSVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" fill="currentColor"/></svg>`;
  const discordSVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.07.07 0 0 0-.073.035 13.6 13.6 0 0 0-.612 1.262 18.3 18.3 0 0 0-5.487 0 12.6 12.6 0 0 0-.624-1.262.073.073 0 0 0-.073-.035A19.7 19.7 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.1 14.1 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10 10 0 0 0 .372-.292.075.075 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .079.009c.12.099.245.198.372.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.04.107c.36.698.771 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418m7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418" fill="currentColor"/></svg>`;
  const html = [];
  if (s.opensea) html.push(`<a class="nav-social" href="${s.opensea}" target="_blank" rel="noopener" aria-label="OpenSea">${openseaSVG}</a>`);
  if (s.twitter) html.push(`<a class="nav-social" href="${s.twitter}" target="_blank" rel="noopener" aria-label="X (Twitter)">${xSVG}</a>`);
  if (s.discord) html.push(`<a class="nav-social" href="${s.discord}" target="_blank" rel="noopener" aria-label="Discord">${discordSVG}</a>`);
  slot.innerHTML = html.join("");
}

function renderWalletSlot() {
  const slot = document.getElementById("wallet-slot"); if (!slot) return;
  slot.innerHTML = "";
  if (window.BU.isConnected()) {
    const addr = window.BU.getUserAddress();
    const el = document.createElement("button"); el.className = "wallet-connected"; el.title = "Click to disconnect";
    el.innerHTML = `<span class="dot"></span><span>${window.BU.shortAddr(addr)}</span>`;
    el.addEventListener("click", () => { if (confirm("Disconnect wallet?")) window.BU.disconnectWallet(); });
    slot.appendChild(el);
  } else {
    const btn = document.createElement("button"); btn.className = "wallet-btn"; btn.textContent = "Connect Wallet";
    btn.addEventListener("click", () => openWalletModal());
    slot.appendChild(btn);
  }
}

function renderNetworkPill() {
  const slot = document.getElementById("net-pill-slot"); if (!slot) return;
  slot.innerHTML = `<span class="net-pill">Base</span>`;
}

function bindMobileNav() {
  const nav = document.querySelector("nav.site-nav");
  const btn = document.querySelector(".mobile-toggle");
  if (!nav || !btn) return;
  btn.addEventListener("click", () => nav.classList.toggle("mobile-open"));
  nav.querySelectorAll(".nav-links a").forEach((a) => a.addEventListener("click", () => nav.classList.remove("mobile-open")));
}

function renderFooterAddresses() {
  const cfg = window.BU_CONFIG, net = cfg.activeNetwork;
  const fill = (id, addr) => {
    const el = document.getElementById(id); if (!el) return;
    if (!window.BU.isValidAddr(addr)) { el.textContent = "Not deployed"; return; }
    el.innerHTML = `<a href="${net.explorerUrl}/address/${addr}" target="_blank" rel="noopener">${addr.slice(0,6)}…${addr.slice(-4)}</a>`;
  };
  fill("footer-nft-addr",      cfg.contracts.nft);
  fill("footer-staking-addr",  cfg.contracts.staking);
  fill("footer-renderer-addr", cfg.contracts.renderer);
}

function bindFAQ() {
  document.querySelectorAll(".faq-item").forEach((item) => {
    const q = item.querySelector(".faq-question"); if (!q) return;
    q.addEventListener("click", () => item.classList.toggle("open"));
  });
}

window.BUUI = {
  fmtETH, fmtETHPrecise, fmtTime, fmtRelativeTime, fmtNumber,
  toast, explainError, trackTx,
  openWalletModal, openNFTModal,
  renderWalletSlot, renderNetworkPill, renderNavSocials,
  bindMobileNav, renderFooterAddresses, bindFAQ,
};
