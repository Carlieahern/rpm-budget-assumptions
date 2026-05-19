// Vercel serverless function — proxies Monday.com GraphQL requests.
// The API key stays server-side; the browser never sees it.

export default async function handler(req, res) {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.MONDAY_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'MONDAY_API_KEY environment variable is not set' });
    return;
  }

  try {
    const { query, variables } = req.body;

    const upstream = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': apiKey,
        'API-Version':   '2024-01',
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
