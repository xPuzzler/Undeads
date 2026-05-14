// js/web3.js, BasedUndeads Web3 layer
const cfg = window.BU_CONFIG;
const net = cfg.activeNetwork;
const ABI = { nft: null, staking: null, renderer: null };

async function loadABIs() {
  const fetchJSON = async (p) => {
    const r = await fetch(p, { cache: "force-cache" });
    if (!r.ok) throw new Error(`ABI fetch failed: ${p} (${r.status})`);
    const data = await r.json();
    // Handle Hardhat artifact format: { abi: [...] } → plain array
    return Array.isArray(data) ? data : (data.abi || data);
  };
  [ABI.nft, ABI.staking, ABI.renderer] = await Promise.all([
    fetchJSON("./abi/nft.json"),
    fetchJSON("./abi/staking.json"),
    fetchJSON("./abi/renderer.json"),
  ]);
}

let _readProvider = null;
function getReadProvider() {
  if (!_readProvider) {
    // Use the Alchemy URL from config.js, it has correct CORS headers and works
    // on localhost and in production. upgradeProviderFromKeys() will later swap
    // this for the private Netlify proxy when the Alchemy key is available.
    _readProvider = new ethers.JsonRpcProvider(net.rpcUrl, { chainId: net.chainId, name: net.name });
  }
  return _readProvider;
}
function _setReadProvider(url) {
  try {
    _readProvider = new ethers.JsonRpcProvider(url, { chainId: net.chainId, name: net.name });
    net.rpcUrl = url; return true;
  } catch (e) { return false; }
}

async function upgradeProviderFromKeys() {
  let hasFunctions = false, apiKeysData = null;
  try {
    const r = await fetch("/.netlify/functions/api-keys", { cache: "no-store" });
    if (r.ok) { hasFunctions = true; apiKeysData = await r.json(); }
  } catch (e) {}
  if (!hasFunctions) { console.log("[web3] no Netlify functions; using public RPC"); return false; }
  if (apiKeysData?.apiKeys?.alchemy) {
    try {
      const probe = await fetch("/.netlify/functions/rpc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (probe.ok) { const d = await probe.json(); if (d?.result) { _setReadProvider(window.location.origin + "/.netlify/functions/rpc"); console.log("[web3] using Netlify rpc proxy"); return true; } }
    } catch (e) {}
    const url = `https://base-mainnet.g.alchemy.com/v2/${apiKeysData.apiKeys.alchemy}`;
    _setReadProvider(url); console.log("[web3] using Alchemy private endpoint"); return true;
  }
  return false;
}

let _signer = null, _userAddress = null, _walletProvider = null;
const _listeners = new Set();
function onAccountChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function _notify() { for (const fn of _listeners) try { fn(_userAddress); } catch {} }
function getUserAddress() { return _userAddress; }
function isConnected()    { return !!_userAddress; }
function getSigner()      { return _signer; }

function getInjectedProviders() {
  const out = [];
  if (typeof window.ethereum === "undefined") return out;
  if (window.ethereum.providers && Array.isArray(window.ethereum.providers)) {
    for (const p of window.ethereum.providers) out.push(classifyProvider(p));
  } else { out.push(classifyProvider(window.ethereum)); }
  return out.filter(Boolean);
}
function classifyProvider(p) {
  if (!p) return null;
  let name = "Browser Wallet", icon = "wallet";
  if (p.isMetaMask && !p.isRabby && !p.isCoinbaseWallet && !p.isBraveWallet) { name = "MetaMask"; icon = "metamask"; }
  if (p.isCoinbaseWallet) { name = "Coinbase Wallet"; icon = "coinbase"; }
  if (p.isRabby) { name = "Rabby"; icon = "rabby"; }
  if (p.isBraveWallet) { name = "Brave Wallet"; icon = "brave"; }
  return { provider: p, name, icon };
}

async function connectWallet(injectedProvider) {
  if (!injectedProvider) {
    const list = getInjectedProviders();
    if (list.length === 0) throw new Error("No wallet detected.");
    injectedProvider = list[0].provider;
  }
  const accounts = await injectedProvider.request({ method: "eth_requestAccounts" });
  if (!accounts || accounts.length === 0) throw new Error("No accounts returned");
  const currentChainHex = await injectedProvider.request({ method: "eth_chainId" });
  if (parseInt(currentChainHex, 16) !== net.chainId) {
    try {
      await injectedProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: net.chainIdHex }] });
    } catch (err) {
      if (err.code === 4902 || /unrecognized/i.test(err.message || "")) {
        await injectedProvider.request({ method: "wallet_addEthereumChain", params: [{ chainId: net.chainIdHex, chainName: net.name, rpcUrls: [net.rpcUrl], nativeCurrency: { name: "Ether", symbol: net.currency, decimals: 18 }, blockExplorerUrls: [net.explorerUrl] }] });
      } else { throw err; }
    }
  }
  _walletProvider = new ethers.BrowserProvider(injectedProvider, "any");
  _signer = await _walletProvider.getSigner();
  _userAddress = await _signer.getAddress();
  injectedProvider.on("accountsChanged", (accs) => {
    if (!accs || accs.length === 0) disconnectWallet();
    else { _userAddress = ethers.getAddress(accs[0]); _notify(); }
  });
  injectedProvider.on("chainChanged", () => window.location.reload());
  injectedProvider.on("disconnect", () => disconnectWallet());
  try { localStorage.setItem("bu_last_wallet", "1"); } catch {}
  _notify(); return _userAddress;
}

