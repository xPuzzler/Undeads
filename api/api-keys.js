// ============================================================
// Vercel Serverless Function — /api/api-keys
// Returns API keys from environment (never committed).
// Set these in Vercel dashboard → Project → Settings → Env Vars:
//   OPENSEA_API_KEY, ALCHEMY_API_KEY, MORALIS_API_KEY
// ============================================================
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    apiKeys: {
      opensea: process.env.OPENSEA_API_KEY || '',
      alchemy: process.env.ALCHEMY_API_KEY || '',
      moralis: process.env.MORALIS_API_KEY || '',
    },
  });
}