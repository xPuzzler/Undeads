// Netlify Function (legacy/CommonJS format — works on all CLI versions).
// Returns API keys from env vars at /.netlify/functions/api-keys
//
// LOCAL: keys come from .env at project root (loaded by `netlify dev`)
// PROD:  keys come from Netlify dashboard → Site config → Environment variables

exports.handler = async (event, context) => {
  const alchemy = process.env.ALCHEMY_API_KEY || null;
  const opensea = process.env.OPENSEA_API_KEY || null;
  const moralis = process.env.MORALIS_API_KEY || null;

  console.log('[api-keys] called — env present:', {
    hasAlchemy: !!alchemy,
    hasOpenSea: !!opensea,
    hasMoralis: !!moralis,
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      apiKeys: { alchemy, opensea, moralis },
    }),
  };
};