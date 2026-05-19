import CONFIG from './config.js';

// msal is loaded as a global from CDN

let _msalInstance = null;
let _account = null;

function getMsal() {
  if (_msalInstance) return _msalInstance;
  _msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId:    CONFIG.msal.clientId,
      authority:   `https://login.microsoftonline.com/${CONFIG.msal.tenantId}`,
      redirectUri: CONFIG.msal.redirectUri,
    },
    cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: false },
  });
  return _msalInstance;
}

export async function initAuth() {
  const instance = getMsal();
  await instance.initialize();
  const result = await instance.handleRedirectPromise();
  if (result) _account = result.account;
  const accounts = instance.getAllAccounts();
  if (accounts.length > 0 && !_account) _account = accounts[0];
  return _account;
}

export async function login() {
  const instance = getMsal();
  try {
    const result = await instance.loginPopup({ scopes: CONFIG.graphScopes });
    _account = result.account;
    return _account;
  } catch (e) {
    if (e.errorCode === 'user_cancelled') return null;
    throw e;
  }
}

export async function logout() {
  const instance = getMsal();
  await instance.logoutPopup({ account: _account });
  _account = null;
}

export function getAccount() { return _account; }

export async function getAccessToken() {
  const instance = getMsal();
  if (!_account) throw new Error('Not authenticated');
  try {
    const result = await instance.acquireTokenSilent({
      scopes: CONFIG.graphScopes,
      account: _account,
    });
    return result.accessToken;
  } catch (e) {
    if (e instanceof msal.InteractionRequiredAuthError) {
      const result = await instance.acquireTokenPopup({
        scopes: CONFIG.graphScopes,
        account: _account,
      });
      return result.accessToken;
    }
    throw e;
  }
}
