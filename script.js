// ============================================
// BASED UNDEADS - REDESIGNED SCRIPT
// All original functionality preserved
// Enhanced with new features
// ============================================

let CONFIG = {
  ALCHEMY_API_KEY: null,
  OPENSEA_API_KEY: null,
  MORALIS_API_KEY: null,
  BASED_UNDEADS_CONTRACT: '0x4aec4eddfab595c04557f78178f0962e46a02989',
  BASE_CHAIN_ID: 8453
};

const RAFFLE_CONFIG = {
  PHASE: 3,
  PHASE_NAME: "Phase 4 - Based Undeads Giveaway",
  TOKEN_RANGE: { min: 3334, max: 4444 },
  TOTAL_WINNERS: 10,
  IS_ACTIVE: true,
  REWARD_OPENSEA_URLS: [
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/666",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/1302",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/1919",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/29",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/229",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/253",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/642",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/116",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/770",
    "https://opensea.io/assets/base/0x4aec4eddfab595c04557f78178f0962e46a02989/2182",
  ],
  REWARD_TOKENS: []
};

let raffleState = {
  eligibleTokens: [],
  allEligibleEntries: [],
  walletAddress: '',
  winners: [],
  isSpinning: false,
  eligibleNFTs: []
};

const SUPPORTED_CHAINS = {
  base: {
    name: 'Base',
    chainId: 8453,
    alchemyNetwork: 'base-mainnet',
    openSeaSlug: 'base',
    apiEndpoint: 'base',
    moralisChain: 'base',
    alchemyChain: 'base-mainnet'
  },
  apechain: {
    name: 'ApeChain',
    chainId: 33139,
    alchemyNetwork: 'apechain-mainnet',
    openSeaSlug: 'ape_chain',
    apiEndpoint: 'ape_chain',
    moralisChain: 'apechain',
    alchemyChain: 'apechain-mainnet'
  },
  abstract: {
    name: 'Abstract',
    chainId: 2741,
    alchemyNetwork: 'abstract-mainnet',
    openSeaSlug: 'abstract',
    apiEndpoint: 'abstract',
    moralisChain: 'abstract',
    alchemyChain: 'abstract-mainnet'
  },
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    alchemyNetwork: 'eth-mainnet',
    openSeaSlug: 'ethereum',
    apiEndpoint: 'ethereum',
    moralisChain: 'eth',
    alchemyChain: 'eth-mainnet'
  }
};

const BASE_API_URL = 'https://api.opensea.io/api/v2';
const MORALIS_API_URL = 'https://deep-index.moralis.io/api/v2';

let currentChain = 'base';
let userWalletAddress = null;
let userCollections = new Map();
let allUserNFTs = []; // Store all NFTs for multi-collection grid
let selectedCollectionNFTs = [];
let selectedNFTsForGrid = new Set();
let originalImageData = new Map();

// Wallpaper Maker State
let wallpaperState = {
  background: 'linear-gradient(180deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
  character: null,
  characterSize: 200,
  characterPosition: 80,
  processedImage: null
};

// ============================================
// CUSTOM CURSOR
// ============================================
const cursor = document.querySelector('.cursor');
const cursorDot = document.querySelector('.cursor-dot');

if (cursor && cursorDot) {
  let mouseX = 0, mouseY = 0;
  let cursorX = 0, cursorY = 0;

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    cursorDot.style.left = mouseX + 'px';
    cursorDot.style.top = mouseY + 'px';
  });

  function animateCursor() {
    cursorX += (mouseX - cursorX) * 0.15;
    cursorY += (mouseY - cursorY) * 0.15;
    cursor.style.left = cursorX + 'px';
    cursor.style.top = cursorY + 'px';
    requestAnimationFrame(animateCursor);
  }
  animateCursor();

  // Hover effects
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest('a, button, .nft-thumbnail, .nft-card, .bg-option, select, input, .toggle, .leaderboard-entry')) {
      cursor.classList.add('hover');
    }
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('a, button, .nft-thumbnail, .nft-card, .bg-option, select, input, .toggle, .leaderboard-entry')) {
      cursor.classList.remove('hover');
    }
  });
}

// ============================================
// SCROLL PROGRESS
// ============================================
const progressBar = document.querySelector('.scroll-progress');
if (progressBar) {
  window.addEventListener('scroll', () => {
    const windowHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const scrolled = (window.pageYOffset / windowHeight) * 100;
    progressBar.style.width = scrolled + '%';
  });
}

