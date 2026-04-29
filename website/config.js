/* ============================================================
   BASED UNDEADS - network configuration (MAINNET)
   ------------------------------------------------------------
   Website is mainnet-only. The one exception: the FEATURED
   scroller + Story grid still pull from the Sepolia renderer
   until you deploy on mainnet, so the site never looks empty.
   When mainnet is live, paste the mainnet renderer address into
   NETWORK.rendererAddress below and remove the fallback block
   (search for "FEATURED FALLBACK" lower in this file).
   ============================================================ */

const ACTIVE_NETWORK = 'mainnet';   // MAINNET ONLY - do not change

const NETWORKS = {
  mainnet: {
    label:              'Base',
    chainId:            8453,
    chainIdHex:         '0x2105',
    rpcUrl:             'https://mainnet.base.org',  
    explorerBase:       'https://basescan.org',
    nativeSymbol:       'ETH',

    // ⚠ PASTE THESE THE MOMENT YOU DEPLOY ON MAINNET
    NFT_ADDRESS:        '0x4Ec576C1Cc8e462cEca264FE52B10Cc75F7EC7Ea',
    STAKING_ADDRESS:    '0xCd3Ce3d26926Cc942E0A58cE290fB3709dA42dB1',
    
    rendererAddress:    '0x71565FD19431f917F38DA462433bA1D7A81Ec700',   // mainnet renderer address here

    openseaChain:       'base',
    openseaApiHost:     'https://api.opensea.io',
    openseaWebBase:     'https://opensea.io/assets/base',
    openseaCollection:  'https://opensea.io/collection/basedundeads/overview',
    alchemyHost:        'https://base-mainnet.g.alchemy.com',
    collectionSlug:     'basedundeads',

    showDemoRoyalty:    false,
    demoRoyaltyEthAmount: '0',

    // ──────────────────────────────────────────────────────────
    // STAKING LAUNCH SWITCH
    // Set to `true` when ready to allow stake/unstake/claim.
    // While false: wallet shows Undeads, but action buttons
    // are disabled and trigger the "not yet live" popup.
    // ──────────────────────────────────────────────────────────
    stakingEnabled: false,
  },
};

const NETWORK = NETWORKS[ACTIVE_NETWORK];
if (!NETWORK) throw new Error(`Unknown network: ${ACTIVE_NETWORK}`);

// ═══════════════════════════════════════════════════════════════════
//  FEATURED FALLBACK - keeps the scroller alive until mainnet goes live.
//  Remove this whole block once NETWORK.rendererAddress is filled in.
// ═══════════════════════════════════════════════════════════════════
if (!NETWORK.rendererAddress) {
  window.FEATURED_FALLBACK = {
    label:           'Base Sepolia (featured only)',
    rpcUrl:          'https://sepolia.base.org',
    rendererAddress: '',
    NFT_ADDRESS:     '',
  };
}
// ═══════════════════════════════════════════════════════════════════

// Make available globally to every page's scripts
window.NETWORK = NETWORK;
window.ACTIVE_NETWORK = ACTIVE_NETWORK;
window.IS_TESTNET = false;    // website is mainnet-only

console.log(`🦇 Based Undeads - network: ${NETWORK.label} (${ACTIVE_NETWORK})`);
