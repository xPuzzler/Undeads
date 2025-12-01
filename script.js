
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
let selectedCollectionNFTs = [];
let selectedNFTsForGrid = new Set();
let coverElements = [];
let selectedCoverElement = null;
let isDragging = false;
let isResizing = false;
let dragOffset = { x: 0, y: 0 };
let originalImageData = new Map();

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

function normalizeTokenId(tokenId) {
  if (!tokenId) return '';
  if (typeof tokenId === 'string' && tokenId.startsWith('0x')) {
    return parseInt(tokenId, 16).toString();
  }
  return tokenId.toString();
}

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
    const response = await fetch(
      `https://api.ensdata.net/${ensName}`
    );
    
    if (!response.ok) {
      throw new Error(`ENS API returned status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data && data.address) {
      console.log(`✓ ENS resolved: ${ensName} → ${data.address}`);
      return data.address;
    }
    
    const backupResponse = await fetch(
      `https://api.web3.bio/profile/ens/${ensName}`
    );
    
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
  nftGrid.innerHTML = '<div class="text-center py-8">Loading your NFTs...</div>';
  
  try {
    const seenNFTs = new Set();
    let allNFTs = [];

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
    console.log(`Total entries in seenNFTs: ${seenNFTs.size}`);
    
    if (allNFTs.length === 0) {
      nftGrid.innerHTML = '<div class="text-center py-8 text-yellow-400">No NFTs found in this wallet</div>';
      return;
    }
    
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
    
    div.addEventListener('click', () => handleNFTSelection(index, div));
    
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

function getProxiedImageUrl(url) {
  if (!url) return 'https://placehold.co/300x300/1a1a1a/00ff88/png?text=NFT';
  
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

async function loadFeaturedUndeads() {
  const nftScroller = document.getElementById('nftScroller');
  if (!nftScroller) return;
  
  nftScroller.innerHTML = '<div class="text-center py-8">Loading Featured Undeads...</div>';
  
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
    <div class="text-center py-8 text-white/60">
      <p>Unable to load Featured Undeads at the moment</p>
      <p class="text-sm mt-2">Please check back soon or visit <a href="https://opensea.io/collection/basedundeads/overview" target="_blank" class="text-[#00ff88] hover:underline">OpenSea</a></p>
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

document.getElementById('chainSelect')?.addEventListener('change', function() {
  currentChain = this.value;
  userCollections.clear();
  selectedCollectionNFTs = [];
  selectedNFTsForGrid.clear();
  
  document.getElementById('collectionSection').classList.add('hidden');
  document.getElementById('nftGrid').innerHTML = '';
  
  showNotification(`Switched to ${SUPPORTED_CHAINS[currentChain].name}`, 'info');
});

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

document.addEventListener('DOMContentLoaded', async function() {
  
  const keysLoaded = await initializeAPIKeys();
  if (!keysLoaded) return;
  
  const chainSelect = document.getElementById('chainSelect');
  if (chainSelect) {
    chainSelect.value = currentChain;
  }
  
  if (document.getElementById('nftScroller')) {
    loadFeaturedUndeads();
  }
  
  document.getElementById('fetchNFTs')?.addEventListener('click', fetchWalletNFTs);
  document.getElementById('previewGrid')?.addEventListener('click', previewGrid);
  document.getElementById('downloadGrid')?.addEventListener('click', downloadGrid);
  document.getElementById('downloadAll')?.addEventListener('click', downloadAllAsZip);
  document.getElementById('resetGrid')?.addEventListener('click', resetGrid);

  document.getElementById('coverSize')?.addEventListener('change', () => {
    updateCanvasSize();
    renderCover();
  });
  
  setupThemeSwitcher();
  
  setupCoverMaker();
});

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
  
  document.getElementById('coverSize')?.addEventListener('change', () => {
    updateCanvasSize();
    renderCover();
  });
  
  document.getElementById('coverAddText')?.addEventListener('change', (e) => {
    document.getElementById('coverTextOptions').classList.toggle('hidden', !e.target.checked);
    if (e.target.checked && !coverElements.find(el => el.type === 'text')) {
      addTextToCover();
    } else if (!e.target.checked) {
      coverElements = coverElements.filter(el => el.type !== 'text');
      renderCover();
    }
  });
  
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
  
  document.getElementById('coverGradient')?.addEventListener('change', renderCover);
  document.getElementById('coverBgColor')?.addEventListener('change', () => {
    document.getElementById('coverGradient').value = '';
    renderCover();
  });
  
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
  
  document.getElementById('downloadCover')?.addEventListener('click', () => {
    coverCanvas.toBlob(blob => {
      const link = document.createElement('a');
      link.download = 'nft-cover.png';
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    });
  });
  
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
  
  if (selectedCoverElement) {
    drawAlignmentGuides(ctx, coverCanvas, selectedCoverElement);
  }
  
  coverElements.forEach(el => {
    if (el.type === 'nft' && el.image) {
      ctx.save();
      ctx.translate(el.x + el.width/2, el.y + el.height/2);
      ctx.rotate(el.rotation * Math.PI / 180);
      ctx.drawImage(el.image, -el.width/2, -el.height/2, el.width, el.height);
      ctx.restore();
      
      if (el === selectedCoverElement) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 5]);
        ctx.strokeRect(el.x - 5, el.y - 5, el.width + 10, el.height + 10);
        ctx.setLineDash([]);
        
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

function drawAlignmentGuides(ctx, canvas, element) {
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const snapDistance = 10;
  
  ctx.save();
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  
  if (Math.abs(element.x + element.width/2 - centerX) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, canvas.height);
    ctx.stroke();
  }
  
  if (Math.abs(element.y + element.height/2 - centerY) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(canvas.width, centerY);
    ctx.stroke();
  }
  
  if (Math.abs(element.x) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, canvas.height);
    ctx.stroke();
  }
  
  if (Math.abs(element.x + element.width - canvas.width) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(canvas.width, 0);
    ctx.lineTo(canvas.width, canvas.height);
    ctx.stroke();
  }
  
  if (Math.abs(element.y) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(canvas.width, 0);
    ctx.stroke();
  }
  
  if (Math.abs(element.y + element.height - canvas.height) < snapDistance) {
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    ctx.lineTo(canvas.width, canvas.height);
    ctx.stroke();
  }
  
  ctx.restore();
}

async function addNFTToCover(nft, index) {
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
  
  coverCanvas.addEventListener('mouseup', () => {
    isDragging = false;
    isResizing = false;
  });
  
  coverCanvas.addEventListener('mouseleave', () => {
    isDragging = false;
    isResizing = false;
    coverCanvas.classList.remove('resize-cursor', 'move-cursor');
  });
  
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

    raffleState.shuffledEntries = [...raffleState.allEligibleEntries]
    .sort(() => Math.random() - 0.5);
    
    displayEligibleNFTs(eligibleNFTs);
    displayRewards();
    updateRaffleInfo();
    drawWheel(0);
    
    checkForListedNFTs(eligibleNFTs);
    
  } catch (error) {
    console.error('Error loading eligible NFTs:', error);
    document.getElementById('wheelStatus').textContent = 'Error loading entries';
    document.getElementById('eligibleNFTsDisplay').innerHTML = '<p class="col-span-full text-center text-red-400 py-4">Failed to load</p>';
  }
}

let autoRefreshInterval = null;

async function checkForNewMints() {
  try {
    console.log('🔄 Checking for new mints in Phase 4 range from Basescan...');
    
    const phase = RAFFLE_CONFIG.TOKEN_RANGE;
    const mintedTokens = await fetchMintedTokensFromBasescan(phase.min, phase.max);
    
    console.log(`✓ Found ${mintedTokens.length} total minted tokens from Basescan`);
    
    const currentTokenIds = new Set(raffleState.eligibleNFTs.map(nft => parseInt(nft.identifier)));
    const newTokenIds = mintedTokens.filter(tokenId => !currentTokenIds.has(tokenId));
    
    if (newTokenIds.length === 0) {
      console.log(`✓ No new mints detected (Total: ${mintedTokens.length} in range)`);
      showNotification(`No new mints. Total: ${mintedTokens.length}`, 'info');
      return;
    }
    
    console.log(`✓ Found ${newTokenIds.length} new mint(s)! Loading NFT data...`);
    
    const newNFTs = [];
    for (const tokenId of newTokenIds) {
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
          if (data.nft) {
            newNFTs.push(data.nft);
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch (error) {
        console.error(`Failed to load NFT #${tokenId}:`, error);
      }
    }
    
    if (newNFTs.length > 0) {
      console.log(`✓ Loaded data for ${newNFTs.length} new NFTs`);
      
      raffleState.eligibleNFTs.push(...newNFTs);
      raffleState.eligibleNFTs.sort((a, b) => parseInt(a.identifier) - parseInt(b.identifier));
      
      raffleState.allEligibleEntries.push(...newTokenIds);
      raffleState.allEligibleEntries.sort((a, b) => a - b);
      
      raffleState.shuffledEntries = [...raffleState.allEligibleEntries]
        .sort(() => Math.random() - 0.5);
      
      displayEligibleNFTs(raffleState.eligibleNFTs);
      updateRaffleInfo();
      drawWheel(0);
      
      showNotification(`${newNFTs.length} new mint(s) detected!`, 'success');
      
      if (leaderboardCache.data) {
        console.log('🔄 Auto-refreshing leaderboard with new mints...');
        await loadLeaderboard();
      }
    }
    
  } catch (error) {
    console.error('Error checking for new mints:', error);
    showNotification('Error checking for new mints', 'error');
  }
}

function startAutoRefresh(intervalMinutes = 2) {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }
  
  console.log(`🔄 Auto-refresh enabled (checking every ${intervalMinutes} minutes)`);
  
  checkForNewMints();
  
  autoRefreshInterval = setInterval(() => {
    checkForNewMints();
  }, intervalMinutes * 60 * 1000);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    console.log('Auto-refresh stopped');
  }
}

async function manualRefresh() {
  showNotification('Checking for new mints...', 'info');
  await checkForNewMints();
}

function displayRewards() {
  const container = document.getElementById('raffleRewardsDisplay');
  
  if (RAFFLE_CONFIG.REWARD_TOKENS.length === 0) {
    container.innerHTML = '<p class="col-span-full text-center text-white/60">Loading rewards...</p>';
    return;
  }
  
  container.innerHTML = RAFFLE_CONFIG.REWARD_TOKENS.map((reward, idx) => `
    <div class="text-center">
      <a href="${reward.openseaUrl}" target="_blank" class="block group">
        <img src="${reward.image}" 
             alt="${reward.name}" 
             class="w-full aspect-square object-cover rounded-lg border-2 border-[#00ff88] mb-2 group-hover:border-white transition-all"
             onerror="this.src='https://placehold.co/200x200/1a3a32/00ff88/png?text=Prize+${idx+1}'"/>
        <p class="text-xs pixel-font text-[#00ff88] group-hover:text-white transition-colors">Prize ${idx + 1}</p>
        <p class="text-xs text-white/60 truncate">${reward.name}</p>
      </a>
    </div>
  `).join('');
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

function displayEligibleNFTs(nfts) {
  const container = document.getElementById('eligibleNFTsDisplay');
  
  if (nfts.length === 0) {
    container.innerHTML = '<p class="col-span-full text-center text-white/60 py-4">No eligible NFTs found</p>';
    return;
  }
  
  container.innerHTML = nfts.map(nft => {
    const tokenId = parseInt(nft.identifier);
    const imageUrl = nft.image_url || nft.display_image_url || 
                     `https://placehold.co/100x100/1a3a32/00ff88/png?text=${tokenId}`;
    
    return `
      <div class="text-center">
        <img src="${imageUrl}" 
             alt="Undead #${tokenId}" 
             class="w-full aspect-square object-cover rounded-lg border border-white/20 mb-1"
             loading="lazy"
             onerror="this.src='https://placehold.co/100x100/1a3a32/00ff88/png?text=${tokenId}'"/>
        <p class="text-xs text-white/80">#${tokenId}</p>
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

  document.getElementById('raffleTokensList').innerHTML = '<p class="text-xs text-white/60 text-center py-4">Checking entries...</p>';
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
        <div class="flex flex-wrap gap-2">
          ${tokens.map(token => `
            <span class="bg-[#00ff88]/20 px-3 py-1 rounded text-xs border border-[#00ff88]">#${token}</span>
          `).join('')}
        </div>
      `;
      
      showNotification(`Found ${tokens.length} entries from leaderboard data!`, 'success');
      displayFoundRaffleNFTs(tokens);
      
    } else {
      raffleState.walletAddress = wallet;
      raffleState.eligibleTokens = [];
      document.getElementById('raffleEntriesCount').textContent = '0';
      document.getElementById('raffleTokensList').innerHTML = '<p class="text-xs text-yellow-400 text-center py-4">This wallet has 0 entries in Phase 4</p>';
      showNotification('No entries found', 'info');
    }
    
    return;
  }

  showNotification('Leaderboard not loaded yet. Checking blockchain...', 'info');
  
  try {
    const phase = RAFFLE_CONFIG.TOKEN_RANGE;
    const eligibleTokens = [];
    
    let checkedCount = 0;
    const totalToCheck = phase.max - phase.min + 1;

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
        
        checkedCount++;
        
        if (checkedCount % 50 === 0) {
          const progress = Math.round((checkedCount / totalToCheck) * 100);
          console.log(`Progress: ${progress}% (Found ${eligibleTokens.length} so far)`);
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
        <div class="flex flex-wrap gap-2">
          ${eligibleTokens.map(token => `
            <span class="bg-[#00ff88]/20 px-3 py-1 rounded text-xs border border-[#00ff88]">#${token}</span>
          `).join('')}
        </div>
      `;
      
      showNotification(`Found ${eligibleTokens.length} entries!`, 'success');
      displayFoundRaffleNFTs(eligibleTokens);
      
    } else {
      document.getElementById('raffleTokensList').innerHTML = '<p class="text-xs text-yellow-400 text-center py-4">No eligible NFTs found in Phase 4 range (3334-4444)</p>';
      showNotification('No entries found', 'info');
    }
  } catch (error) {
    console.error('Error:', error);
    document.getElementById('raffleTokensList').innerHTML = '<p class="text-xs text-red-400 text-center py-4">Error checking wallet</p>';
    showNotification('Error checking entries', 'error');
  }
}

async function displayFoundRaffleNFTs(tokenIds) {
  const displaySection = document.getElementById('raffleFoundNFTsDisplay');
  const grid = document.getElementById('raffleFoundNFTsGrid');
  
  displaySection.classList.remove('hidden');
  grid.innerHTML = '<p class="col-span-3 text-center text-white/60 text-xs py-2">Loading images...</p>';
  
  try {
    const nftImages = [];
    
    for (const tokenId of tokenIds.slice(0, 20)) { 
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
                          `https://placehold.co/100x100/1a3a32/00ff88/png?text=${tokenId}`;
          
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
        <a href="${nft.openseaUrl}" target="_blank" class="block group">
          <div class="relative">
            <img src="${nft.imageUrl}" 
                 alt="Undead #${nft.tokenId}" 
                 class="w-full aspect-square object-cover rounded-lg border-2 border-[#00ff88] group-hover:border-white transition-all"
                 loading="lazy"
                 onerror="this.src='https://placehold.co/100x100/1a3a32/00ff88/png?text=${nft.tokenId}'"/>
            <div class="absolute bottom-0 left-0 right-0 bg-black/80 text-center py-1">
              <p class="text-xs text-[#00ff88] font-bold">#${nft.tokenId}</p>
            </div>
          </div>
        </a>
      `).join('');
      
      if (tokenIds.length > 20) {
        grid.innerHTML += `
          <div class="col-span-3 text-center mt-2">
            <p class="text-xs text-white/60">Showing first 20 of ${tokenIds.length} NFTs</p>
          </div>
        `;
      }
    } else {
      grid.innerHTML = '<p class="col-span-3 text-center text-red-400 text-xs py-4">Failed to load images</p>';
    }
    
  } catch (error) {
    console.error('Error displaying NFTs:', error);
    grid.innerHTML = '<p class="col-span-3 text-center text-red-400 text-xs py-4">Error loading images</p>';
  }
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
  spinBtn.textContent = 'Spinning...';

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
    spinBtn.textContent = `Spin Again (${RAFFLE_CONFIG.TOTAL_WINNERS - raffleState.winners.length} left)`;
  } else {
    raffleState.isSpinning = false;
    spinBtn.textContent = '🎉 Complete!';
    spinBtn.disabled = true;
  }
}

function updateWinnersDisplay() {
  const container = document.getElementById('raffleWinnersList');
  container.innerHTML = raffleState.winners.map((winner, idx) => {
    const nftImage = winner.nft?.image_url || winner.nft?.display_image_url || 
                     `https://placehold.co/100x100/1a3a32/00ff88/png?text=${winner.tokenId}`;
    
    return `
      <div class="glass-card p-4 mb-3">
        <div class="flex items-center gap-4">
          <div class="text-center">
            <div class="pixel-font text-2xl text-[#00ff88] mb-2">Winner #${idx + 1}</div>
            <img src="${nftImage}" 
                 alt="Undead #${winner.tokenId}" 
                 class="w-24 h-24 rounded-lg border-2 border-[#00ff88]"
                 onerror="this.src='https://placehold.co/100x100/1a3a32/00ff88/png?text=${winner.tokenId}'"/>
          </div>
          <div class="flex-1">
            <p class="text-lg text-[#00ff88] font-bold">Based Undead #${winner.tokenId}</p>
          </div>
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
  document.getElementById('raffleTokensList').innerHTML = '<p class="text-xs text-white/60 text-center py-4">Enter wallet to see tokens</p>';
  document.getElementById('raffleWinnersList').innerHTML = '<p class="text-center text-white/60 py-8 text-sm">No winners yet</p>';
  
  const spinBtn = document.getElementById('raffleSpinBtn');
  spinBtn.textContent = 'Spin Raffle';
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
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(150, 150, 140, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Loading...', 150, 150);
    return;
  }
  
  const segmentCount = Math.min(entries.length, 72);
  const segmentAngle = 360 / segmentCount;
  const colors = ['#00ff88', '#00cc6f', '#00aa5f', '#008844', '#006633', '#ff6b6b', '#ff8787', '#ffa5a5', '#ffc3c3', '#ffe0e0'];
  
  const centerX = 150;
  const centerY = 150;
  const radius = 140;

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
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const midAngle = (startAngle + endAngle) / 2;
    const textX = centerX + Math.cos(midAngle) * (radius * 0.65);
    const textY = centerY + Math.sin(midAngle) * (radius * 0.65);
    
    ctx.fillStyle = 'rgba(10,31,26,0.9)';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${tokenId}`, textX, textY);
  }

  ctx.restore();
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, 25, 0, 2 * Math.PI);
  ctx.fillStyle = '#00ff88';
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 3;
  ctx.stroke();
}

async function checkForListedNFTs(eligibleNFTs) {
  try {
    console.log('Searching for 3 listed NFTs from Phase 4 range...');
    const listedNFTs = [];
    const checkedTokens = new Set();
    
    const shuffled = [...eligibleNFTs].sort(() => 0.5 - Math.random());
    
    for (const nft of shuffled) {
      if (listedNFTs.length >= 5) {
        console.log('✓ Found 5 listed NFTs, stopping search');
        break;
      }
      
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
            
            console.log(`✓ Found listing ${listedNFTs.length}/5: Token #${tokenId} for ${price} ETH`);
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 400));
        
      } catch (err) {
        console.log(`Could not check token #${tokenId}`);
      }
      
      if (checkedTokens.size >= 50) {
        console.log('Checked 50 NFTs, stopping search');
        break;
      }
    }
    
    if (listedNFTs.length > 0) {
      console.log(`✓ Found ${listedNFTs.length} listed NFT(s) from Phase 4`);
      displayListedNFTs(listedNFTs);
    } else {
      console.log('No listed NFTs found in Phase 4 range');
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
                     `https://placehold.co/200x200/1a3a32/00ff88/png?text=${nft.identifier}`;
    
    return `
      <a href="${nft.openseaUrl}" target="_blank" class="block group">
        <div class="relative">
          <img src="${imageUrl}" 
               alt="Undead #${nft.identifier}" 
               class="w-full aspect-square object-cover rounded-lg border-2 border-[#ff6b6b] group-hover:border-[#ff8787] transition-all"
               loading="lazy"
               onerror="this.src='https://placehold.co/200x200/1a3a32/00ff88/png?text=${nft.identifier}'"/>
          <div class="absolute top-2 right-2 bg-black/80 backdrop-blur-sm px-2 py-1 rounded-lg">
            <p class="text-xs font-bold text-[#00ff88]">${nft.price} ETH</p>
          </div>
          <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-3 rounded-b-lg">
            <p class="text-sm font-bold text-white">#${nft.identifier}</p>
            <p class="text-xs text-[#ff6b6b]">🎫 +1 Entry</p>
          </div>
        </div>
      </a>
    `;
  }).join('');
}

