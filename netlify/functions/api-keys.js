exports.handler = async (event, context) => {
  console.log('API keys function called');
  
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    console.log('Environment variables:', {
      hasAlchemy: !!process.env.ALCHEMY_API_KEY,
      hasOpenSea: !!process.env.OPENSEA_API_KEY,
      hasMoralis: !!process.env.MORALIS_API_KEY
    });
    
    // Return API keys in the format expected by script.js
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        apiKeys: {
          alchemy: process.env.ALCHEMY_API_KEY,
          opensea: process.env.OPENSEA_API_KEY ? process.env.OPENSEA_API_KEY.split(',') : [],
          moralis: process.env.MORALIS_API_KEY
        }
      })
    };
  } catch (error) {
    console.error('Error in api-keys function:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to retrieve API keys' })
    };
  }
};
