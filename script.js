// Enhanced NFT Grid Maker Script with Secure API Integration
// ============================================
// CONFIGURATION & API MANAGEMENT
// ============================================
let CONFIG = {
  ALCHEMY_API_KEY: null,
  OPENSEA_API_KEY: null,
  MORALIS_API_KEY: null,
  BASED_UNDEADS_CONTRACT: '0x4aec4eddfab595c04557f78178f0962e46a02989',
  BASE_CHAIN_ID: 8453
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
let selectedCollectionNFTs = [];
let selectedNFTsForGrid = new Set();
let coverElements = [];
let selectedCoverElement = null;
let isDragging = false;
let isResizing = false;
let dragOffset = { x: 0, y: 0 };
let originalImageData = new Map();

// ============================================
// API KEY INITIALIZATION
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
// WALLET INTEGRATION
// ============================================
async function fetchWalletNFTs() {
  const walletInput = document.getElementById('walletAddress');
  const wallet = walletInput.value.trim();
  
  if (!wallet || (!wallet.startsWith('0x') && !wallet.endsWith('.eth'))) {
    showNotification('Please enter a valid wallet address or ENS name', 'error');
    return;
  }
  
  // Resolve ENS if needed
  let resolvedAddress = wallet;
  if (wallet.endsWith('.eth')) {
    resolvedAddress = await resolveENS(wallet);
    if (!resolvedAddress) {
      showNotification('Could not resolve ENS name', 'error');
      return;
    }
  }
  
  userWalletAddress = resolvedAddress;
  await loadWalletCollections(resolvedAddress);
}

async function resolveENS(ensName) {
  try {
    const response = await fetch(
      `https://eth-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_API_KEY}/resolveName?name=${ensName}`
    );
    const data = await response.json();
    return data.address;
  } catch (error) {
    console.error('ENS resolution failed:', error);
    return null;
  }
}

async function loadWalletCollections(walletAddress) {
  const chain = SUPPORTED_CHAINS[currentChain];
  const nftGrid = document.getElementById('nftGrid');
  nftGrid.innerHTML = '<div class="text-center py-8">Loading your NFTs...</div>';
  
  try {
    const seenNFTs = new Set();
    let allNFTs = [];

    // Fetch from OpenSea
    try {
      console.log('Fetching NFTs from OpenSea...');
      const openSeaUrl = `${BASE_API_URL}/chain/${chain.apiEndpoint}/account/${walletAddress}/nfts?limit=100`;
      const openSeaResponse = await fetch(openSeaUrl, {
        headers: {
          'X-API-KEY': CONFIG.OPENSEA_API_KEY,
          'accept': 'application/json'
        }
      });
      
      if (openSeaResponse.ok) {
        const openSeaData = await openSeaResponse.json();
        if (openSeaData.nfts && openSeaData.nfts.length > 0) {
          console.log(`Found ${openSeaData.nfts.length} NFTs from OpenSea`);
          openSeaData.nfts.forEach(nft => {
            const uniqueId = `${nft.contract || ''}_${nft.identifier || ''}`;
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
        }
      }
    } catch (error) {
      console.error('OpenSea API Error:', error);
    }

    // Fetch from Moralis
    if (CONFIG.MORALIS_API_KEY) {
      try {
        console.log('Fetching NFTs from Moralis...');
        const moralisUrl = `${MORALIS_API_URL}/${walletAddress}/nft?chain=${chain.moralisChain}&format=decimal&limit=100`;
        const moralisResponse = await fetch(moralisUrl, {
          headers: {
            'X-API-Key': CONFIG.MORALIS_API_KEY
          }
        });
        
        if (moralisResponse.ok) {
          const moralisData = await moralisResponse.json();
          if (moralisData.result && moralisData.result.length > 0) {
            console.log(`Found ${moralisData.result.length} NFTs from Moralis`);
            moralisData.result.forEach(nft => {
              const uniqueId = `${nft.token_address || ''}_${nft.token_id || ''}`;
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
          }
        }
      } catch (error) {
        console.error('Moralis API Error:', error);
      }
    }

    // Fetch from Alchemy
    try {
      console.log('Fetching NFTs from Alchemy...');
      const alchemyUrl = `https://${chain.alchemyNetwork}.g.alchemy.com/nft/v3/${CONFIG.ALCHEMY_API_KEY}/getNFTsForOwner?owner=${walletAddress}&withMetadata=true&pageSize=100`;
      
      const alchemyResponse = await fetch(alchemyUrl);
      
      if (alchemyResponse.ok) {
        const alchemyData = await alchemyResponse.json();
        if (alchemyData.ownedNfts && alchemyData.ownedNfts.length > 0) {
          console.log(`Found ${alchemyData.ownedNfts.length} NFTs from Alchemy`);
          alchemyData.ownedNfts.forEach(nft => {
            const uniqueId = `${nft.contract?.address || ''}_${nft.tokenId || ''}`;
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
        }
      }
    } catch (error) {
      console.error('Alchemy API Error:', error);
    }

    console.log(`Total unique NFTs found: ${allNFTs.length}`);
    
    if (allNFTs.length === 0) {
      nftGrid.innerHTML = '<div class="text-center py-8 text-yellow-400">No NFTs found in this wallet</div>';
      return;
    }
    
    // Process NFTs by collection
    processNFTsByCollection(allNFTs);
    displayCollectionSelector();
    
  } catch (error) {
    console.error('Error fetching NFTs:', error);
    nftGrid.innerHTML = '<div class="text-center py-8 text-red-400">Error loading NFTs</div>';
  }
}

function processNFTsByCollection(nfts) {
  userCollections.clear();
  
  nfts.forEach(nft => {
    if (!nft.contractAddress) return;
    
    const collectionKey = nft.contractAddress.toLowerCase();
    const collectionName = nft.collection || 'Unknown Collection';
    
    // Skip spam collections
    if (isSpamCollection(collectionName)) return;
    
    if (!userCollections.has(collectionKey)) {
      userCollections.set(collectionKey, {
        name: collectionName,
        contract: nft.contractAddress,
        nfts: []
      });
    }
    
    const imageUrl = nft.image?.cachedUrl || 
                    nft.image?.thumbnailUrl || 
                    nft.raw?.metadata?.image || 
                    '';
    
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
  
  // Remove collections with no valid NFTs
  for (const [key, collection] of userCollections.entries()) {
    if (collection.nfts.length === 0) {
      userCollections.delete(key);
    }
  }
}

function isSpamCollection(name) {
  const nameLower = name.toLowerCase();
  const spamKeywords = [
    'claim', 'reward', 'visit', 'voucher', 'airdrop', 'free mint',
    '.com', '.io', '.xyz', 'http', 'www.', '$', 'usd'
  ];
  return spamKeywords.some(keyword => nameLower.includes(keyword));
}

function displayCollectionSelector() {
  const collectionSection = document.getElementById('collectionSection');
  const collectionSelect = document.getElementById('collectionSelect');
  
  collectionSelect.innerHTML = '<option value="">Choose a collection...</option>';
  
  const sortedCollections = Array.from(userCollections.values())
    .sort((a, b) => b.nfts.length - a.nfts.length);
  
  sortedCollections.forEach(collection => {
    const option = document.createElement('option');
    option.value = collection.contract;
    option.textContent = `${collection.name} (${collection.nfts.length} NFTs)`;
    collectionSelect.appendChild(option);
  });
  
  collectionSection.classList.remove('hidden');
  
  const nftGrid = document.getElementById('nftGrid');
  nftGrid.innerHTML = `<div class="text-center text-[#00ff88] py-8">✓ Found ${sortedCollections.length} collections! Select one above</div>`;
}

// ============================================
// COLLECTION DISPLAY
// ============================================
document.getElementById('collectionSelect')?.addEventListener('change', function() {
  const selectedContract = this.value;
  if (!selectedContract) return;
  
  const collection = userCollections.get(selectedContract.toLowerCase());
  if (collection) {
    selectedCollectionNFTs = collection.nfts;
    displayNFTs(collection.nfts);
  }
});

function displayNFTs(nfts) {
  const nftGrid = document.getElementById('nftGrid');
  nftGrid.innerHTML = '';
  
  nfts.forEach((nft, index) => {
    const div = document.createElement('div');
    div.className = 'relative group cursor-pointer';
    div.innerHTML = `
      <img src="${nft.image}" 
           alt="${nft.name}" 
           class="nft-thumbnail" 
           data-index="${index}"
           loading="lazy"
           onerror="this.src='https://placehold.co/300x300/1a1a1a/00ff88/png?text=NFT'"/>
      <div class="absolute inset-0 bg-black bg-opacity-0 hover:bg-opacity-20 transition-all"></div>
      <p class="text-xs text-center mt-2 truncate px-1">${nft.name}</p>
    `;
    
    // Add click handler for grid selection
    div.addEventListener('click', () => handleNFTSelection(index, div));
    
    // Add click handler for cover maker - always attach
    div.addEventListener('click', (e) => {
      if (!document.getElementById('coverMakerSection').classList.contains('hidden')) {
        e.stopPropagation();
        addNFTToCover(nft, index);
      }
    });
    
    nftGrid.appendChild(div);
  });
}

function handleNFTSelection(index, element) {
  const selectionMode = document.querySelector('input[name="selectionMode"]:checked')?.value;
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
// GRID MAKER FUNCTIONALITY
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
  
  // Fill background
  ctx.fillStyle = separatorColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  // Load and draw images
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
  preview.style.maxWidth = '100%';
  preview.style.maxHeight = 'none';
  preview.style.overflow = 'auto';
  
  const img = document.createElement('img');
  img.src = canvas.toDataURL();
  img.style.width = '100%';
  img.style.height = 'auto';
  img.style.display = 'block';
  preview.appendChild(img);
  
  container.classList.remove('hidden');
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
  document.getElementById('gridPreviewContainer').classList.add('hidden');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function getProxiedImageUrl(url) {
  if (!url) return 'https://placehold.co/300x300/1a1a1a/00ff88/png?text=NFT';
  
  // Handle IPFS URLs
  if (url.startsWith('ipfs://')) {
    const hash = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${hash}`;
  }
  
  // Handle Arweave URLs
  if (url.startsWith('ar://')) {
    const hash = url.replace('ar://', '');
    return `https://arweave.net/${hash}`;
  }
  
  return url;
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `fixed top-4 right-4 px-6 py-3 rounded-lg text-white z-50 ${
    type === 'error' ? 'bg-red-500' : 
    type === 'success' ? 'bg-green-500' : 
    'bg-blue-500'
  }`;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// ============================================
// FEATURED UNDEADS CAROUSEL
// ============================================
async function loadFeaturedUndeads() {
  const nftScroller = document.getElementById('nftScroller');
  if (!nftScroller) return;
  
  nftScroller.innerHTML = '<div class="text-center py-8">Loading Featured Undeads...</div>';
  
  try {
    const response = await fetch(
      `https://api.opensea.io/api/v2/chain/base/contract/${CONFIG.BASED_UNDEADS_CONTRACT}/nfts?limit=50`,
      {
        headers: {
          'accept': 'application/json',
          'x-api-key': CONFIG.OPENSEA_API_KEY
        }
      }
    );
    
    if (response.ok) {
      const data = await response.json();
      if (data.nfts && data.nfts.length > 0) {
        displayFeaturedNFTs(data.nfts);
      }
    }
  } catch (error) {
    console.error('Error loading featured undeads:', error);
    loadFallbackUndeads();
  }
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
                   'https://placehold.co/200x200/1a1a1a/00ff88/png?text=Undead';
  const tokenId = nft.identifier;
  const name = nft.name || `Based Undead #${tokenId}`;
  
  card.innerHTML = `
    <a href="https://opensea.io/assets/base/${CONFIG.BASED_UNDEADS_CONTRACT}/${tokenId}" 
       target="_blank" class="block">
      <img src="${imageUrl}" 
           alt="${name}" 
           loading="lazy"/>
      <p class="text-center mt-2 text-xs sm:text-sm pixel-font text-white">${name}</p>
    </a>
  `;
  
  return card;
}

function loadFallbackUndeads() {
  const nftScroller = document.getElementById('nftScroller');
  const placeholders = Array(20).fill(0).map((_, i) => ({
    identifier: i + 1,
    name: `Based Undead #${i + 1}`,
    image_url: 'https://placehold.co/200x200/1a1a1a/00ff88/png?text=Undead'
  }));
  displayFeaturedNFTs(placeholders);
}

// ============================================
// CHAIN SELECTOR
// ============================================
document.getElementById('chainSelect')?.addEventListener('change', function() {
  currentChain = this.value;
  userCollections.clear();
  selectedCollectionNFTs = [];
  selectedNFTsForGrid.clear();
  
  document.getElementById('collectionSection').classList.add('hidden');
  document.getElementById('nftGrid').innerHTML = '';
  
  showNotification(`Switched to ${SUPPORTED_CHAINS[currentChain].name}`, 'info');
});

// ============================================
// GRID OPTIONS HANDLERS
// ============================================
document.getElementById('gridMode')?.addEventListener('change', function() {
  document.getElementById('gridOptions').classList.toggle('hidden', !this.checked);
});

document.getElementById('gridSize')?.addEventListener('change', function() {
  const customInput = document.getElementById('customGridSizeInput');
  if (this.value === 'custom') {
    customInput.classList.remove('hidden');
  } else {
    customInput.classList.add('hidden');
  }
});

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', async function() {
  // Initialize API keys first
  const keysLoaded = await initializeAPIKeys();
  if (!keysLoaded) return;
  
  // Chain selector is already populated in HTML, just set the default
  const chainSelect = document.getElementById('chainSelect');
  if (chainSelect) {
    chainSelect.value = currentChain;
  }
  
  // Load featured NFTs if on homepage
  if (document.getElementById('nftScroller')) {
    loadFeaturedUndeads();
  }
  
  // Set up event listeners
  document.getElementById('fetchNFTs')?.addEventListener('click', fetchWalletNFTs);
  document.getElementById('previewGrid')?.addEventListener('click', previewGrid);
  document.getElementById('downloadGrid')?.addEventListener('click', downloadGrid);
  document.getElementById('downloadAll')?.addEventListener('click', downloadAllAsZip);
  document.getElementById('resetGrid')?.addEventListener('click', resetGrid);

  // Cover size change listener
  document.getElementById('coverSize')?.addEventListener('change', () => {
    updateCanvasSize();
    renderCover();
  });
  
  // Theme switcher
  setupThemeSwitcher();
  
  // Cover maker
  setupCoverMaker();
});

// ============================================
// THEME SYSTEM
// ============================================
function setupThemeSwitcher() {
  const themes = ['normal', 'glass', 'dark'];
  let currentThemeIndex = 0;
  
  const themeToggle = document.getElementById('themeToggle');
  const themeLabel = document.getElementById('themeLabel');
  
  if (!themeToggle || !themeLabel) return;
  
  const savedTheme = localStorage.getItem('basedUndeadsTheme') || 'normal';
  currentThemeIndex = themes.indexOf(savedTheme);
  applyTheme(savedTheme);
  
  themeToggle.addEventListener('click', () => {
    currentThemeIndex = (currentThemeIndex + 1) % themes.length;
    const newTheme = themes[currentThemeIndex];
    applyTheme(newTheme);
    localStorage.setItem('basedUndeadsTheme', newTheme);
  });
  
  function applyTheme(theme) {
    document.body.classList.remove('theme-glass', 'theme-dark');
    
    if (theme === 'glass') {
      document.body.classList.add('theme-glass');
      themeLabel.textContent = 'Glass';
    } else if (theme === 'dark') {
      document.body.classList.add('theme-dark');
      themeLabel.textContent = 'Dark';
    } else {
      themeLabel.textContent = 'Normal';
    }
  }
}

// ============================================
// COVER MAKER SETUP
// ============================================
function setupCoverMaker() {
  const coverMakerBtn = document.getElementById('openCoverMaker');
  if (!coverMakerBtn) return;
  
  const coverCanvas = document.getElementById('coverCanvas');
  const trashBin = document.getElementById('trashBin');
  
  coverMakerBtn.addEventListener('click', () => {
    const section = document.getElementById('coverMakerSection');
    section.classList.toggle('hidden');
    if (!section.classList.contains('hidden')) {
      section.scrollIntoView({ behavior: 'smooth' });
      initCoverCanvas();
    }
  });
  
  // Cover size change listener
  document.getElementById('coverSize')?.addEventListener('change', () => {
    updateCanvasSize();
    renderCover();
  });
  
  // Text toggle
  document.getElementById('coverAddText')?.addEventListener('change', (e) => {
    document.getElementById('coverTextOptions').classList.toggle('hidden', !e.target.checked);
    if (e.target.checked && !coverElements.find(el => el.type === 'text')) {
      addTextToCover();
    } else if (!e.target.checked) {
      coverElements = coverElements.filter(el => el.type !== 'text');
      renderCover();
    }
  });
  
  // Text styling updates
  ['coverTextSize', 'coverText', 'coverTextColor', 'coverTextColor2', 'coverFontFamily', 'coverTextStyle', 'coverTextBold', 'coverTextItalic', 'coverTextUnderline'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    
    el.addEventListener(id === 'coverTextSize' ? 'input' : 'change', () => {
      if (id === 'coverTextSize') {
        document.getElementById('coverTextSizeValue').textContent = el.value + 'px';
      }
      const textEl = coverElements.find(el => el.type === 'text');
      if (textEl) {
        if (id === 'coverText') textEl.text = el.value;
        if (id === 'coverTextSize') textEl.size = parseInt(el.value);
        if (id === 'coverTextColor') textEl.color = el.value;
        if (id === 'coverTextColor2') textEl.color2 = el.value;
        if (id === 'coverFontFamily') textEl.font = el.value;
        if (id === 'coverTextStyle') textEl.style = el.value;
        if (id === 'coverTextBold') textEl.bold = el.checked;
        if (id === 'coverTextItalic') textEl.italic = el.checked;
        if (id === 'coverTextUnderline') textEl.underline = el.checked;
        renderCover();
      }
    });
  });
  
  // Background changes
  document.getElementById('coverGradient')?.addEventListener('change', renderCover);
  document.getElementById('coverBgColor')?.addEventListener('change', () => {
    document.getElementById('coverGradient').value = '';
    renderCover();
  });
  
  // Reset cover button
  document.getElementById('resetCover')?.addEventListener('click', () => {
    coverElements = [];
    selectedCoverElement = null;
    originalImageData.clear();
    trashBin?.classList.add('hidden');
    document.getElementById('coverSelectedNFTs').innerHTML = '<p class="text-white/60 text-sm">Select NFTs from your wallet below</p>';
    document.getElementById('coverAddText').checked = false;
    document.getElementById('coverTextOptions').classList.add('hidden');
    renderCover();
  });
  
  // Download cover button
  document.getElementById('downloadCover')?.addEventListener('click', () => {
    coverCanvas.toBlob(blob => {
      const link = document.createElement('a');
      link.download = 'nft-cover.png';
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    });
  });
  
  // Quick actions
  document.getElementById('removeAllBg')?.addEventListener('click', () => {
    coverElements.filter(el => el.type === 'nft').forEach(el => {
      if (!el.bgRemoved) removeBackground(el);
    });
  });
  
  document.getElementById('resetAllSizes')?.addEventListener('click', () => {
    coverElements.filter(el => el.type === 'nft').forEach(el => {
      el.width = 200;
      el.height = 200;
    });
    renderCover();
  });
  
  document.getElementById('arrangeGrid')?.addEventListener('click', () => {
    const nftElements = coverElements.filter(el => el.type === 'nft');
    const cols = Math.ceil(Math.sqrt(nftElements.length));
    const spacing = 50;
    const size = 180;
    
    nftElements.forEach((el, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      el.x = spacing + col * (size + spacing);
      el.y = spacing + row * (size + spacing);
      el.width = size;
      el.height = size;
    });
    renderCover();
  });
  
  // Trash bin click
  trashBin?.addEventListener('click', () => {
    if (selectedCoverElement) {
      const index = coverElements.indexOf(selectedCoverElement);
      if (index > -1) {
        coverElements.splice(index, 1);
        selectedCoverElement = null;
        trashBin.classList.add('hidden');
        updateCoverSelectedDisplay();
        renderCover();
      }
    }
  });
  
  // Canvas mouse events
  setupCanvasMouseEvents(coverCanvas, trashBin);
}

function initCoverCanvas() {
  const canvas = document.getElementById('coverCanvas');
  if (!canvas) return;
  
  updateCanvasSize();
  renderCover();
}

function updateCanvasSize() {
  const canvas = document.getElementById('coverCanvas');
  const sizeSelect = document.getElementById('coverSize');
  const size = sizeSelect.value.split('x');
  const width = parseInt(size[0]);
  const height = parseInt(size[1]);
  
  canvas.width = width;
  canvas.height = height;
  
  const container = document.getElementById('coverCanvasContainer');
  if (container) {
    container.style.aspectRatio = `${width}/${height}`;
  }
}

function updateCanvasSize() {
  const canvas = document.getElementById('coverCanvas');
  const sizeSelect = document.getElementById('coverSize');
  const size = sizeSelect.value.split('x');
  const width = parseInt(size[0]);
  const height = parseInt(size[1]);
  
  canvas.width = width;
  canvas.height = height;
  
  const container = canvas.parentElement;
  container.style.aspectRatio = `${width}/${height}`;
}

function renderCover() {
  const coverCanvas = document.getElementById('coverCanvas');
  if (!coverCanvas) return;
  
  const ctx = coverCanvas.getContext('2d');
  const gradient = document.getElementById('coverGradient')?.value;
  const bgColor = document.getElementById('coverBgColor')?.value || '#2d5f54';
  
  // Clear and fill background
  if (gradient) {
    const colors = gradient.match(/#[0-9a-f]{6}/gi) || [];
    if (colors.length >= 2) {
      const grad = ctx.createLinearGradient(0, 0, coverCanvas.width, coverCanvas.height);
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(1, colors[1]);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = bgColor;
    }
  } else {
    ctx.fillStyle = bgColor;
  }
  
  ctx.fillRect(0, 0, coverCanvas.width, coverCanvas.height);
  
  // Draw alignment guides if element is selected
  if (selectedCoverElement) {
    drawAlignmentGuides(ctx, coverCanvas, selectedCoverElement);
  }
  
  // Render cover elements
  coverElements.forEach(el => {
    if (el.type === 'nft' && el.image) {
      ctx.save();
      ctx.translate(el.x + el.width/2, el.y + el.height/2);
      ctx.rotate(el.rotation * Math.PI / 180);
      ctx.drawImage(el.image, -el.width/2, -el.height/2, el.width, el.height);
      ctx.restore();
      
      // Draw selection outline and resize handle
      if (el === selectedCoverElement) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 5]);
        ctx.strokeRect(el.x - 5, el.y - 5, el.width + 10, el.height + 10);
        ctx.setLineDash([]);
        
        // Draw resize handle
        ctx.fillStyle = '#00ff88';
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(el.x + el.width, el.y + el.height, 10, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
    } else if (el.type === 'text') {
      ctx.save();
      
      let fontStyle = '';
      if (el.italic) fontStyle += 'italic ';
      if (el.bold) fontStyle += 'bold ';
      ctx.font = `${fontStyle}${el.size}px ${el.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      if (el.style === 'gradient') {
        const grad = ctx.createLinearGradient(el.x - 200, el.y, el.x + 200, el.y);
        grad.addColorStop(0, el.color);
        grad.addColorStop(1, el.color2);
        ctx.fillStyle = grad;
        ctx.fillText(el.text, el.x, el.y);
      } else if (el.style === 'stroke') {
        ctx.strokeStyle = el.color;
        ctx.lineWidth = 3;
        ctx.strokeText(el.text, el.x, el.y);
      } else if (el.style === 'shadow') {
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 5;
        ctx.fillStyle = el.color;
        ctx.fillText(el.text, el.x, el.y);
      } else {
        ctx.fillStyle = el.color;
        ctx.fillText(el.text, el.x, el.y);
      }
      
      if (el.underline) {
        const metrics = ctx.measureText(el.text);
        ctx.strokeStyle = el.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(el.x - metrics.width/2, el.y + el.size/2 + 5);
        ctx.lineTo(el.x + metrics.width/2, el.y + el.size/2 + 5);
        ctx.stroke();
      }
      
      if (el === selectedCoverElement) {
        const metrics = ctx.measureText(el.text);
        const textWidth = metrics.width;
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(el.x - textWidth/2 - 10, el.y - el.size/2 - 10, textWidth + 20, el.size + 20);
        ctx.setLineDash([]);
      }
      
      ctx.restore();
    }
  });
}

// Canva-style alignment guides
function drawAlignmentGuides(ctx, canvas, element) {
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const snapDistance = 10;
  
  ctx.save();
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  
  // Check if element is near center horizontally
  if (Math.abs(element.x + element.width/2 - centerX) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, canvas.height);
    ctx.stroke();
  }
  
  // Check if element is near center vertically
  if (Math.abs(element.y + element.height/2 - centerY) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(canvas.width, centerY);
    ctx.stroke();
  }
  
  // Check if element is near left edge
  if (Math.abs(element.x) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, canvas.height);
    ctx.stroke();
  }
  
  // Check if element is near right edge
  if (Math.abs(element.x + element.width - canvas.width) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(canvas.width, 0);
    ctx.lineTo(canvas.width, canvas.height);
    ctx.stroke();
  }
  
  // Check if element is near top edge
  if (Math.abs(element.y) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(canvas.width, 0);
    ctx.stroke();
  }
  
  // Check if element is near bottom edge
  if (Math.abs(element.y + element.height - canvas.height) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    ctx.lineTo(canvas.width, canvas.height);
    ctx.stroke();
  }
  
  ctx.restore();
}

async function addNFTToCover(nft, index) {
  // Check if NFT already added
  if (coverElements.find(el => el.nftIndex === index)) {
    showNotification('NFT already added to cover!', 'info');
    return;
  }
  
  const img = new Image();
  img.crossOrigin = 'anonymous';
  
  img.onload = () => {
    const canvas = document.getElementById('coverCanvas');
    const size = 200;
    const x = Math.random() * (canvas.width - size);
    const y = Math.random() * (canvas.height - size);
    
    // Store original image data for background removal
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0);
    originalImageData.set(index, tempCtx.getImageData(0, 0, img.width, img.height));
    
    const element = {
      type: 'nft',
      image: img,
      x: x,
      y: y,
      width: size,
      height: size,
      nftIndex: index,
      rotation: 0,
      bgRemoved: false
    };
    
    coverElements.push(element);
    updateCoverSelectedDisplay();
    renderCover();
    showNotification('NFT added to cover!', 'success');
  };
  
  img.onerror = () => {
    showNotification('Failed to load NFT image', 'error');
  };
  
  img.src = nft.image;
}

function updateCoverSelectedDisplay() {
  const container = document.getElementById('coverSelectedNFTs');
  const nfts = coverElements.filter(el => el.type === 'nft');
  
  if (nfts.length === 0) {
    container.innerHTML = '<p class="text-white/60 text-sm">Click NFTs from your wallet below to add them</p>';
    return;
  }
  
  container.innerHTML = nfts.map((el, idx) => {
    const nft = selectedCollectionNFTs[el.nftIndex];
    return `
      <div class="relative group">
        <img src="${el.image.src}" 
             class="w-20 h-20 rounded-lg border-2 border-[#00ff88] object-cover" 
             alt="${nft?.name || 'NFT'}"/>
        <button onclick="removeCoverElementByIndex(${coverElements.indexOf(el)})" 
                class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity">
          ×
        </button>
      </div>
    `;
  }).join('');
}

function removeCoverElementByIndex(index) {
  coverElements.splice(index, 1);
  updateCoverSelectedDisplay();
  renderCover();
}

function addTextToCover() {
  const text = document.getElementById('coverText').value || 'Your Text Here';
  const color = document.getElementById('coverTextColor').value;
  const color2 = document.getElementById('coverTextColor2').value;
  const size = parseInt(document.getElementById('coverTextSize').value);
  const font = document.getElementById('coverFontFamily').value;
  const style = document.getElementById('coverTextStyle').value;
  
  const canvas = document.getElementById('coverCanvas');
  
  coverElements.push({
    type: 'text',
    text: text,
    x: canvas.width / 2,
    y: canvas.height / 2,
    color: color,
    color2: color2,
    size: size,
    font: font,
    style: style,
    bold: false,
    italic: false,
    underline: false
  });
  
  renderCover();
}

function removeBackground(element) {
  if (element.type !== 'nft' || !element.image) return;
  
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = element.image.width;
  tempCanvas.height = element.image.height;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(element.image, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  const data = imageData.data;
  
  // Sample corner colors
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
  
  const threshold = 40;
  
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
  
  const newImg = new Image();
  newImg.onload = () => {
    element.image = newImg;
    element.bgRemoved = true;
    renderCover();
    showNotification('Background removed!', 'success');
  };
  newImg.src = tempCanvas.toDataURL();
}

function setupCanvasMouseEvents(coverCanvas, trashBin) {
  // Helper functions
  function isOverResizeHandle(mouseX, mouseY, el) {
    if (el.type !== 'nft') return false;
    const handleX = el.x + el.width;
    const handleY = el.y + el.height;
    const distance = Math.sqrt(Math.pow(mouseX - handleX, 2) + Math.pow(mouseY - handleY, 2));
    return distance < 15;
  }
  
  function getElementAtPosition(mouseX, mouseY) {
    for (let i = coverElements.length - 1; i >= 0; i--) {
      const el = coverElements[i];
      if (el.type === 'nft') {
        if (mouseX >= el.x && mouseX <= el.x + el.width &&
            mouseY >= el.y && mouseY <= el.y + el.height) {
          return el;
        }
      } else if (el.type === 'text') {
        const ctx = coverCanvas.getContext('2d');
        ctx.font = `${el.size}px ${el.font}`;
        const metrics = ctx.measureText(el.text);
        const textWidth = metrics.width;
        const textHeight = el.size;
        
        if (mouseX >= el.x - textWidth/2 && mouseX <= el.x + textWidth/2 &&
            mouseY >= el.y - textHeight/2 && mouseY <= el.y + textHeight/2) {
          return el;
        }
      }
    }
    return null;
  }
  
  // Mouse move
  coverCanvas.addEventListener('mousemove', (e) => {
    const rect = coverCanvas.getBoundingClientRect();
    const scaleX = coverCanvas.width / rect.width;
    const scaleY = coverCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    
    if (isResizing && selectedCoverElement) {
      const newWidth = Math.max(50, mouseX - selectedCoverElement.x);
      const newHeight = Math.max(50, mouseY - selectedCoverElement.y);
      selectedCoverElement.width = newWidth;
      selectedCoverElement.height = newHeight;
      renderCover();
      return;
    }
    
    if (isDragging && selectedCoverElement) {
      let newX = mouseX - dragOffset.x;
      let newY = mouseY - dragOffset.y;
      
      // Snap to alignment
      const snapDistance = 10;
      const centerX = coverCanvas.width / 2;
      const centerY = coverCanvas.height / 2;
      const elementCenterX = newX + selectedCoverElement.width / 2;
      const elementCenterY = newY + selectedCoverElement.height / 2;
      
      if (Math.abs(elementCenterX - centerX) < snapDistance) {
        newX = centerX - selectedCoverElement.width / 2;
      }
      if (Math.abs(elementCenterY - centerY) < snapDistance) {
        newY = centerY - selectedCoverElement.height / 2;
      }
      if (Math.abs(newX) < snapDistance) {
        newX = 0;
      }
      if (Math.abs(newX + selectedCoverElement.width - coverCanvas.width) < snapDistance) {
        newX = coverCanvas.width - selectedCoverElement.width;
      }
      if (Math.abs(newY) < snapDistance) {
        newY = 0;
      }
      if (Math.abs(newY + selectedCoverElement.height - coverCanvas.height) < snapDistance) {
        newY = coverCanvas.height - selectedCoverElement.height;
      }
      
      selectedCoverElement.x = newX;
      selectedCoverElement.y = newY;
      renderCover();
      return;
    }
    
    // Update cursor
    if (selectedCoverElement && isOverResizeHandle(mouseX, mouseY, selectedCoverElement)) {
      coverCanvas.classList.add('resize-cursor');
      coverCanvas.classList.remove('move-cursor');
    } else if (getElementAtPosition(mouseX, mouseY)) {
      coverCanvas.classList.add('move-cursor');
      coverCanvas.classList.remove('resize-cursor');
    } else {
      coverCanvas.classList.remove('resize-cursor', 'move-cursor');
    }
  });
  
  // Mouse down
  coverCanvas.addEventListener('mousedown', (e) => {
    const rect = coverCanvas.getBoundingClientRect();
    const scaleX = coverCanvas.width / rect.width;
    const scaleY = coverCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    
    if (selectedCoverElement && isOverResizeHandle(mouseX, mouseY, selectedCoverElement)) {
      isResizing = true;
      return;
    }
    
    const clickedElement = getElementAtPosition(mouseX, mouseY);
    
    if (clickedElement) {
      selectedCoverElement = clickedElement;
      isDragging = true;
      dragOffset.x = mouseX - clickedElement.x;
      dragOffset.y = mouseY - clickedElement.y;
      trashBin?.classList.remove('hidden');
      renderCover();
    } else {
      selectedCoverElement = null;
      trashBin?.classList.add('hidden');
      renderCover();
    }
  });
  
  // Mouse up
  coverCanvas.addEventListener('mouseup', () => {
    isDragging = false;
    isResizing = false;
  });
  
  // Mouse leave
  coverCanvas.addEventListener('mouseleave', () => {
    isDragging = false;
    isResizing = false;
    coverCanvas.classList.remove('resize-cursor', 'move-cursor');
  });
  
  // Right click for background removal
  coverCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = coverCanvas.getBoundingClientRect();
    const scaleX = coverCanvas.width / rect.width;
    const scaleY = coverCanvas.height / rect.height;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    
    const el = getElementAtPosition(mouseX, mouseY);
    if (el && el.type === 'nft') {
      const action = confirm('Remove background for this NFT?');
      if (action) {
        removeBackground(el);
      }
    }
  });
}