// ============================================
// API INITIALIZATION
// ============================================
async function initializeAPIKeys() {
  try {
    const response = await fetch('/.netlify/functions/api-keys');
    
    if (!response.ok) {
      throw new Error(`API keys fetch failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.apiKeys || !data.apiKeys.opensea || !data.apiKeys.alchemy) {
      throw new Error('API keys are missing from response');
    }
    
    CONFIG.ALCHEMY_API_KEY = data.apiKeys.alchemy;
    CONFIG.OPENSEA_API_KEY = Array.isArray(data.apiKeys.opensea) ? data.apiKeys.opensea[0] : data.apiKeys.opensea;
    CONFIG.MORALIS_API_KEY = data.apiKeys.moralis;
    
    console.log('✅ API keys loaded successfully');
    return true;
  } catch (error) {
    console.error('❌ Error loading API keys:', error);
    showNotification('Failed to load configuration. Please check your setup.', 'error');
    return false;
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function normalizeTokenId(tokenId) {
  if (!tokenId) return '';
  if (typeof tokenId === 'string' && tokenId.startsWith('0x')) {
    return parseInt(tokenId, 16).toString();
  }
  return tokenId.toString();
}

function getProxiedImageUrl(url) {
  if (!url) return 'https://placehold.co/300x300/0a0a0a/00ff88/png?text=NFT';
  
  if (url.startsWith('ipfs://')) {
    const hash = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${hash}`;
  }
  
  if (url.startsWith('ar://')) {
    const hash = url.replace('ar://', '');
    return `https://arweave.net/${hash}`;
  }
  
  return url;
}

function showNotification(message, type = 'info') {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

function isSpamCollection(name) {
  const nameLower = name.toLowerCase();
  const spamKeywords = [
    'claim', 'reward', 'visit', 'voucher', 'airdrop', 'free mint',
    '.com', '.io', '.xyz', 'http', 'www.', '$', 'usd'
  ];
  return spamKeywords.some(keyword => nameLower.includes(keyword));
}

// ============================================
// WALLET & NFT LOADING
// ============================================
async function fetchWalletNFTs() {
  const walletInput = document.getElementById('walletAddress');
  const wallet = walletInput.value.trim();
  
  if (!wallet) {
    showNotification('Please enter a wallet address or ENS name', 'error');
    return;
  }
  
  if (!wallet.endsWith('.eth') && (!wallet.startsWith('0x') || wallet.length !== 42)) {
    showNotification('Please enter a valid wallet address or ENS name', 'error');
    return;
  }
  
  let resolvedAddress = wallet;
  
  if (wallet.endsWith('.eth')) {
    showNotification('Resolving ENS name...', 'info');
    resolvedAddress = await resolveENS(wallet);
    if (!resolvedAddress) {
      showNotification(`Could not resolve ENS name: ${wallet}`, 'error');
      return;
    }
    showNotification(`✓ Resolved to: ${resolvedAddress.slice(0, 6)}...${resolvedAddress.slice(-4)}`, 'success');
  }
  
  userWalletAddress = resolvedAddress;
  await loadWalletCollections(resolvedAddress);
}

async function resolveENS(ensName) {
  try {
    const response = await fetch(`https://api.ensdata.net/${ensName}`);
    
    if (!response.ok) {
      throw new Error(`ENS API returned status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data && data.address) {
      console.log(`✓ ENS resolved: ${ensName} → ${data.address}`);
      return data.address;
    }
    
    const backupResponse = await fetch(`https://api.web3.bio/profile/ens/${ensName}`);
    
    if (backupResponse.ok) {
      const backupData = await backupResponse.json();
      if (backupData && backupData.address) {
        console.log(`✓ ENS resolved via backup: ${ensName} → ${backupData.address}`);
        return backupData.address;
      }
    }
    
    console.error('Could not resolve ENS name');
    return null;
    
  } catch (error) {
    console.error('ENS resolution failed:', error);
    return null;
  }
}

async function loadWalletCollections(walletAddress) {
  const chain = SUPPORTED_CHAINS[currentChain];
  const nftGrid = document.getElementById('nftGrid');
  nftGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--muted);"><i class="fas fa-spinner fa-spin" style="font-size: 32px; margin-bottom: 16px; display: block;"></i>Loading your NFTs...</div>';
  
  try {
    const seenNFTs = new Set();
    let allNFTs = [];

    // OpenSea API
    try {
      console.log('Fetching NFTs from OpenSea...');
      let openSeaNextCursor = null;
      let openSeaPage = 0;
      
      do {
        const openSeaUrl = openSeaNextCursor 
          ? `${BASE_API_URL}/chain/${chain.apiEndpoint}/account/${walletAddress}/nfts?limit=200&next=${openSeaNextCursor}`
          : `${BASE_API_URL}/chain/${chain.apiEndpoint}/account/${walletAddress}/nfts?limit=200`;
          
        const openSeaResponse = await fetch(openSeaUrl, {
          headers: {
            'X-API-KEY': CONFIG.OPENSEA_API_KEY,
            'accept': 'application/json'
          }
        });
        
        if (openSeaResponse.ok) {
          const openSeaData = await openSeaResponse.json();
          if (openSeaData.nfts && openSeaData.nfts.length > 0) {
            openSeaData.nfts.forEach(nft => {
              const uniqueId = `${(nft.contract || '').toLowerCase()}_${normalizeTokenId(nft.identifier)}`;
              if (!seenNFTs.has(uniqueId)) {
                seenNFTs.add(uniqueId);
                allNFTs.push({
                  id: nft.identifier,
                  name: nft.name || `#${nft.identifier}`,
                  image: getProxiedImageUrl(nft.image_url),
                  collection: nft.collection,
                  contractAddress: nft.contract,
                  raw: nft
                });
              }
            });
            console.log(`OpenSea page ${openSeaPage + 1}: Found ${openSeaData.nfts.length} NFTs (Total: ${allNFTs.length})`);
            openSeaNextCursor = openSeaData.next;
            openSeaPage++;
          } else {
            break;
          }
        } else {
          break;
        }
        
        if (openSeaNextCursor) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
      } while (openSeaNextCursor && openSeaPage < 20);
      
    } catch (error) {
      console.error('OpenSea API Error:', error);
    }

    // Moralis API
    if (CONFIG.MORALIS_API_KEY) {
      try {
        console.log('Fetching NFTs from Moralis...');
        let moralisCursor = null;
        let moralisPage = 0;
        
        do {
          const moralisUrl = moralisCursor
            ? `${MORALIS_API_URL}/${walletAddress}/nft?chain=${chain.moralisChain}&format=decimal&limit=100&cursor=${moralisCursor}`
            : `${MORALIS_API_URL}/${walletAddress}/nft?chain=${chain.moralisChain}&format=decimal&limit=100`;
            
          const moralisResponse = await fetch(moralisUrl, {
            headers: {
              'X-API-Key': CONFIG.MORALIS_API_KEY
            }
          });
          
          if (moralisResponse.ok) {
            const moralisData = await moralisResponse.json();
            if (moralisData.result && moralisData.result.length > 0) {
              moralisData.result.forEach(nft => {
                const uniqueId = `${(nft.token_address || '').toLowerCase()}_${normalizeTokenId(nft.token_id)}`;
                if (!seenNFTs.has(uniqueId)) {
                  seenNFTs.add(uniqueId);
                  allNFTs.push({
                    id: nft.token_id,
                    name: nft.name || `#${nft.token_id}`,
                    image: getProxiedImageUrl(nft.metadata?.image || nft.metadata?.image_url),
                    collection: nft.name,
                    contractAddress: nft.token_address,
                    raw: nft
                  });
                }
              });
              console.log(`Moralis page ${moralisPage + 1}: Found ${moralisData.result.length} NFTs (Total: ${allNFTs.length})`);
              moralisCursor = moralisData.cursor;
              moralisPage++;
            } else {
              break;
            }
          } else {
            break;
          }
          
          if (moralisCursor) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          
        } while (moralisCursor && moralisPage < 30);
        
      } catch (error) {
        console.error('Moralis API Error:', error);
      }
    }

    // Alchemy API
    try {
      console.log('Fetching NFTs from Alchemy...');
      let alchemyPageKey = null;
      let alchemyPage = 0;
      
      do {
        const alchemyUrl = alchemyPageKey
          ? `https://${chain.alchemyNetwork}.g.alchemy.com/nft/v3/${CONFIG.ALCHEMY_API_KEY}/getNFTsForOwner?owner=${walletAddress}&withMetadata=true&pageSize=100&pageKey=${alchemyPageKey}`
          : `https://${chain.alchemyNetwork}.g.alchemy.com/nft/v3/${CONFIG.ALCHEMY_API_KEY}/getNFTsForOwner?owner=${walletAddress}&withMetadata=true&pageSize=100`;
        
        const alchemyResponse = await fetch(alchemyUrl);
        
        if (alchemyResponse.ok) {
          const alchemyData = await alchemyResponse.json();
          if (alchemyData.ownedNfts && alchemyData.ownedNfts.length > 0) {
            alchemyData.ownedNfts.forEach(nft => {
              const uniqueId = `${(nft.contract?.address || '').toLowerCase()}_${normalizeTokenId(nft.tokenId)}`;
              if (!seenNFTs.has(uniqueId)) {
                seenNFTs.add(uniqueId);
                const imageUrl = nft.image?.cachedUrl || 
                                nft.image?.thumbnailUrl || 
                                nft.raw?.metadata?.image || 
                                '';
                if (imageUrl) {
                  allNFTs.push({
                    id: nft.tokenId,
                    name: nft.name || nft.title || `#${nft.tokenId}`,
                    image: getProxiedImageUrl(imageUrl),
                    collection: nft.contract?.openSeaMetadata?.collectionName || nft.contract?.name,
                    contractAddress: nft.contract?.address,
                    raw: nft
                  });
                }
              }
            });
            console.log(`Alchemy page ${alchemyPage + 1}: Found ${alchemyData.ownedNfts.length} NFTs (Total: ${allNFTs.length})`);
            alchemyPageKey = alchemyData.pageKey;
            alchemyPage++;
          } else {
            break;
          }
        } else {
          break;
        }
        
        if (alchemyPageKey) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
      } while (alchemyPageKey && alchemyPage < 50);
      
    } catch (error) {
      console.error('Alchemy API Error:', error);
    }

    console.log(`Total unique NFTs found: ${allNFTs.length}`);
    
    if (allNFTs.length === 0) {
      nftGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #ffaa00;">No NFTs found in this wallet</div>';
      return;
    }
    
    // Store all NFTs for multi-collection grid
    allUserNFTs = allNFTs;
    
    processNFTsByCollection(allNFTs);
    displayCollectionSelector();
    
  } catch (error) {
    console.error('Error fetching NFTs:', error);
    nftGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #ff4444;">Error loading NFTs</div>';
  }
}

function processNFTsByCollection(nfts) {
  userCollections.clear();
  
  nfts.forEach(nft => {
    if (!nft.contractAddress) return;
    
    const collectionKey = nft.contractAddress.toLowerCase();
    const collectionName = nft.collection || 'Unknown Collection';
    
    if (isSpamCollection(collectionName)) return;
    
    if (!userCollections.has(collectionKey)) {
      userCollections.set(collectionKey, {
        name: collectionName,
        contract: nft.contractAddress,
        nfts: []
      });
    }
    
    if (nft.image) {
      userCollections.get(collectionKey).nfts.push({
        id: nft.id,
        name: nft.name,
        image: nft.image,
        collection: collectionName,
        contractAddress: nft.contractAddress,
        raw: nft
      });
    }
  });
  
  for (const [key, collection] of userCollections.entries()) {
    if (collection.nfts.length === 0) {
      userCollections.delete(key);
    }
  }
}

function displayCollectionSelector() {
  const collectionSection = document.getElementById('collectionSection');
  const collectionSelect = document.getElementById('collectionSelect');
  
  collectionSelect.innerHTML = '<option value="">All Collections (Multi-Select)</option>';
  
  const sortedCollections = Array.from(userCollections.values())
    .sort((a, b) => b.nfts.length - a.nfts.length);
  
  sortedCollections.forEach(collection => {
    const option = document.createElement('option');
    option.value = collection.contract;
    option.textContent = `${collection.name} (${collection.nfts.length} NFTs)`;
    collectionSelect.appendChild(option);
  });
  
  collectionSection.classList.remove('hidden');
  
  // Show all NFTs by default (multi-collection mode)
  selectedCollectionNFTs = allUserNFTs.filter(nft => nft.image);
  displayNFTs(selectedCollectionNFTs);
  
  // Update NFT count
  const nftCount = document.getElementById('nftCount');
  if (nftCount) {
    nftCount.textContent = `${selectedCollectionNFTs.length} NFTs`;
  }
}

document.getElementById('collectionSelect')?.addEventListener('change', function() {
  const selectedContract = this.value;
  
  if (!selectedContract) {
    // Show all NFTs (multi-collection mode)
    selectedCollectionNFTs = allUserNFTs.filter(nft => nft.image);
    displayNFTs(selectedCollectionNFTs);
  } else {
    const collection = userCollections.get(selectedContract.toLowerCase());
    if (collection) {
      selectedCollectionNFTs = collection.nfts;
      displayNFTs(collection.nfts);
    }
  }
  
  // Update NFT count
  const nftCount = document.getElementById('nftCount');
  if (nftCount) {
    nftCount.textContent = `${selectedCollectionNFTs.length} NFTs`;
  }
});

function displayNFTs(nfts) {
  const nftGrid = document.getElementById('nftGrid');
  nftGrid.innerHTML = '';
  
  nfts.forEach((nft, index) => {
    const div = document.createElement('div');
    div.className = 'relative group';
    div.innerHTML = `
      <img src="${nft.image}" 
           alt="${nft.name}" 
           class="nft-thumbnail" 
           data-index="${index}"
           loading="lazy"
           onerror="this.src='https://placehold.co/300x300/0a0a0a/00ff88/png?text=NFT'"/>
      <p style="font-size: 11px; text-align: center; margin-top: 8px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px;">${nft.name}</p>
    `;
    
    div.querySelector('.nft-thumbnail').addEventListener('click', () => {
      handleNFTSelection(index, div);
      // Also add to wallpaper maker
      addToWallpaper(nft);
    });
    
    nftGrid.appendChild(div);
  });
}

function handleNFTSelection(index, element) {
  const selectionMode = document.querySelector('input[name="selectionMode"]:checked')?.value;
  const gridModeToggle = document.getElementById('gridModeToggle');
  
  if (!gridModeToggle?.classList.contains('active')) return;
  if (selectionMode !== 'manual') return;
  
  const nft = selectedCollectionNFTs[index];
  const nftKey = `${nft.contractAddress}_${nft.id}`;
  
  if (selectedNFTsForGrid.has(nftKey)) {
    selectedNFTsForGrid.delete(nftKey);
    element.querySelector('img').classList.remove('selected-for-grid');
  } else {
    selectedNFTsForGrid.add(nftKey);
    element.querySelector('img').classList.add('selected-for-grid');
  }
}

// ============================================
// GRID MAKER
// ============================================
function getActualGridSize() {
  const gridSizeSelect = document.getElementById('gridSize');
  const selected = gridSizeSelect.value;
  
  if (selected === 'custom') {
    const rows = parseInt(document.getElementById('customGridRows').value) || 3;
    const cols = parseInt(document.getElementById('customGridCols').value) || 3;
    return { rows: Math.min(rows, 50), cols: Math.min(cols, 50) };
  }
  
  if (selected.startsWith('random-')) {
    let min, max;
    switch (selected) {
      case 'random-small': min = 2; max = 5; break;
      case 'random-medium': min = 5; max = 10; break;
      case 'random-large': min = 10; max = 20; break;
    }
    const size = Math.floor(Math.random() * (max - min + 1)) + min;
    return { rows: size, cols: size };
  }
  
  const size = parseInt(selected);
  return { rows: size, cols: size };
}

async function previewGrid() {
  const gridData = getActualGridSize();
  const selectionMode = document.querySelector('input[name="selectionMode"]:checked').value;
  
  let nftsToUse = [];
  if (selectionMode === 'random') {
    const shuffled = [...selectedCollectionNFTs].sort(() => 0.5 - Math.random());
    nftsToUse = shuffled.slice(0, gridData.rows * gridData.cols);
  } else {
    nftsToUse = Array.from(selectedNFTsForGrid).map(key => {
      const [contract, id] = key.split('_');
      return selectedCollectionNFTs.find(nft => 
        nft.contractAddress === contract && nft.id === id
      );
    }).filter(Boolean);
  }
  
  if (nftsToUse.length === 0) {
    showNotification('Please select NFTs for the grid', 'error');
    return;
  }
  
  await createGridCanvas(nftsToUse, gridData, true);
}

async function downloadGrid() {
  const gridData = getActualGridSize();
  const selectionMode = document.querySelector('input[name="selectionMode"]:checked').value;
  
  let nftsToUse = [];
  if (selectionMode === 'random') {
    const shuffled = [...selectedCollectionNFTs].sort(() => 0.5 - Math.random());
    nftsToUse = shuffled.slice(0, gridData.rows * gridData.cols);
  } else {
    nftsToUse = Array.from(selectedNFTsForGrid).map(key => {
      const [contract, id] = key.split('_');
      return selectedCollectionNFTs.find(nft => 
        nft.contractAddress === contract && nft.id === id
      );
    }).filter(Boolean);
  }
  
  if (nftsToUse.length === 0) {
    showNotification('Please select NFTs for the grid', 'error');
    return;
  }
  
  await createGridCanvas(nftsToUse, gridData, false);
}

async function createGridCanvas(nfts, gridData, isPreview) {
  const separatorWidth = parseInt(document.getElementById('separatorWidth').value);
  const separatorColor = document.getElementById('separatorColor').value;
  const emptyCellColor = document.getElementById('emptyCellColor').value;
  
  const cellSize = 400;
  const canvasWidth = gridData.cols * cellSize + (gridData.cols + 1) * separatorWidth;
  const canvasHeight = gridData.rows * cellSize + (gridData.rows + 1) * separatorWidth;
  
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = separatorColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  for (let i = 0; i < gridData.rows * gridData.cols; i++) {
    const row = Math.floor(i / gridData.cols);
    const col = i % gridData.cols;
    const x = separatorWidth + col * (cellSize + separatorWidth);
    const y = separatorWidth + row * (cellSize + separatorWidth);
    
    if (nfts[i]) {
      try {
        const img = await loadImage(nfts[i].image);
        ctx.drawImage(img, x, y, cellSize, cellSize);
      } catch (error) {
        ctx.fillStyle = emptyCellColor;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    } else {
      ctx.fillStyle = emptyCellColor;
      ctx.fillRect(x, y, cellSize, cellSize);
    }
  }
  
  if (isPreview) {
    showGridPreview(canvas);
  } else {
    downloadCanvasAsImage(canvas, `nft-grid-${gridData.rows}x${gridData.cols}.png`);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function showGridPreview(canvas) {
  const container = document.getElementById('gridPreviewContainer');
  const preview = document.getElementById('gridPreview');
  
  preview.innerHTML = '';
  
  const img = document.createElement('img');
  img.src = canvas.toDataURL();
  img.style.width = '100%';
  img.style.height = 'auto';
  preview.appendChild(img);
  
  container.classList.add('visible');
  container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadCanvasAsImage(canvas, filename) {
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function downloadAllAsZip() {
  if (selectedCollectionNFTs.length === 0) {
    showNotification('No NFTs to download', 'error');
    return;
  }
  
  const zip = new JSZip();
  let successCount = 0;
  
  showNotification('Preparing ZIP file...', 'info');
  
  for (const nft of selectedCollectionNFTs) {
    try {
      const response = await fetch(nft.image);
      if (response.ok) {
        const blob = await response.blob();
        const filename = `${nft.name.replace(/[^a-z0-9]/gi, '_')}.png`;
        zip.file(filename, blob);
        successCount++;
      }
    } catch (error) {
      console.error(`Failed to download ${nft.name}:`, error);
    }
  }
  
  if (successCount > 0) {
    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, `nfts_collection_${Date.now()}.zip`);
    showNotification(`Downloaded ${successCount} NFTs`, 'success');
  } else {
    showNotification('Failed to download NFTs', 'error');
  }
}

function resetGrid() {
  selectedNFTsForGrid.clear();
  document.querySelectorAll('.nft-thumbnail').forEach(img => {
    img.classList.remove('selected-for-grid');
  });
  document.getElementById('gridPreviewContainer').classList.remove('visible');
}

// ============================================
// WALLPAPER MAKER
// ============================================
function initWallpaperMaker() {
  const canvas = document.getElementById('wallpaperCanvas');
  if (!canvas) return;
  
  renderWallpaper();
  
  // Background selection
  document.querySelectorAll('.bg-option').forEach(option => {
    option.addEventListener('click', () => {
      document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      wallpaperState.background = option.dataset.bg;
      renderWallpaper();
    });
  });
  
  // Custom color
  document.getElementById('wallpaperBgColor')?.addEventListener('input', (e) => {
    document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
    wallpaperState.background = e.target.value;
    renderWallpaper();
  });
  
  // Character size
  document.getElementById('characterSize')?.addEventListener('input', (e) => {
    wallpaperState.characterSize = parseInt(e.target.value);
    document.getElementById('characterSizeValue').textContent = e.target.value;
    renderWallpaper();
  });
  
  // Character position
  document.getElementById('characterPosition')?.addEventListener('input', (e) => {
    wallpaperState.characterPosition = parseInt(e.target.value);
    document.getElementById('characterPosValue').textContent = e.target.value;
    renderWallpaper();
  });
  
  // Reset
  document.getElementById('resetWallpaper')?.addEventListener('click', () => {
    wallpaperState.character = null;
    wallpaperState.processedImage = null;
    wallpaperState.characterSize = 200;
    wallpaperState.characterPosition = 80;
    document.getElementById('characterSize').value = 200;
    document.getElementById('characterSizeValue').textContent = '200';
    document.getElementById('characterPosition').value = 80;
    document.getElementById('characterPosValue').textContent = '80';
    document.getElementById('wallpaperSelectedNFT').innerHTML = '<p style="color: var(--muted); font-size: 12px; width: 100%; text-align: center;">Click an NFT from your gallery to add</p>';
    renderWallpaper();
  });
  
  // Download
  document.getElementById('downloadWallpaper')?.addEventListener('click', () => {
    const canvas = document.getElementById('wallpaperCanvas');
    canvas.toBlob(blob => {
      const link = document.createElement('a');
      link.download = 'phone-wallpaper.png';
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    });
  });
}

function addToWallpaper(nft) {
  wallpaperState.character = nft;
  
  // Update preview
  const container = document.getElementById('wallpaperSelectedNFT');
  container.innerHTML = `
    <div class="selected-nft-item">
      <img src="${nft.image}" alt="${nft.name}">
      <button class="remove-btn" onclick="removeFromWallpaper()">×</button>
    </div>
    <p style="font-size: 11px; color: var(--fg);">${nft.name}</p>
  `;
  
  // Process image to remove background
  processCharacterImage(nft.image);
}

function removeFromWallpaper() {
  wallpaperState.character = null;
  wallpaperState.processedImage = null;
  document.getElementById('wallpaperSelectedNFT').innerHTML = '<p style="color: var(--muted); font-size: 12px; width: 100%; text-align: center;">Click an NFT from your gallery to add</p>';
  renderWallpaper();
}

async function processCharacterImage(imageUrl) {
  try {
    const img = await loadImage(imageUrl);
    
    // Create temp canvas for background removal
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0);
    
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    
    // Sample corners to detect background color
    const corners = [
      {x: 0, y: 0},
      {x: tempCanvas.width - 1, y: 0},
      {x: 0, y: tempCanvas.height - 1},
      {x: tempCanvas.width - 1, y: tempCanvas.height - 1}
    ];
    
    const bgColors = corners.map(corner => {
      const i = (corner.y * tempCanvas.width + corner.x) * 4;
      return {r: data[i], g: data[i+1], b: data[i+2]};
    });
    
    const avgBg = {
      r: bgColors.reduce((sum, c) => sum + c.r, 0) / 4,
      g: bgColors.reduce((sum, c) => sum + c.g, 0) / 4,
      b: bgColors.reduce((sum, c) => sum + c.b, 0) / 4
    };
    
    const threshold = 50;
    
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      const diff = Math.sqrt(
        Math.pow(r - avgBg.r, 2) +
        Math.pow(g - avgBg.g, 2) +
        Math.pow(b - avgBg.b, 2)
      );
      
      if (diff < threshold) {
        data[i + 3] = 0;
      }
    }
    
    tempCtx.putImageData(imageData, 0, 0);
    
    // Store processed image
    const processedImg = new Image();
    processedImg.onload = () => {
      wallpaperState.processedImage = processedImg;
      renderWallpaper();
    };
    processedImg.src = tempCanvas.toDataURL();
    
  } catch (error) {
    console.error('Error processing image:', error);
    // Fallback to original image
    const img = await loadImage(imageUrl);
    wallpaperState.processedImage = img;
    renderWallpaper();
  }
}

function renderWallpaper() {
  const canvas = document.getElementById('wallpaperCanvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  
  // Draw background
  if (wallpaperState.background.startsWith('linear-gradient') || wallpaperState.background.startsWith('radial-gradient')) {
    // Parse gradient
    const colors = wallpaperState.background.match(/#[0-9a-f]{6}/gi) || ['#0f0c29', '#24243e'];
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    colors.forEach((color, i) => {
      grad.addColorStop(i / (colors.length - 1), color);
    });
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = wallpaperState.background;
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw character
  if (wallpaperState.processedImage) {
    const img = wallpaperState.processedImage;
    const size = wallpaperState.characterSize * (canvas.width / 320); // Scale based on preview width
    const aspectRatio = img.width / img.height;
    const drawWidth = size * aspectRatio;
    const drawHeight = size;
    const x = (canvas.width - drawWidth) / 2;
    const y = (canvas.height * wallpaperState.characterPosition / 100) - drawHeight;
    
    ctx.drawImage(img, x, y, drawWidth, drawHeight);
  }
}

// ============================================
// FEATURED UNDEADS
// ============================================
async function loadFeaturedUndeads() {
  const nftScroller = document.getElementById('nftScroller');
  if (!nftScroller) return;
  
  nftScroller.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--muted);"><i class="fas fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 8px; display: block;"></i>Loading Featured Undeads...</div>';
  
  try {
    const allNFTs = [];
    
    const response = await fetch(
      `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts?limit=200`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'x-api-key': CONFIG.OPENSEA_API_KEY
        }
      }
    );

    if (!response.ok) {
      throw new Error(`OpenSea API error: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.nfts && data.nfts.length > 0) {
      allNFTs.push(...data.nfts);
      
      let nextCursor = data.next;
      let pageCount = 1;
      
      while (nextCursor && pageCount < 25) {
        const nextResponse = await fetch(
          `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts?limit=200&next=${encodeURIComponent(nextCursor)}`,
          {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'x-api-key': CONFIG.OPENSEA_API_KEY
            }
          }
        );

        if (!nextResponse.ok) break;
        
        const nextData = await nextResponse.json();
        if (nextData.nfts && nextData.nfts.length > 0) {
          allNFTs.push(...nextData.nfts);
          nextCursor = nextData.next;
          pageCount++;
        } else {
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    if (allNFTs.length > 0) {
      displayFeaturedNFTs(allNFTs);
      
      // Populate about section images
      populateAboutImages(allNFTs);
      return;
    }
  } catch (error) {
    console.error('Error loading featured undeads:', error);
  }
  
  loadFallbackUndeads();
}

function loadFallbackUndeads() {
  const nftScroller = document.getElementById('nftScroller');
  nftScroller.innerHTML = `
    <div style="text-align: center; padding: 40px; color: var(--muted);">
      <p>Unable to load Featured Undeads at the moment</p>
      <p style="font-size: 12px; margin-top: 8px;">Visit <a href="https://opensea.io/collection/basedundeads/overview" target="_blank" style="color: var(--accent);">OpenSea</a></p>
    </div>
  `;
}

function displayFeaturedNFTs(nfts) {
  const nftScroller = document.getElementById('nftScroller');
  nftScroller.innerHTML = '';
  
  const shuffled = [...nfts].sort(() => 0.5 - Math.random());
  const row1NFTs = shuffled.slice(0, 25);
  const row2NFTs = shuffled.slice(25, 50);
  
  const row1 = createScrollRow(row1NFTs, 'left');
  const row2 = createScrollRow(row2NFTs, 'right');
  
  nftScroller.appendChild(row1);
  nftScroller.appendChild(row2);
}

function createScrollRow(nfts, direction) {
  const row = document.createElement('div');
  row.className = `nft-scroll-row nft-scroll-${direction}`;
  
  [...nfts, ...nfts].forEach(nft => {
    const card = createNFTCard(nft);
    row.appendChild(card);
  });
  
  return row;
}

function createNFTCard(nft) {
  const card = document.createElement('div');
  card.className = 'nft-card';
  
  const imageUrl = nft.image_url || nft.display_image_url || 
                   'https://placehold.co/220x220/0a0a0a/00ff88/png?text=Undead';
  const tokenId = nft.identifier;
  const name = nft.name || `Based Undead #${tokenId}`;
  
  card.innerHTML = `
    <a href="https://opensea.io/assets/base/${CONFIG.BASED_UNDEADS_CONTRACT}/${tokenId}" 
       target="_blank">
      <img src="${imageUrl}" 
           alt="${name}" 
           loading="lazy"
           onerror="this.src='https://placehold.co/220x220/0a0a0a/00ff88/png?text=Undead'"/>
      <p>${name}</p>
    </a>
  `;
  
  return card;
}

function populateAboutImages(nfts) {
  const grid = document.getElementById('aboutImageGrid');
  if (!grid) return;
  
  const shuffled = [...nfts].sort(() => 0.5 - Math.random()).slice(0, 9);
  
  grid.innerHTML = shuffled.map(nft => {
    const imageUrl = nft.image_url || nft.display_image_url || 'https://placehold.co/200x200/0a0a0a/00ff88/png?text=Undead';
    return `
      <div class="about-image">
        <img src="${imageUrl}" alt="Undead" loading="lazy" onerror="this.src='https://placehold.co/200x200/0a0a0a/00ff88/png?text=Undead'">
      </div>
    `;
  }).join('');
}

// ============================================
// RAFFLE SYSTEM (All original functionality preserved)
// ============================================
const LEADERBOARD_CONFIG = {
  EXCLUDED_WALLETS: [],
  PHASES: {
    phase2: { min: 1501, max: 2300, name: 'Phase 2' },
    phase3: { min: 2301, max: 3333, name: 'Phase 3' },
    phase4: { min: 3334, max: 4444, name: 'Phase 4' }
  }
};

let leaderboardState = {
  data: [],
  isLoading: false,
  currentPhase: 'phase4'
};

let leaderboardCache = {
  data: null,
  holders: new Map(),
  lastUpdated: null
};

let autoRefreshInterval = null;

function parseOpenSeaUrl(url) {
  const match = url.match(/\/assets\/([^\/]+)\/([^\/]+)\/(\d+)/);
  if (match) {
    return {
      chain: match[1],
      contract: match[2],
      tokenId: match[3]
    };
  }
  return null;
}

async function loadRewardNFTs() {
  const rewards = [];
  
  for (const url of RAFFLE_CONFIG.REWARD_OPENSEA_URLS) {
    const parsed = parseOpenSeaUrl(url);
    if (!parsed) continue;
    
    try {
      const response = await fetch(
        `https://api.opensea.io/api/v2/chain/${parsed.chain}/contract/${parsed.contract}/nfts/${parsed.tokenId}`,
        {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'x-api-key': CONFIG.OPENSEA_API_KEY
          }
        }
      );
      
      if (response.ok) {
        const data = await response.json();
        const nft = data.nft;
        
        rewards.push({
          id: rewards.length + 1,
          name: nft.name || `Token #${parsed.tokenId}`,
          image: nft.image_url || nft.display_image_url,
          tokenId: parsed.tokenId,
          contract: parsed.contract,
          openseaUrl: url
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`Error loading reward NFT from ${url}:`, error);
    }
  }
  
  RAFFLE_CONFIG.REWARD_TOKENS = rewards;
  RAFFLE_CONFIG.TOTAL_WINNERS = rewards.length;
  return rewards;
}

async function loadEligibleRaffleNFTs() {
  try {
    document.getElementById('wheelStatus').textContent = 'Loading entries...';
    
    const response = await fetch(
      `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts?limit=200`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'x-api-key': CONFIG.OPENSEA_API_KEY
        }
      }
    );

    if (!response.ok) throw new Error(`OpenSea API error: ${response.status}`);

    let allNFTs = [];
    let data = await response.json();
    
    if (data.nfts) allNFTs.push(...data.nfts);
    
    let nextCursor = data.next;
    let pageCount = 1;
    
    while (nextCursor && pageCount < 25) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const nextResponse = await fetch(
        `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts?limit=200&next=${encodeURIComponent(nextCursor)}`,
        {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'x-api-key': CONFIG.OPENSEA_API_KEY
          }
        }
      );

      if (!nextResponse.ok) break;
      
      const nextData = await nextResponse.json();
      if (nextData.nfts && nextData.nfts.length > 0) {
        allNFTs.push(...nextData.nfts);
        nextCursor = nextData.next;
        pageCount++;
      } else {
        break;
      }
    }
    
    const eligibleNFTs = allNFTs.filter(nft => {
      const tokenId = parseInt(nft.identifier);
      return tokenId >= RAFFLE_CONFIG.TOKEN_RANGE.min && 
             tokenId <= RAFFLE_CONFIG.TOKEN_RANGE.max;
    }).sort((a, b) => parseInt(a.identifier) - parseInt(b.identifier));
    
    raffleState.eligibleNFTs = eligibleNFTs;
    raffleState.allEligibleEntries = eligibleNFTs.map(nft => parseInt(nft.identifier));
    raffleState.shuffledEntries = [...raffleState.allEligibleEntries].sort(() => Math.random() - 0.5);
    
    displayEligibleNFTs(eligibleNFTs);
    displayRewards();
    updateRaffleInfo();
    drawWheel(0);
    
    checkForListedNFTs(eligibleNFTs);
    
  } catch (error) {
    console.error('Error loading eligible NFTs:', error);
    document.getElementById('wheelStatus').textContent = 'Error loading entries';
    document.getElementById('eligibleNFTsDisplay').innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #ff4444;">Failed to load</p>';
  }
}

function displayRewards() {
  const container = document.getElementById('raffleRewardsDisplay');
  
  if (RAFFLE_CONFIG.REWARD_TOKENS.length === 0) {
    container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--muted);">Loading rewards...</p>';
    return;
  }
  
  container.innerHTML = RAFFLE_CONFIG.REWARD_TOKENS.map((reward, idx) => `
    <div class="reward-item">
      <a href="${reward.openseaUrl}" target="_blank">
        <img src="${reward.image}" 
             alt="${reward.name}" 
             onerror="this.src='https://placehold.co/100x100/0a0a0a/00ff88/png?text=Prize+${idx+1}'"/>
        <p>Prize ${idx + 1}</p>
      </a>
    </div>
  `).join('');
}

function displayEligibleNFTs(nfts) {
  const container = document.getElementById('eligibleNFTsDisplay');
  
  if (nfts.length === 0) {
    container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--muted);">No eligible NFTs found</p>';
    return;
  }
  
  container.innerHTML = nfts.map(nft => {
    const tokenId = parseInt(nft.identifier);
    const imageUrl = nft.image_url || nft.display_image_url || 
                     `https://placehold.co/80x80/0a0a0a/00ff88/png?text=${tokenId}`;
    
    return `
      <div class="eligible-item">
        <img src="${imageUrl}" 
             alt="Undead #${tokenId}" 
             loading="lazy"
             onerror="this.src='https://placehold.co/80x80/0a0a0a/00ff88/png?text=${tokenId}'"/>
        <p>#${tokenId}</p>
      </div>
    `;
  }).join('');
}

function updateRaffleInfo() {
  document.getElementById('rafflePhaseName').textContent = RAFFLE_CONFIG.PHASE_NAME;
  document.getElementById('eligibleRangeDisplay').textContent = `${RAFFLE_CONFIG.TOKEN_RANGE.min}-${RAFFLE_CONFIG.TOKEN_RANGE.max}`;
  document.getElementById('totalEntriesCount').textContent = raffleState.allEligibleEntries.length;
  document.getElementById('wheelStatus').textContent = `${raffleState.allEligibleEntries.length} entries loaded`;
}

async function checkWalletRaffle() {
  const wallet = document.getElementById('raffleWalletInput').value.trim();
  
  if (!wallet || !wallet.startsWith('0x') || wallet.length !== 42) {
    showNotification('Please enter a valid Ethereum wallet address', 'error');
    return;
  }

  const walletLower = wallet.toLowerCase();

  document.getElementById('raffleTokensList').innerHTML = '<p style="text-align: center; color: var(--muted); font-size: 12px; padding: 16px;">Checking entries...</p>';
  document.getElementById('raffleEntriesCount').textContent = '...';
  document.getElementById('raffleFoundNFTsDisplay').classList.add('hidden');

  if (leaderboardCache.holders && leaderboardCache.holders.size > 0) {
    console.log('✓ Using cached leaderboard data');
    
    if (leaderboardCache.holders.has(walletLower)) {
      const tokens = leaderboardCache.holders.get(walletLower);
      
      raffleState.walletAddress = wallet;
      raffleState.eligibleTokens = tokens.sort((a, b) => a - b);
      document.getElementById('raffleEntriesCount').textContent = tokens.length;
      
      document.getElementById('raffleTokensList').innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          ${tokens.map(token => `
            <span style="background: rgba(0,255,136,0.1); padding: 4px 12px; border-radius: 100px; font-size: 11px; border: 1px solid rgba(0,255,136,0.3);">#${token}</span>
          `).join('')}
        </div>
      `;
      
      showNotification(`Found ${tokens.length} entries!`, 'success');
      displayFoundRaffleNFTs(tokens);
      
    } else {
      raffleState.walletAddress = wallet;
      raffleState.eligibleTokens = [];
      document.getElementById('raffleEntriesCount').textContent = '0';
      document.getElementById('raffleTokensList').innerHTML = '<p style="text-align: center; color: #ffaa00; font-size: 12px; padding: 16px;">No eligible NFTs found in Phase 4 range</p>';
      showNotification('No entries found', 'info');
    }
    
    return;
  }

  showNotification('Leaderboard not loaded yet. Checking blockchain...', 'info');
  
  try {
    const phase = RAFFLE_CONFIG.TOKEN_RANGE;
    const eligibleTokens = [];

    for (let tokenId = phase.min; tokenId <= phase.max; tokenId++) {
      try {
        const url = `https://base.blockscout.com/api/v2/tokens/${CONFIG.BASED_UNDEADS_CONTRACT}/instances/${tokenId}`;
        
        const response = await fetch(url, {
          headers: { 'accept': 'application/json' }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.owner && data.owner.hash && data.owner.hash.toLowerCase() === walletLower) {
            eligibleTokens.push(tokenId);
            document.getElementById('raffleEntriesCount').textContent = eligibleTokens.length;
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.warn(`Failed to check token ${tokenId}`);
      }
    }
    
    raffleState.walletAddress = wallet;
    raffleState.eligibleTokens = eligibleTokens.sort((a, b) => a - b);
    document.getElementById('raffleEntriesCount').textContent = eligibleTokens.length;
    
    if (eligibleTokens.length > 0) {
      document.getElementById('raffleTokensList').innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          ${eligibleTokens.map(token => `
            <span style="background: rgba(0,255,136,0.1); padding: 4px 12px; border-radius: 100px; font-size: 11px; border: 1px solid rgba(0,255,136,0.3);">#${token}</span>
          `).join('')}
        </div>
      `;
      
      showNotification(`Found ${eligibleTokens.length} entries!`, 'success');
      displayFoundRaffleNFTs(eligibleTokens);
      
    } else {
      document.getElementById('raffleTokensList').innerHTML = '<p style="text-align: center; color: #ffaa00; font-size: 12px; padding: 16px;">No eligible NFTs found in Phase 4 range</p>';
      showNotification('No entries found', 'info');
    }
  } catch (error) {
    console.error('Error:', error);
    document.getElementById('raffleTokensList').innerHTML = '<p style="text-align: center; color: #ff4444; font-size: 12px; padding: 16px;">Error checking wallet</p>';
    showNotification('Error checking entries', 'error');
  }
}

async function displayFoundRaffleNFTs(tokenIds) {
  const displaySection = document.getElementById('raffleFoundNFTsDisplay');
  const grid = document.getElementById('raffleFoundNFTsGrid');
  
  displaySection.classList.remove('hidden');
  grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--muted); font-size: 11px;">Loading images...</p>';
  
  try {
    const nftImages = [];
    
    for (const tokenId of tokenIds.slice(0, 12)) {
      try {
        const response = await fetch(
          `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts/${tokenId}`,
          {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'x-api-key': CONFIG.OPENSEA_API_KEY
            }
          }
        );
        
        if (response.ok) {
          const data = await response.json();
          const imageUrl = data.nft?.image_url || data.nft?.display_image_url || 
                          `https://placehold.co/80x80/0a0a0a/00ff88/png?text=${tokenId}`;
          
          nftImages.push({
            tokenId,
            imageUrl,
            openseaUrl: `https://opensea.io/assets/base/${CONFIG.BASED_UNDEADS_CONTRACT}/${tokenId}`
          });
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (err) {
        console.error(`Failed to load token ${tokenId}`);
      }
    }
    
    if (nftImages.length > 0) {
      grid.innerHTML = nftImages.map(nft => `
        <a href="${nft.openseaUrl}" target="_blank" class="eligible-item">
          <img src="${nft.imageUrl}" 
               alt="Undead #${nft.tokenId}" 
               loading="lazy"
               onerror="this.src='https://placehold.co/80x80/0a0a0a/00ff88/png?text=${nft.tokenId}'"/>
          <p>#${nft.tokenId}</p>
        </a>
      `).join('');
    } else {
      grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #ff4444; font-size: 11px;">Failed to load images</p>';
    }
    
  } catch (error) {
    console.error('Error displaying NFTs:', error);
    grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #ff4444; font-size: 11px;">Error loading images</p>';
  }
}

function shuffleRaffleEntries() {
  if (raffleState.allEligibleEntries.length === 0) {
    showNotification('No entries to shuffle!', 'error');
    return;
  }
  
  raffleState.shuffledEntries = [...raffleState.allEligibleEntries];
  for (let i = raffleState.shuffledEntries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [raffleState.shuffledEntries[i], raffleState.shuffledEntries[j]] = 
    [raffleState.shuffledEntries[j], raffleState.shuffledEntries[i]];
  }
  
  drawWheel(0);
  showNotification('Entries shuffled!', 'success');
}

function spinWheel() {
  if (raffleState.isSpinning || raffleState.allEligibleEntries.length === 0) {
    showNotification('No entries available!', 'error');
    return;
  }
  
  if (raffleState.winners.length >= RAFFLE_CONFIG.TOTAL_WINNERS) {
    showNotification('All prizes awarded!', 'info');
    return;
  }
  
  raffleState.isSpinning = true;
  const spinBtn = document.getElementById('raffleSpinBtn');
  spinBtn.disabled = true;
  spinBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Spinning...';

  const spins = 5 + Math.floor(Math.random() * 5);
  const extraDegrees = Math.random() * 360;
  const totalRotation = spins * 360 + extraDegrees;
  const duration = 4000;
  
  let currentRotation = 0;
  const startTime = Date.now();
  
  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 3);
    currentRotation = totalRotation * easeOut;
    
    drawWheel(currentRotation);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      selectWinner(extraDegrees);
    }
  }
  
  animate();
}

function selectWinner(finalDegree) {
  const entries = raffleState.shuffledEntries || raffleState.allEligibleEntries;
  const normalizedDegree = (360 - (finalDegree % 360)) % 360;
  const segmentSize = 360 / Math.min(entries.length, 72);
  const winningIndex = Math.floor(normalizedDegree / segmentSize) % entries.length;
  const winningToken = entries[winningIndex];

  if (raffleState.winners.find(w => w.tokenId === winningToken)) {
    raffleState.shuffledEntries = raffleState.shuffledEntries.filter(t => t !== winningToken);
    showNotification(`Token #${winningToken} already won! Spinning again...`, 'info');
    setTimeout(() => spinWheel(), 1000);
    raffleState.isSpinning = false;
    return;
  }

  const winningNFT = raffleState.eligibleNFTs.find(nft => parseInt(nft.identifier) === winningToken);
  
  raffleState.winners.push({
    position: raffleState.winners.length + 1,
    tokenId: winningToken,
    nft: winningNFT
  });

  raffleState.shuffledEntries = raffleState.shuffledEntries.filter(t => t !== winningToken);

  updateWinnersDisplay();

  const spinBtn = document.getElementById('raffleSpinBtn');
  
  if (raffleState.winners.length < RAFFLE_CONFIG.TOTAL_WINNERS) {
    raffleState.isSpinning = false;
    spinBtn.disabled = false;
    spinBtn.innerHTML = `<i class="fas fa-play"></i> Spin (${RAFFLE_CONFIG.TOTAL_WINNERS - raffleState.winners.length} left)`;
  } else {
    raffleState.isSpinning = false;
    spinBtn.innerHTML = '🎉 Complete!';
    spinBtn.disabled = true;
  }
}

function updateWinnersDisplay() {
  const container = document.getElementById('raffleWinnersList');
  container.innerHTML = raffleState.winners.map((winner, idx) => {
    const nftImage = winner.nft?.image_url || winner.nft?.display_image_url || 
                     `https://placehold.co/60x60/0a0a0a/00ff88/png?text=${winner.tokenId}`;
    
    return `
      <div class="winner-card">
        <span class="winner-rank">${['🥇', '🥈', '🥉'][idx] || `#${idx + 1}`}</span>
        <img src="${nftImage}" 
             alt="Undead #${winner.tokenId}" 
             class="winner-img"
             onerror="this.src='https://placehold.co/60x60/0a0a0a/00ff88/png?text=${winner.tokenId}'"/>
        <div class="winner-info">
          <p class="winner-name">Based Undead #${winner.tokenId}</p>
        </div>
      </div>
    `;
  }).join('');
}

function resetRaffle() {
  if (raffleState.winners.length > 0 && !confirm('Reset raffle and clear winners?')) return;
  
  raffleState.winners = [];
  raffleState.eligibleTokens = [];
  raffleState.walletAddress = '';
  raffleState.isSpinning = false;
  raffleState.shuffledEntries = [];
  
  document.getElementById('raffleWalletInput').value = '';
  document.getElementById('raffleEntriesCount').textContent = '0';
  document.getElementById('raffleTokensList').innerHTML = '<p style="text-align: center; color: var(--muted); font-size: 12px; padding: 16px;">Enter wallet to see tokens</p>';
  document.getElementById('raffleWinnersList').innerHTML = '<p style="text-align: center; color: var(--muted); font-size: 12px; padding: 32px;">No winners yet</p>';
  document.getElementById('raffleFoundNFTsDisplay').classList.add('hidden');
  
  const spinBtn = document.getElementById('raffleSpinBtn');
  spinBtn.innerHTML = '<i class="fas fa-play"></i> Spin';
  spinBtn.disabled = false;
  
  drawWheel(0);
}

function drawWheel(rotation = 0) {
  const canvas = document.getElementById('raffleCanvasWheel');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const entries = raffleState.shuffledEntries || raffleState.allEligibleEntries;
  
  if (entries.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.arc(140, 140, 130, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = 'var(--muted)';
    ctx.font = '14px "Geist Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Loading...', 140, 140);
    return;
  }
  
  const segmentCount = Math.min(entries.length, 72);
  const segmentAngle = 360 / segmentCount;
  const colors = ['#00ff88', '#00cc6f', '#00aa5f', '#008844', '#006633', '#ff6b6b', '#ff8787', '#ffa5a5', '#ffc3c3', '#ffe0e0'];
  
  const centerX = 140;
  const centerY = 140;
  const radius = 130;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.translate(-centerX, -centerY);

  for (let i = 0; i < segmentCount; i++) {
    const tokenId = entries[i % entries.length];
    const startAngle = (i * segmentAngle - 90) * Math.PI / 180;
    const endAngle = ((i + 1) * segmentAngle - 90) * Math.PI / 180;

    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const midAngle = (startAngle + endAngle) / 2;
    const textX = centerX + Math.cos(midAngle) * (radius * 0.65);
    const textY = centerY + Math.sin(midAngle) * (radius * 0.65);
    
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.font = 'bold 9px "Geist Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${tokenId}`, textX, textY);
  }

  ctx.restore();
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, 20, 0, 2 * Math.PI);
  ctx.fillStyle = 'var(--accent)';
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.stroke();
}

async function checkForListedNFTs(eligibleNFTs) {
  try {
    console.log('Searching for listed NFTs from Phase 4 range...');
    const listedNFTs = [];
    const checkedTokens = new Set();
    
    const shuffled = [...eligibleNFTs].sort(() => 0.5 - Math.random());
    
    for (const nft of shuffled) {
      if (listedNFTs.length >= 5) break;
      
      const tokenId = nft.identifier;
      
      if (checkedTokens.has(tokenId)) continue;
      checkedTokens.add(tokenId);
      
      try {
        const response = await fetch(
          `https://api.opensea.io/api/v2/orders/base/seaport/listings?asset_contract_address=${CONFIG.BASED_UNDEADS_CONTRACT}&token_ids=${tokenId}&limit=1`,
          {
            method: 'GET',
            headers: {
              'accept': 'application/json',
              'x-api-key': CONFIG.OPENSEA_API_KEY
            }
          }
        );
        
        if (response.ok) {
          const data = await response.json();
          if (data.orders && data.orders.length > 0) {
            const listing = data.orders[0];
            const priceData = listing.current_price;
            const decimals = 18;
            const price = parseFloat((parseInt(priceData) / Math.pow(10, decimals)).toFixed(6));
            
            listedNFTs.push({
              ...nft,
              price: price,
              priceWei: priceData,
              currency: 'ETH',
              openseaUrl: `https://opensea.io/assets/base/${CONFIG.BASED_UNDEADS_CONTRACT}/${tokenId}`
            });
            
            console.log(`✓ Found listing: Token #${tokenId} for ${price} ETH`);
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 400));
        
      } catch (err) {
        console.log(`Could not check token #${tokenId}`);
      }
      
      if (checkedTokens.size >= 50) break;
    }
    
    if (listedNFTs.length > 0) {
      displayListedNFTs(listedNFTs);
    } else {
      document.getElementById('listedNFTsSection')?.classList.add('hidden');
    }
    
  } catch (error) {
    console.error('Error checking listings:', error);
    document.getElementById('listedNFTsSection')?.classList.add('hidden');
  }
}

function displayListedNFTs(listedNFTs) {
  const section = document.getElementById('listedNFTsSection');
  const container = document.getElementById('listedNFTsDisplay');
  
  if (listedNFTs.length === 0) {
    section.classList.add('hidden');
    return;
  }
  
  section.classList.remove('hidden');
  
  container.innerHTML = listedNFTs.map(nft => {
    const imageUrl = nft.image_url || nft.display_image_url || 
                     `https://placehold.co/200x200/0a0a0a/00ff88/png?text=${nft.identifier}`;
    
    return `
      <a href="${nft.openseaUrl}" target="_blank" class="listed-item">
        <img src="${imageUrl}" 
             alt="Undead #${nft.identifier}" 
             loading="lazy"
             onerror="this.src='https://placehold.co/200x200/0a0a0a/00ff88/png?text=${nft.identifier}'"/>
        <span class="listed-price">${nft.price} ETH</span>
        <div class="listed-info">
          <p style="color: var(--fg); font-weight: 500;">#${nft.identifier}</p>
          <p style="color: #ff6b6b; font-size: 10px;">🎫 +1 Entry</p>
        </div>
      </a>
    `;
  }).join('');
}

// ============================================
// LEADERBOARD
// ============================================
async function loadLeaderboard() {
  if (leaderboardState.isLoading) return;
  leaderboardState.isLoading = true;

  const leaderboardList = document.getElementById('leaderboardList');
  leaderboardList.innerHTML = `
    <div style="text-align: center; color: var(--muted); padding: 32px;">
      <i class="fas fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 8px; display: block;"></i>
      <p style="font-size: 11px;">Loading from blockchain...</p>
      <p style="font-size: 10px; margin-top: 8px;" id="leaderboardProgress">Starting...</p>
    </div>
  `;

  try {
    const phase = LEADERBOARD_CONFIG.PHASES[leaderboardState.currentPhase];
    console.log(`🚀 Loading ${phase.name} holders...`);
    
    updateProgress('Fetching minted tokens...');
    
    const mintedTokens = await fetchMintedTokensFromBasescan(phase.min, phase.max);
    console.log(`✓ Found ${mintedTokens.length} minted tokens`);
    
    if (mintedTokens.length === 0) {
      throw new Error('No minted tokens found');
    }
    
    updateProgress(`Found ${mintedTokens.length} tokens. Fetching owners...`);
    
    const holders = await fetchOwnersFromOpenSeaOptimized(mintedTokens);
    console.log(`✓ Found ${holders.size} unique holders`);
    
    const leaderboard = buildLeaderboardFromHolders(holders);
    
    leaderboardCache.data = leaderboard;
    leaderboardCache.holders = holders;
    leaderboardCache.lastUpdated = Date.now();
    
    leaderboardState.data = leaderboard;
    displayLeaderboard(leaderboard);
    
  } catch (error) {
    console.error('❌ Error loading leaderboard:', error);
    leaderboardList.innerHTML = `
      <div style="text-align: center; color: #ff4444; padding: 32px;">
        <i class="fas fa-exclamation-circle" style="font-size: 24px; margin-bottom: 8px; display: block;"></i>
        <p style="font-size: 11px;">Failed to load</p>
        <button onclick="loadLeaderboard()" class="btn-tool secondary" style="margin-top: 16px; font-size: 10px;">Retry</button>
      </div>
    `;
  } finally {
    leaderboardState.isLoading = false;
  }
}

async function fetchMintedTokensFromBasescan(minToken, maxToken) {
  const mintedTokens = new Set();
  
  try {
    console.log('📡 Fetching mint events from Basescan...');
    const baseUrl = 'https://api.basescan.org/api';
    
    let page = 1;
    
    while (page <= 5) {
      const params = new URLSearchParams({
        module: 'account',
        action: 'tokennfttx',
        contractaddress: CONFIG.BASED_UNDEADS_CONTRACT,
        page: page,
        offset: 10000,
        sort: 'asc',
        apikey: 'CJGZ4QMEE1JYAB1CVHR34EP6892QBKK3FY'
      });
      
      const response = await fetch(`${baseUrl}?${params}`);
      const data = await response.json();
      
      if (data.status === '1' && data.result && data.result.length > 0) {
        data.result.forEach(tx => {
          const tokenId = parseInt(tx.tokenID);
          if (tx.from === '0x0000000000000000000000000000000000000000' &&
              tokenId >= minToken && 
              tokenId <= maxToken) {
            mintedTokens.add(tokenId);
          }
        });
        
        if (data.result.length < 10000) break;
        page++;
        await new Promise(resolve => setTimeout(resolve, 300));
      } else {
        break;
      }
    }
    
  } catch (error) {
    console.error('Basescan API error:', error);
  }
  
  if (mintedTokens.size === 0 && raffleState.eligibleNFTs.length > 0) {
    raffleState.eligibleNFTs.forEach(nft => {
      const tokenId = parseInt(nft.identifier);
      if (tokenId >= minToken && tokenId <= maxToken) {
        mintedTokens.add(tokenId);
      }
    });
  }
  
  return Array.from(mintedTokens).sort((a, b) => a - b);
}

async function fetchOwnersFromOpenSeaOptimized(tokenIds) {
  const holders = new Map();
  
  let processedCount = 0;
  let foundOwners = 0;
  const batchSize = 5;
  
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, Math.min(i + batchSize, tokenIds.length));
    
    for (const tokenId of batch) {
      const result = await fetchTokenOwnerFromOpenSea(tokenId);
      
      processedCount++;
      
      if (result.owner) {
        foundOwners++;
        const owner = result.owner.toLowerCase();
        if (!holders.has(owner)) {
          holders.set(owner, []);
        }
        holders.get(owner).push(result.tokenId);
      }
      
      if (processedCount % 10 === 0 || processedCount === tokenIds.length) {
        const percent = Math.round((processedCount / tokenIds.length) * 100);
        updateProgress(`${percent}% complete - ${holders.size} holders found`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    
    if (i + batchSize < tokenIds.length) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  
  return holders;
}

async function fetchTokenOwnerFromOpenSea(tokenId, retries = 2) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts/${tokenId}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'x-api-key': CONFIG.OPENSEA_API_KEY
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.nft && data.nft.owners && data.nft.owners.length > 0) {
          return { tokenId, owner: data.nft.owners[0].address };
        }
      }
      
      if (response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 10000 * (attempt + 1)));
        continue;
      }
      
    } catch (error) {
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  
  return { tokenId, owner: null };
}

