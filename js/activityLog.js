// Shared Firebase activity logger — writes to the same Firestore `activity_log`
// collection used by the Budget Due Date Tracker's Activity Tracker viewer.
// Separate Firebase project from this app's own Realtime Database (js/firebase.js).
import { FIREBASE_CONFIG } from './firebaseConfig.js';

let app, db, fbMod, ready;

function ensureFirebase() {
  if (ready) return ready;
  ready = (async () => {
    const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    app = appMod.initializeApp(FIREBASE_CONFIG);
    const auth = authMod.getAuth(app);
    await authMod.signInAnonymously(auth);
    db = fsMod.getFirestore(app);
    fbMod = fsMod;
  })();
  return ready;
}

function getHubUser() {
  try {
    const u = JSON.parse(localStorage.getItem('rpm_hub_user') || '{}');
    return { name: u.name || 'Unknown', email: u.email || '', role: u.position || '' };
  } catch {
    return { name: 'Unknown', email: '', role: '' };
  }
}

// action: e.g. 'Login', 'Acknowledged', 'Opted Out', 'Included Elective'
export async function logActivity(action, property = '', description = '') {
  try {
    await ensureFirebase();
    const user = getHubUser();
    await fbMod.addDoc(fbMod.collection(db, 'activity_log'), {
      name: user.name,
      email: user.email,
      role: user.role,
      tool: 'Budget Assumptions',
      action,
      property,
      description: description || (action + (property ? ' — ' + property : '')),
      timestamp: fbMod.serverTimestamp(),
      clientTime: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('Firebase activity log failed', e);
  }
}