async function preloadImages(nfts) {
  const imagePromises = nfts.map(nft => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve();
      const imageUrl = nft.image_url || nft.display_image_url;
      if (imageUrl) {
        img.src = imageUrl;
      } else {
        resolve();
      }
    });
  });
  
  await Promise.all(imagePromises);
}


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

async function loadLeaderboard() {
  if (leaderboardState.isLoading) return;
  leaderboardState.isLoading = true;

  const leaderboardList = document.getElementById('leaderboardList');
  leaderboardList.innerHTML = `
    <div class="text-center text-white/60 py-8">
      <i class="fas fa-spinner fa-spin text-2xl mb-2"></i>
      <p class="text-xs">Loading from blockchain...</p>
      <p class="text-xs mt-2" id="leaderboardProgress">Starting...</p>
    </div>
  `;

  try {
    const phase = LEADERBOARD_CONFIG.PHASES[leaderboardState.currentPhase];
    console.log(`🚀 Loading ${phase.name} holders from Basescan + OpenSea`);
    
    updateProgress('Fetching all minted tokens from Basescan...');
    
    const mintedTokens = await fetchMintedTokensFromBasescan(phase.min, phase.max);
    console.log(`✓ Found ${mintedTokens.length} minted tokens in range`);
    
    if (mintedTokens.length === 0) {
      throw new Error('No minted tokens found in this range');
    }
    
    updateProgress(`Found ${mintedTokens.length} minted tokens. Fetching current owners (this may take a few minutes)...`);
    
    const holders = await fetchOwnersFromOpenSeaOptimized(mintedTokens);
    console.log(`✓ Found ${holders.size} unique holders`);
    
    const leaderboard = buildLeaderboardFromHolders(holders);
    console.log(`✓ Leaderboard has ${leaderboard.length} entries with ${leaderboard.reduce((sum, e) => sum + e.holding, 0)} total NFTs`);
    
    leaderboardCache.data = leaderboard;
    leaderboardCache.holders = holders;
    leaderboardCache.lastUpdated = Date.now();
    
    leaderboardState.data = leaderboard;
    displayLeaderboard(leaderboard);
    console.log('✅ Done!');
    
  } catch (error) {
    console.error('❌ Error loading leaderboard:', error);
    leaderboardList.innerHTML = `
      <div class="text-center text-red-400 py-8">
        <i class="fas fa-exclamation-circle text-2xl mb-2"></i>
        <p class="text-xs">Failed to load</p>
        <p class="text-xs mt-2">${error.message}</p>
        <button onclick="loadLeaderboard()" class="btn-secondary pixel-font text-xs mt-4">Retry</button>
      </div>
    `;
  } finally {
    leaderboardState.isLoading = false;
  }
}