function updateProgress(message) {
  const progressEl = document.getElementById('leaderboardProgress');
  if (progressEl) progressEl.textContent = message;
}

function buildLeaderboardFromHolders(holders) {
  const leaderboard = [];
  
  for (const [wallet, tokens] of holders.entries()) {
    if (tokens.length > 0) {
      leaderboard.push({
        wallet: wallet.toLowerCase(),
        holding: tokens.length,
        tokens: tokens.sort((a, b) => a - b)
      });
    }
  }
  
  leaderboard.sort((a, b) => b.holding - a.holding);
  
  return leaderboard;
}

function displayLeaderboard(leaderboard) {
  const leaderboardList = document.getElementById('leaderboardList');
  
  if (leaderboard.length === 0) {
    leaderboardList.innerHTML = `
      <div style="text-align: center; color: var(--muted); padding: 32px;">
        <p style="font-size: 12px;">No holders found</p>
        <button onclick="loadLeaderboard()" class="btn-tool secondary" style="margin-top: 16px; font-size: 10px;">Retry</button>
      </div>
    `;
    return;
  }

  const totalWallets = leaderboard.length;
  const totalHeld = leaderboard.reduce((sum, entry) => sum + entry.holding, 0);

  document.getElementById('leaderboardTotalWallets').textContent = totalWallets;
  document.getElementById('leaderboardTotalMinted').textContent = totalHeld;
  document.getElementById('leaderboardTotalHeld').textContent = totalHeld;

  leaderboardList.innerHTML = leaderboard.map((entry, index) => {
    const shortWallet = `${entry.wallet.slice(0, 6)}...${entry.wallet.slice(-4)}`;
    const rankBadge = index < 3 ? ['🥇', '🥈', '🥉'][index] : `#${index + 1}`;
    
    return `
      <div class="leaderboard-entry" data-wallet="${entry.wallet}">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 18px;">${rankBadge}</span>
            <div>
              <p style="font-family: 'Geist Mono', monospace; font-size: 12px;" title="${entry.wallet}">${shortWallet}</p>
              <p style="font-size: 11px; color: var(--accent); margin-top: 4px;">💎 ${entry.holding} NFTs</p>
            </div>
          </div>
          <button onclick="copyToClipboard('${entry.wallet}', event)" style="background: none; border: none; color: var(--muted); cursor: pointer; padding: 8px;" title="Copy wallet">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.leaderboard-entry').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const wallet = el.dataset.wallet;
      showWalletDetails(wallet, leaderboard);
    });
  });
}

function showWalletDetails(wallet, leaderboard) {
  const entry = leaderboard.find(e => e.wallet === wallet);
  if (!entry) return;

  const modal = document.createElement('div');
  modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.9); backdrop-filter: blur(10px); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;';
  modal.innerHTML = `
    <div class="glass-card" style="max-width: 600px; width: 100%; max-height: 80vh; overflow-y: auto; padding: 32px;">
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 24px;">
        <div>
          <p style="font-family: 'Geist Mono', monospace; font-size: 10px; color: var(--accent); margin-bottom: 8px;">WALLET DETAILS</p>
          <p style="font-family: 'Geist Mono', monospace; font-size: 12px; word-break: break-all;">${wallet}</p>
        </div>
        <button onclick="this.closest('div[style*=\"position: fixed\"]').remove()" style="background: none; border: none; color: var(--fg); font-size: 24px; cursor: pointer;">×</button>
      </div>

      <div style="text-align: center; padding: 24px; background: var(--glass); border-radius: 16px; margin-bottom: 24px;">
        <p style="font-family: 'Instrument Serif', serif; font-size: 48px; color: var(--accent);">${entry.holding}</p>
        <p style="font-family: 'Geist Mono', monospace; font-size: 10px; color: var(--muted); margin-top: 8px;">NFTs HELD</p>
      </div>

      <div>
        <p style="font-family: 'Geist Mono', monospace; font-size: 10px; color: var(--muted); margin-bottom: 12px;">OWNED TOKENS (${entry.tokens.length})</p>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; max-height: 200px; overflow-y: auto;">
          ${entry.tokens.map(tokenId => `
            <a href="https://opensea.io/assets/base/${CONFIG.BASED_UNDEADS_CONTRACT}/${tokenId}" 
               target="_blank"
               style="background: rgba(0,255,136,0.1); padding: 6px 12px; border-radius: 100px; font-size: 11px; border: 1px solid rgba(0,255,136,0.3); text-decoration: none; color: var(--fg);">
              #${tokenId}
            </a>
          `).join('')}
        </div>
      </div>

      <a href="https://opensea.io/${wallet}" target="_blank" class="btn-tool secondary" style="width: 100%; margin-top: 24px; justify-content: center; text-decoration: none;">
        View on OpenSea <i class="fas fa-external-link-alt" style="margin-left: 8px;"></i>
      </a>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

function copyToClipboard(text, event) {
  event.stopPropagation();
  navigator.clipboard.writeText(text).then(() => {
    showNotification('Wallet address copied!', 'success');
  }).catch(() => {
    showNotification('Failed to copy', 'error');
  });
}

// Leaderboard search
document.getElementById('leaderboardSearch')?.addEventListener('input', function(e) {
  const searchTerm = e.target.value.toLowerCase();
  const entries = document.querySelectorAll('.leaderboard-entry');
  
  entries.forEach(entry => {
    const wallet = entry.dataset.wallet.toLowerCase();
    entry.style.display = wallet.includes(searchTerm) ? '' : 'none';
  });
});

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', async function() {
  // Initialize API keys
  const keysLoaded = await initializeAPIKeys();
  if (!keysLoaded) return;
  
  // Load featured NFTs
  if (document.getElementById('nftScroller')) {
    loadFeaturedUndeads();
  }
  
  // Initialize raffle
  if (document.getElementById('raffleCanvasWheel')) {
    await loadRewardNFTs();
    await loadEligibleRaffleNFTs();
  }
  
  // Initialize wallpaper maker
  initWallpaperMaker();
  
  // Grid mode toggle
  const gridModeToggle = document.getElementById('gridModeToggle');
  const gridOptions = document.getElementById('gridOptions');
  
  gridModeToggle?.addEventListener('click', () => {
    gridModeToggle.classList.toggle('active');
    gridOptions.classList.toggle('visible');
  });
  
  // Grid size custom input
  document.getElementById('gridSize')?.addEventListener('change', function() {
    const customInput = document.getElementById('customGridSizeInput');
    if (this.value === 'custom') {
      customInput.classList.remove('hidden');
    } else {
      customInput.classList.add('hidden');
    }
  });
  
  // Chain select
  document.getElementById('chainSelect')?.addEventListener('change', function() {
    currentChain = this.value;
    userCollections.clear();
    allUserNFTs = [];
    selectedCollectionNFTs = [];
    selectedNFTsForGrid.clear();
    
    document.getElementById('collectionSection').classList.add('hidden');
    document.getElementById('nftGrid').innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--muted);"><i class="fas fa-wallet" style="font-size: 48px; margin-bottom: 16px; display: block; opacity: 0.3;"></i><p>Enter a wallet address above to load NFTs</p></div>';
    
    showNotification(`Switched to ${SUPPORTED_CHAINS[currentChain].name}`, 'info');
  });
  
  // Event listeners
  document.getElementById('fetchNFTs')?.addEventListener('click', fetchWalletNFTs);
  document.getElementById('previewGrid')?.addEventListener('click', previewGrid);
  document.getElementById('downloadGrid')?.addEventListener('click', downloadGrid);
  document.getElementById('downloadAll')?.addEventListener('click', downloadAllAsZip);
  document.getElementById('resetGrid')?.addEventListener('click', resetGrid);
  
  // Smooth scroll for nav links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  
  // Mobile menu
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  mobileMenuBtn?.addEventListener('click', () => {
    const navLinks = document.querySelector('.nav-links');
    if (navLinks.style.display === 'flex') {
      navLinks.style.display = 'none';
    } else {
      navLinks.style.cssText = `
        display: flex;
        position: fixed;
        top: 70px;
        left: 0;
        right: 0;
        flex-direction: column;
        background: rgba(3,3,3,0.98);
        padding: 24px;
        gap: 16px;
        border-bottom: 1px solid var(--border);
      `;
    }
  });
});

// Initialize leaderboard after raffle loads
(async function initializeLeaderboard() {
  const checkReady = setInterval(async () => {
    if (CONFIG.ALCHEMY_API_KEY && 
        document.getElementById('leaderboardList') && 
        raffleState.eligibleNFTs.length > 0) {
      clearInterval(checkReady);
      await loadLeaderboard();
    }
  }, 100);
})();
