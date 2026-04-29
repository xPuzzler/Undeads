exports.handler = async (event) => {
  const alchemy = process.env.ALCHEMY_API_KEY;

  if (!alchemy) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'ALCHEMY_API_KEY not set' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const r = await fetch(`https://base-mainnet.g.alchemy.com/v2/${alchemy}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};