async function fetchMintedTokensFromBasescan(minToken, maxToken) {
  const mintedTokens = new Set();
  
  try {
    console.log('📡 Fetching ALL mint events from Basescan...');
    const baseUrl = 'https://api.basescan.org/api';
    
    let page = 1;
    let totalFetched = 0;
    
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
        console.log(`✓ Basescan page ${page}: ${data.result.length} transactions`);
        
        data.result.forEach(tx => {
          const tokenId = parseInt(tx.tokenID);
          if (tx.from === '0x0000000000000000000000000000000000000000' &&
              tokenId >= minToken && 
              tokenId <= maxToken) {
            mintedTokens.add(tokenId);
          }
        });
        
        totalFetched += data.result.length;
        
        if (data.result.length < 10000) {
          console.log(`✓ Reached end of data at page ${page}`);
          break;
        }
        
        page++;
        await new Promise(resolve => setTimeout(resolve, 300)); 
      } else {
        console.log(`✓ No more data from Basescan after page ${page - 1}`);
        break;
      }
    }
    
    console.log(`✓ Basescan complete: ${mintedTokens.size} minted tokens found from ${totalFetched} total transactions`);
    
  } catch (error) {
    console.error('Basescan API error:', error);
  }
  
  if (mintedTokens.size === 0 && raffleState.eligibleNFTs.length > 0) {
    console.log('⚠️ Basescan failed, using existing eligible NFTs as fallback');
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
  console.log(`Fetching current owners from OpenSea for ${tokenIds.length} tokens...`);
  
  let processedCount = 0;
  let foundOwners = 0;
  const batchSize = 5; 
  const delayBetweenBatches = 1200; 
  
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
        const eta = Math.round(((tokenIds.length - processedCount) * 0.3) / 60); 
        console.log(`Progress: ${processedCount}/${tokenIds.length} (${percent}%) - ${foundOwners} owners, ${holders.size} unique wallets (ETA: ${eta}min)`);
        updateProgress(`${percent}% complete - ${holders.size} holders found (${eta}min remaining)`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    
    if (i + batchSize < tokenIds.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
  }
  
  console.log(`✓ Successfully fetched ${foundOwners} owners across ${holders.size} unique wallets`);
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
          const ownerAddress = data.nft.owners[0].address;
          return { tokenId, owner: ownerAddress };
        }
      }
      
      if (response.status === 429) {
        const waitTime = 10000 * (attempt + 1); 
        console.log(`⚠️ Rate limited on token ${tokenId}, waiting ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      
    } catch (error) {
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  
  console.warn(`⚠️ Could not fetch owner for token ${tokenId}`);
  return { tokenId, owner: null };
}

function updateProgress(message) {
  const progressEl = document.getElementById('leaderboardProgress');
  if (progressEl) progressEl.textContent = message;
}

async function fetchHoldersFromBlockchain(minToken, maxToken) {
  const holders = new Map(); 
  
  console.log(`Fetching holders for tokens ${minToken}-${maxToken}...`);
  
  let processedCount = 0;
  const totalTokens = maxToken - minToken + 1;
  
  const batchSize = 50;
  
  for (let tokenId = minToken; tokenId <= maxToken; tokenId += batchSize) {
    const batchEnd = Math.min(tokenId + batchSize - 1, maxToken);
    const batchPromises = [];
    
    for (let t = tokenId; t <= batchEnd; t++) {
      const promise = fetchTokenOwner(t);
      batchPromises.push(promise);
    }
    
    const results = await Promise.all(batchPromises);
    
    results.forEach((result, index) => {
      if (result.owner) {
        const owner = result.owner.toLowerCase();
        if (!holders.has(owner)) {
          holders.set(owner, []);
        }
        holders.get(owner).push(result.tokenId);
      }
      
      processedCount++;
      if (processedCount % 20 === 0 || processedCount === totalTokens) {
        const percent = Math.round((processedCount / totalTokens) * 100);
        console.log(`Progress: ${processedCount}/${totalTokens} (${percent}%)`);
        updateProgress(`${percent}% complete (${holders.size} holders found)`);
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  console.log(`✓ Fetched all ${totalTokens} tokens`);
  return holders;
}

async function fetchHoldersForSpecificTokens(tokenIds) {
  const holders = new Map();
  console.log(`Fetching holders for ${tokenIds.length} specific tokens...`);
  
  let processedCount = 0;
  const batchSize = 10;
  
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, Math.min(i + batchSize, tokenIds.length));
    const batchPromises = batch.map(tokenId => fetchTokenOwner(tokenId));
    
    const results = await Promise.all(batchPromises);
    
    results.forEach((result) => {
      if (result.owner) {
        const owner = result.owner.toLowerCase();
        if (!holders.has(owner)) {
          holders.set(owner, []);
        }
        holders.get(owner).push(result.tokenId);
      }
      
      processedCount++;
      if (processedCount % 10 === 0 || processedCount === tokenIds.length) {
        const percent = Math.round((processedCount / tokenIds.length) * 100);
        console.log(`Progress: ${processedCount}/${tokenIds.length} (${percent}%)`);
        updateProgress(`${percent}% complete (${holders.size} holders found)`);
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  console.log(`✓ Fetched all ${tokenIds.length} token owners`);
  return holders;
}

async function fetchTokenOwner(tokenId, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = `https://base.blockscout.com/api/v2/tokens/${CONFIG.BASED_UNDEADS_CONTRACT}/instances/${tokenId}`;
      
      const response = await fetch(url, {
        headers: { 'accept': 'application/json' }
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.owner && data.owner.hash) {
          return { tokenId, owner: data.owner.hash };
        }
      }
      
      if (response.status === 404) {
        return { tokenId, owner: null };
      }
      
      if (response.status === 429) {
        const waitTime = 5000 * (attempt + 1); // 5s, 10s, 15s
        console.log(`⚠️ Rate limited on token ${tokenId}, waiting ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      if (attempt < retries - 1) {
        const waitTime = 3000 * (attempt + 1);
        console.log(`Token ${tokenId} failed (${response.status}), retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
    } catch (error) {
      if (attempt < retries - 1) {
        const waitTime = 3000 * (attempt + 1);
        console.warn(`Token ${tokenId} error: ${error.message}, retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.warn(`⚠️ Could not fetch owner for token ${tokenId} after ${retries} attempts`);
  return { tokenId, owner: null };
}

function buildLeaderboardFromHolders(holders) {
  const leaderboard = [];
  
  for (const [wallet, tokens] of holders.entries()) {
    const walletLower = wallet.toLowerCase();
    
    if (tokens.length > 0) {
      leaderboard.push({
        wallet: walletLower,
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
      <div class="text-center text-white/60 py-8">
        <p class="text-sm">No holders found</p>
        <button onclick="loadLeaderboard()" class="btn-secondary pixel-font text-xs mt-4">Retry</button>
      </div>
    `;
    
    document.getElementById('leaderboardTotalWallets').textContent = '0';
    document.getElementById('leaderboardTotalMinted').textContent = '0';
    document.getElementById('leaderboardTotalHeld').textContent = '0';
    return;
  }

  const totalWallets = leaderboard.length;
  const totalHeld = leaderboard.reduce((sum, entry) => sum + entry.holding, 0);

  document.getElementById('leaderboardTotalWallets').textContent = totalWallets;
  document.getElementById('leaderboardTotalMinted').textContent = totalHeld;
  document.getElementById('leaderboardTotalHeld').textContent = totalHeld;

  const phase = LEADERBOARD_CONFIG.PHASES[leaderboardState.currentPhase];

  leaderboardList.innerHTML = `<p class="text-xs text-[#00ff88] mb-4">✓ ${phase.name} holders loaded from blockchain</p>` + 
    leaderboard.map((entry, index) => {
      const shortWallet = `${entry.wallet.slice(0, 6)}...${entry.wallet.slice(-4)}`;
      const rankBadge = index < 3 ? ['🥇', '🥈', '🥉'][index] : `#${index + 1}`;
      
      return `
        <div class="glass-card p-3 hover:bg-white/10 transition-all cursor-pointer leaderboard-entry" 
             data-wallet="${entry.wallet}">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 flex-1 min-w-0">
              <span class="text-lg">${rankBadge}</span>
              <div class="flex-1 min-w-0">
                <p class="text-xs font-mono text-white truncate" title="${entry.wallet}">
                  ${shortWallet}
                </p>
                <div class="flex gap-3 mt-1 text-xs">
                  <span class="text-[#00ff88]" title="Holding">💎 ${entry.holding} NFTs</span>
                </div>
              </div>
            </div>
            <button class="text-white/40 hover:text-white text-xs px-2 py-1" 
                    onclick="copyToClipboard('${entry.wallet}', event)"
                    title="Copy wallet address">
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
  modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="glass-card p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
      <div class="flex justify-between items-start mb-4">
        <div>
          <h3 class="pixel-font text-sm text-[#00ff88] mb-2">Wallet Details</h3>
          <p class="text-xs font-mono text-white/80 break-all">${wallet}</p>
        </div>
        <button onclick="this.closest('.fixed').remove()" class="text-white/60 hover:text-white text-2xl px-2">×</button>
      </div>

      <div class="text-center bg-white/5 rounded-lg p-4 mb-6">
        <p class="text-3xl font-bold text-[#00ff88]">${entry.holding}</p>
        <p class="text-sm text-white/60 mt-1">NFTs Held</p>
      </div>

      <div class="mb-4">
        <h4 class="text-xs font-bold text-white/80 mb-2">Owned Tokens (${entry.tokens.length})</h4>
        <div class="flex flex-wrap gap-2 max-h-64 overflow-y-auto">
          ${entry.tokens.map(tokenId => `
            <a href="https://opensea.io/assets/base/${CONFIG.BASED_UNDEADS_CONTRACT}/${tokenId}" 
               target="_blank"
               class="bg-[#00ff88]/20 hover:bg-[#00ff88]/30 px-2 py-1 rounded text-xs border border-[#00ff88]/50">
              #${tokenId}
            </a>
          `).join('')}
        </div>
      </div>

      <div class="mt-6 pt-4 border-t border-white/10">
        <a href="https://opensea.io/${wallet}" target="_blank" class="btn-secondary pixel-font text-xs w-full text-center block">
          View on OpenSea
        </a>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

const cursorDot = document.createElement('div');
const cursorOutline = document.createElement('div');

cursorDot.className = 'cursor-dot';
cursorOutline.className = 'cursor-outline';

document.body.appendChild(cursorDot);
document.body.appendChild(cursorOutline);

let mouseX = 0, mouseY = 0;
let outlineX = 0, outlineY = 0;

document.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  cursorDot.style.left = e.clientX + 'px';
  cursorDot.style.top = e.clientY + 'px';
});

function animateCursor() {
  const distX = mouseX - outlineX;
  const distY = mouseY - outlineY;
  
  outlineX += distX * 0.15;
  outlineY += distY * 0.15;
  
  cursorOutline.style.left = outlineX + 'px';
  cursorOutline.style.top = outlineY + 'px';
  
  requestAnimationFrame(animateCursor);
}

animateCursor();

document.querySelectorAll('a, button, .nft-thumbnail, .nft-card').forEach(el => {
  el.addEventListener('mouseenter', () => {
    cursorDot.style.transform = 'translate(-50%, -50%) scale(2)';
    cursorOutline.style.transform = 'translate(-50%, -50%) scale(1.5)';
  });
  el.addEventListener('mouseleave', () => {
    cursorDot.style.transform = 'translate(-50%, -50%) scale(1)';
    cursorOutline.style.transform = 'translate(-50%, -50%) scale(1)';
  });
});

document.querySelectorAll('.btn-primary, .btn-secondary, .nav-mint-btn').forEach(button => {
  button.addEventListener('mousemove', (e) => {
    const rect = button.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    
    button.style.transform = `translate(${x * 0.3}px, ${y * 0.3}px)`;
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translate(0, 0)';
  });
});

const progressBar = document.createElement('div');
progressBar.className = 'scroll-progress';
document.body.appendChild(progressBar);

window.addEventListener('scroll', () => {
  const windowHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  const scrolled = (window.pageYOffset / windowHeight) * 100;
  progressBar.style.width = scrolled + '%';
});

class ParticleSystem {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'particle-canvas';
    document.body.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.resize();
    this.init();
    this.animate();
    
    window.addEventListener('resize', () => this.resize());
  }
  
  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }
  
  init() {
    const particleCount = Math.floor((this.canvas.width * this.canvas.height) / 15000);
    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 2 + 0.5
      });
    }
  }
  
  animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    this.particles.forEach(particle => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      
      if (particle.x < 0 || particle.x > this.canvas.width) particle.vx *= -1;
      if (particle.y < 0 || particle.y > this.canvas.height) particle.vy *= -1;
      
      this.ctx.beginPath();
      this.ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      this.ctx.fill();
    });
    
    this.particles.forEach((p1, i) => {
      this.particles.slice(i + 1).forEach(p2 => {
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < 120) {
          this.ctx.beginPath();
          this.ctx.strokeStyle = `rgba(0, 255, 136, ${0.15 * (1 - distance / 120)})`;
          this.ctx.lineWidth = 0.5;
          this.ctx.moveTo(p1.x, p1.y);
          this.ctx.lineTo(p2.x, p2.y);
          this.ctx.stroke();
        }
      });
    });
    
    requestAnimationFrame(() => this.animate());
  }
}

new ParticleSystem();

function typeWriter(element, text, speed = 100) {
  let i = 0;
  element.textContent = '';
  
  function type() {
    if (i < text.length) {
      element.textContent += text.charAt(i);
      i++;
      setTimeout(type, speed);
    }
  }
  type();
}

setTimeout(() => {
  const heroSubtitle = document.querySelector('.hero-overlay h3');
  if (heroSubtitle) {
    const originalText = heroSubtitle.textContent;
    typeWriter(heroSubtitle, originalText, 80);
  }
}, 500);

document.querySelectorAll('.nft-card').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const rotateX = (y - centerY) / 10;
    const rotateY = (centerX - x) / 10;
    
    card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.05)`;
  });
  
  card.addEventListener('mouseleave', () => {
    card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) scale(1)';
  });
});

function copyToClipboard(text, event) {
  event.stopPropagation();
  navigator.clipboard.writeText(text).then(() => {
    showNotification('Wallet address copied!', 'success');
  }).catch(() => {
    showNotification('Failed to copy', 'error');
  });
}

const observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -50px 0px'
};

const animatedObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, index) => {
    if (entry.isIntersecting) {
      setTimeout(() => {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }, index * 100);
      animatedObserver.unobserve(entry.target);
    }
  });
}, observerOptions);

