/**
 * chat.mjs - the Live-site support chat (mock): a visitor starts a thread,
 * the Super Admin replies, the visitor polls and sees it. Real storage +
 * real delivery, no fake demo.
 *
 *   node test/chat.mjs
 */
const store = new Map();
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'test' }, configurable: true });
globalThis.window = globalThis;
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.setInterval = () => 0;
globalThis.document = { documentElement: { setAttribute() {}, removeAttribute() {}, hasAttribute: () => false, style: {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => ({}) }), addEventListener() {}, body: { appendChild() {}, style: {} }, getElementById: () => null, cookie: '' };
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const { db } = await import('../js/core/db.js');
const { initMockServer } = await import('../js/core/mock-server.js');
const { seedDemo } = await import('../js/data/seed.js');
const { setActor, clearContext } = await import('../js/core/mock/context.js');
const { http } = await import('../js/core/http.js');
initMockServer(); db.load(); await seedDemo(db);

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function login(email, password) { clearContext(); const p = await http.post('/auth/login', { email, password }); setActor({ ...p.user }); return p; }

/* visitor starts a conversation - no auth */
await clearContext();
const m1 = await http.post('/chat', { name: 'Jamal', email: 'jamal@shop.bd', text: 'How much is the Business plan?' });
T('a visitor gets a threadId + visitorId back', !!m1.threadId && !!m1.visitorId);
T('the first message is stored', m1.messages.length === 1 && m1.messages[0].from === 'visitor');
const { threadId, visitorId } = m1;

/* a second message appends to the same thread */
await http.post('/chat', { threadId, visitorId, text: 'And the setup fee?' });
const poll1 = await http.get(`/chat/${threadId}`, { params: { visitorId } });
T('both visitor messages are on the thread', poll1.messages.length === 2);

/* wrong visitorId cannot read the thread */
let hidden = false;
try { await http.get(`/chat/${threadId}`, { params: { visitorId: 'someone-else' } }); } catch (e) { hidden = e.status === 404; }
T('another visitor id cannot read the conversation', hidden);

/* Super Admin sees it + replies */
await login('superadmin@postxbd.app', 'superadmin123');
const list = await http.get('/platform/chat');
T('Super Admin sees the open thread with an unread count', list.data.some(t => t.id === threadId) && list.open >= 1);
const before = new Date().toISOString();
await sleep(5);
await http.post(`/platform/chat/${threadId}/reply`, { text: 'Business is 190000/mo, setup 25000.' });
const full = await http.get(`/platform/chat/${threadId}`);
T('reply is appended as an admin message + thread marked answered', full.status === 'answered' && full.messages.at(-1).from === 'admin');

/* visitor polls with ?since and sees only the new reply */
await clearContext();
const poll2 = await http.get(`/chat/${threadId}`, { params: { visitorId, since: before } });
T('visitor poll(since) returns the admin reply', poll2.messages.length === 1 && poll2.messages[0].from === 'admin');

/* close it */
await login('superadmin@postxbd.app', 'superadmin123');
await http.patch(`/platform/chat/${threadId}`, { status: 'closed' });
T('thread can be closed', (await http.get(`/platform/chat/${threadId}`)).status === 'closed');

/* a merchant cannot reach the Super Admin chat endpoints */
await login('admin@txdemo.shop', 'demo1234');
let denied = false;
try { await http.get('/platform/chat'); } catch (e) { denied = e.status === 403; }
T('merchant blocked from /platform/chat (403)', denied);

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
