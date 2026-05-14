// ============================================================
//  BasedUndeads, Local dev server
//  ----------------------------------------------------------
//  Bypasses netlify dev entirely. Serves website/ as static
//  files and emulates /.netlify/functions/api-keys so the
//  frontend code works identically in dev and production.
//
//  Run with:  npm run dev
//  Or:        node server.js
// ============================================================

const express = require('express');
const path    = require('path');
require('dotenv').config();   // loads .env at project root

const app  = express();
const PORT = process.env.PORT || 8888;

// ─── Function endpoint ─────────────────────────────────────
// Emulates website/netlify/functions/api-keys.js exactly.
app.get('/.netlify/functions/api-keys', (req, res) => {
  const alchemy = process.env.ALCHEMY_API_KEY || null;
  const opensea = process.env.OPENSEA_API_KEY || null;
  const moralis = process.env.MORALIS_API_KEY || null;

  console.log('[api-keys] called, env present:', {
    hasAlchemy: !!alchemy,
    hasOpenSea: !!opensea,
    hasMoralis: !!moralis,
  });

  res.set({
    'Content-Type':  'application/json',
    'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
  });
  res.json({ apiKeys: { alchemy, opensea, moralis } });
});

// ─── Clean URL rewrites (matches netlify.toml redirects) ───
const cleanUrls = {
  '/stake':     '/staking.html',
  '/staking':   '/staking.html',
  '/game':      '/game.html',
  '/tools':     '/tools.html',
  '/validator': '/validate.html',
  '/overview':  '/overview.html',
};
Object.entries(cleanUrls).forEach(([from, to]) => {
  app.get(from, (_req, res) => res.sendFile(path.join(__dirname, 'website', to)));
});

// ─── Static file server ────────────────────────────────────
app.use(express.static(path.join(__dirname, 'website')));

// ─── 404 for everything else ───────────────────────────────
app.use((_req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'website', 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╭───────────────────────────────────────────────╮');
  console.log(`  │   BasedUndeads dev server ready               │`);
  console.log(`  │   ▸ http://localhost:${PORT}                       │`);
  console.log('  ╰───────────────────────────────────────────────╯');
  console.log('');
  console.log(`  Static files:  ./website`);
  console.log(`  Functions:     /.netlify/functions/api-keys`);
  console.log('');

  // Quick env sanity check
  const keys = ['ALCHEMY_API_KEY', 'OPENSEA_API_KEY', 'BASESCAN_API_KEY', 'MORALIS_API_KEY'];
  const found = keys.filter(k => process.env[k]);
  const missing = keys.filter(k => !process.env[k]);
  if (found.length)   console.log(`  ✓ Loaded from .env: ${found.join(', ')}`);
  if (missing.length) console.log(`  ✗ Missing in .env:  ${missing.join(', ')}`);
  console.log('');
});