document.querySelectorAll('.glass-card, .nft-card, .project-card').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(30px)';
  el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  animatedObserver.observe(el);
});

window.addEventListener('scroll', () => {
  const hero = document.querySelector('.hero-banner-img');
  if (hero) {
    const scrolled = window.pageYOffset;
    hero.style.transform = `translateY(${scrolled * 0.4}px)`;
  }
});

document.getElementById('leaderboardSearch')?.addEventListener('input', function(e) {
  const searchTerm = e.target.value.toLowerCase();
  const entries = document.querySelectorAll('.leaderboard-entry');
  
  entries.forEach(entry => {
    const wallet = entry.dataset.wallet.toLowerCase();
    if (wallet.includes(searchTerm)) {
      entry.style.display = '';
    } else {
      entry.style.display = 'none';
    }
  });
});

(async function initializeLeaderboard() {
  const checkReady = setInterval(async () => {
    if (CONFIG.ALCHEMY_API_KEY && 
        document.getElementById('leaderboardList') && 
        raffleState.eligibleNFTs.length > 0) {
      clearInterval(checkReady);
      console.log(`✓ Ready to load leaderboard with ${raffleState.eligibleNFTs.length} minted NFTs`);
      await loadLeaderboard();
    }
  }, 100);
})();

(async function initializeRaffle() {
  const checkAPIKeys = setInterval(async () => {
    if (CONFIG.OPENSEA_API_KEY && CONFIG.ALCHEMY_API_KEY) {
      clearInterval(checkAPIKeys);
      
      if (document.getElementById('raffleCanvasWheel')) {
        await loadRewardNFTs();
        await loadEligibleRaffleNFTs();
        
        startAutoRefresh(2);
      }
    }
  }, 100);
})();
