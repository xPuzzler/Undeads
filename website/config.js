// config.js, BasedUndeads Frontend Configuration (MAINNET)
window.BU_CONFIG = {
  network: "base",
  networks: {
    base: {
      chainId:    8453,
      chainIdHex: "0x2105",
      name:       "Base",
      rpcUrl:     "https://base-mainnet.g.alchemy.com/v2/zRlDmWXD-OkVUdXuiY8sBppRtbWt9FDx",
      rpcFallbacks: [
        "https://base.publicnode.com",
        "https://base-rpc.publicnode.com",
        "https://1rpc.io/base",
      ],
      alchemyHost:   "https://base-mainnet.g.alchemy.com",
      explorerUrl:"https://basescan.org",
      openseaRoot:"https://opensea.io/assets/base",
      openseaCollection: "https://opensea.io/collection/basedundeads/overview",
      currency:   "ETH",
    },
  },
  contracts: {
    nft:      "0x4Ec576C1Cc8e462cEca264FE52B10Cc75F7EC7Ea",
    staking:  "0xCd3Ce3d26926Cc942E0A58cE290fB3709dA42dB1",
    renderer: "0x71565FD19431f917F38DA462433bA1D7A81Ec700",
    game:     "0x219fA75999FC26c26E47fBbeF275C3Bb5c03564b",
  },
  collection: {
    totalSupply: 6666,
    cooldownHours: 24,
    royalty: { totalBps: 750, toOwnerBps: 375, toPoolBps: 375, enforced: false },
    traitLabels: ["Background", "Type", "Clothes", "Eyes", "Eyewear", "Head", "Mask", "Mouth"],
    legends: [5607, 3690, 6101, 6569, 1919, 1302, 2999, 4824, 4165, 26, 2633, 666, 4333],
  },
  social: {
    twitter:  "https://x.com/BasedUndeads",
    discord:  "https://discord.gg/9Jh6ywjNdV",
    opensea:  "https://opensea.io/collection/basedundeads/overview",
    necrowls: "https://necrowls.com",
  },
  refreshIntervals: { stats: 15_000, userPanel: 20_000, lockTick: 1_000, activityFeed: 30_000 },
  leaderboard: { maxRows: 25 },
  activity:    { maxRows: 30 },
  stakingEnabled: true,
};

(function resolve() {
  const cfg = window.BU_CONFIG;
  cfg.activeNetwork = cfg.networks[cfg.network];
  cfg.openseaUrl = function(tokenId) {
    return `${cfg.activeNetwork.openseaRoot}/${cfg.contracts.nft}/${tokenId}`;
  };
  // Legacy compat
  window.NETWORK = {
    label:             cfg.activeNetwork.name,
    chainId:           cfg.activeNetwork.chainId,
    chainIdHex:        cfg.activeNetwork.chainIdHex,
    rpcUrl:            cfg.activeNetwork.rpcUrl,
    explorerBase:      cfg.activeNetwork.explorerUrl,
    nativeSymbol:      cfg.activeNetwork.currency,
    NFT_ADDRESS:       cfg.contracts.nft,
    STAKING_ADDRESS:   cfg.contracts.staking,
    rendererAddress:   cfg.contracts.renderer,
    openseaChain:      "base",
    openseaApiHost:    "https://api.opensea.io",
    openseaWebBase:    cfg.activeNetwork.openseaRoot,
    openseaCollection: cfg.activeNetwork.openseaCollection,
    alchemyHost:       "https://base-mainnet.g.alchemy.com",
    collectionSlug:    "basedundeads",
    showDemoRoyalty:   false,
    demoRoyaltyEthAmount: "0",
    stakingEnabled:    cfg.stakingEnabled,
  };
  window.ACTIVE_NETWORK = cfg.network;
  window.IS_TESTNET = false;
})();
