/* ============================================================
   BASED UNDEADS — network configuration (MAINNET)
   ------------------------------------------------------------
   Website is mainnet-only. The one exception: the FEATURED
   scroller + Story grid still pull from the Sepolia renderer
   until you deploy on mainnet, so the site never looks empty.
   When mainnet is live, paste the mainnet renderer address into
   NETWORK.rendererAddress below and remove the fallback block
   (search for "FEATURED FALLBACK" lower in this file).
   ============================================================ */

const ACTIVE_NETWORK = 'mainnet';   // MAINNET ONLY — do not change

const NETWORKS = {
  mainnet: {
    label:              'Base',
    chainId:            8453,
    chainIdHex:         '0x2105',
    rpcUrl:             'https://mainnet.base.org',
    explorerBase:       'https://basescan.org',
    nativeSymbol:       'ETH',

    // ⚠ PASTE THESE THE MOMENT YOU DEPLOY ON MAINNET
    NFT_ADDRESS:        '0x0000000000000000000000000000000000000000',
    STAKING_ADDRESS:    '0x0000000000000000000000000000000000000000',
    rendererAddress:    '',   // mainnet renderer address here

    openseaChain:       'base',
    openseaApiHost:     'https://api.opensea.io',
    openseaWebBase:     'https://opensea.io/assets/base',
    openseaCollection:  'https://opensea.io/collection/basedundeads/overview',
    alchemyHost:        'https://base-mainnet.g.alchemy.com',
    collectionSlug:     'basedundeads',

    showDemoRoyalty:    false,
    demoRoyaltyEthAmount: '0',
  },
};

const NETWORK = NETWORKS[ACTIVE_NETWORK];
if (!NETWORK) throw new Error(`Unknown network: ${ACTIVE_NETWORK}`);

// ═══════════════════════════════════════════════════════════════════
//  FEATURED FALLBACK — keeps the scroller alive until mainnet goes live.
//  Remove this whole block once NETWORK.rendererAddress is filled in.
// ═══════════════════════════════════════════════════════════════════
if (!NETWORK.rendererAddress) {
  window.FEATURED_FALLBACK = {
    label:           'Base Sepolia (featured only)',
    rpcUrl:          'https://sepolia.base.org',
    rendererAddress: '0x0cF7D86de79Fc48cC99af08Ae31280e88fA9285f',
    NFT_ADDRESS:     '0xd3EE3842d3878346a65b44D18C76046c70d46987',
  };
}
// ═══════════════════════════════════════════════════════════════════

// Make available globally to every page's scripts
window.NETWORK = NETWORK;
window.ACTIVE_NETWORK = ACTIVE_NETWORK;
window.IS_TESTNET = false;    // website is mainnet-only

console.log(`🦇 Based Undeads — network: ${NETWORK.label} (${ACTIVE_NETWORK})`);