function disconnectWallet() {
  _signer = null; _userAddress = null; _walletProvider = null;
  try { localStorage.removeItem("bu_last_wallet"); } catch {}
  _notify();
}

async function tryEagerConnect() {
  try {
    if (typeof window.ethereum === "undefined") return;
    if (localStorage.getItem("bu_last_wallet") !== "1") return;
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts && accounts.length > 0) await connectWallet(window.ethereum);
  } catch (e) { console.warn("[web3] eager connect failed", e.message); }
}

function readNFT()      { return new ethers.Contract(cfg.contracts.nft,      ABI.nft,      getReadProvider()); }
function readStaking()  { return new ethers.Contract(cfg.contracts.staking,  ABI.staking,  getReadProvider()); }
function readRenderer() { return new ethers.Contract(cfg.contracts.renderer, ABI.renderer, getReadProvider()); }
function writeNFT()     { return _signer ? new ethers.Contract(cfg.contracts.nft,     ABI.nft,     _signer) : null; }
function writeStaking() { return _signer ? new ethers.Contract(cfg.contracts.staking, ABI.staking, _signer) : null; }

function shortAddr(addr, n = 4) { if (!addr) return ""; return addr.slice(0, 2 + n) + "…" + addr.slice(-n); }
function explorerTx(hash)      { return `${net.explorerUrl}/tx/${hash}`; }
function explorerAddr(address) { return `${net.explorerUrl}/address/${address}`; }
function isValidAddr(addr) {
  if (!addr) return false;
  if (addr === "0x0000000000000000000000000000000000000000") return false;
  try { ethers.getAddress(addr); return true; } catch { return false; }
}
function configIsLive() {
  return isValidAddr(cfg.contracts.nft) && isValidAddr(cfg.contracts.staking) && isValidAddr(cfg.contracts.renderer);
}

window.BU = {
  cfg, net, ABI, loadABIs, getReadProvider, getSigner, getUserAddress, isConnected,
  connectWallet, disconnectWallet, tryEagerConnect, onAccountChange, getInjectedProviders,
  readNFT, readStaking, readRenderer, writeNFT, writeStaking,
  shortAddr, explorerTx, explorerAddr, isValidAddr, configIsLive, upgradeProviderFromKeys,
};