// Vercel serverless function — proxies Firebase Realtime Database REST calls.
//
// Why this exists: the database was created in Test Mode (open to the internet).
// Routing reads/writes through here lets us lock the database rules to
// `auth != null` while this function authenticates with a server-side service
// account — the browser never touches Firebase directly.
//
// Safe rollout: if FIREBASE_SERVICE_ACCOUNT isn't set yet, the function simply
// forwards the request unauthenticated. That keeps the app working while the
// rules are still open. Once the service account is set AND the rules are locked,
// the function authenticates and the public is shut out.

import crypto from 'crypto';

const DB_URL = process.env.FIREBASE_DB_URL
  || 'https://rpm-site-level-assumptions-default-rtdb.firebaseio.com';

// Only these top-level paths may be read/written through the proxy.
const PATH_OK = /^(programs|meta)(\/[A-Za-z0-9 _.\-]+)*$/;

let cachedToken = null;
let cachedExp = 0;

async function getAccessToken() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;                       // not configured yet → forward unauthenticated
  if (cachedToken && Date.now() < cachedExp - 60000) return cachedToken;

  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64url');
  const jwt = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const j = await resp.json();
  if (!j.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(j));
  cachedToken = j.access_token;
  cachedExp = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const path = (req.query.path || '').toString();
  if (!PATH_OK.test(path)) { res.status(400).json({ error: 'Invalid path' }); return; }
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    let token = null;
    try { token = await getAccessToken(); }
    catch (e) { console.error('Firebase auth failed:', e.message); /* fall back to unauthenticated */ }

    const url = `${DB_URL}/${path}.json` + (token ? `?access_token=${token}` : '');
    const opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method === 'PUT') opts.body = JSON.stringify(req.body ?? null);

    const upstream = await fetch(url, opts);
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(upstream.status).send(text || 'null');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
