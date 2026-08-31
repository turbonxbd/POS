/**
 * chat-widget.js - the Live/Public site support chat.
 *
 * Real, persisted conversation: messages POST to /chat and are stored
 * server-side; the Super Admin answers from Super Admin -> Chat and the reply
 * comes back here by short polling (5s while the panel is open). Works on any
 * static / PHP host - no websockets.
 */
import http from '../../core/http.js';
import { escapeHtml } from '../../utils/dom.js';

const LS_KEY = 'postxbd_chat_v1';
const POLL_MS = 5000;

const QUICK = [
  ['What is POS TXbd?', 'Hi! Can you tell me what POS TXbd is and how it works?'],
  ['Pricing & plans', 'I\'d like to understand your plans and pricing (setup fee + monthly charge).'],
  ['How to purchase', 'How do I purchase POS TXbd and get started?'],
  ['Request support', 'I need help with something.'],
];

function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function save(v) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

export function mountChatWidget(brandName = 'POS TXbd') {
  if (document.getElementById('live-chat')) return;

  let state = load();               // { visitorId, threadId }
  let open = false;
  let pollTimer = null;
  let lastAt = '';
  const seen = new Set();

  const el = document.createElement('div');
  el.id = 'live-chat';
  el.className = 'live-chat';
  el.innerHTML = `
    <button class="live-chat__fab" type="button" aria-label="Chat with us">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>Chat</span>
    </button>
    <div class="live-chat__panel" hidden>
      <header class="live-chat__head">
        <div><strong>${escapeHtml(brandName)} support</strong><span>Usually replies within a few hours</span></div>
        <button class="live-chat__close" type="button" aria-label="Close chat">&times;</button>
      </header>
      <div class="live-chat__body" id="live-chat-body"></div>
      <div class="live-chat__quick" id="live-chat-quick">
        ${QUICK.map(([label], i) => `<button type="button" data-i="${i}">${escapeHtml(label)}</button>`).join('')}
      </div>
      <form class="live-chat__composer" id="live-chat-form">
        <div class="live-chat__ident" id="live-chat-ident" ${state.threadId ? 'hidden' : ''}>
          <input class="input" name="name" placeholder="Your name" autocomplete="name">
          <input class="input" name="email" type="email" placeholder="Email (so we can follow up)" autocomplete="email">
        </div>
        <div class="live-chat__row">
          <textarea name="text" rows="1" placeholder="Type a message…" required></textarea>
          <button class="btn btn--primary" type="submit" aria-label="Send">Send</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(el);

  const panel = el.querySelector('.live-chat__panel');
  const body = el.querySelector('#live-chat-body');
  const form = el.querySelector('#live-chat-form');
  const quick = el.querySelector('#live-chat-quick');
  const ident = el.querySelector('#live-chat-ident');
  const textArea = form.querySelector('[name=text]');

  function bubble(m) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    if ((m.at || '') > lastAt) lastAt = m.at;
    const div = document.createElement('div');
    div.className = `live-chat__msg live-chat__msg--${m.from === 'admin' ? 'them' : 'me'}`;
    div.innerHTML = `<span>${escapeHtml(m.text)}</span>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function greet() {
    if (body.childElementCount) return;
    const div = document.createElement('div');
    div.className = 'live-chat__msg live-chat__msg--them';
    div.innerHTML = `<span>Hi 👋 Ask us anything about ${escapeHtml(brandName)} — features, plans, pricing or getting started.</span>`;
    body.appendChild(div);
  }

  async function loadHistory() {
    if (!state.threadId) { greet(); return; }
    try {
      const res = await http.get(`/chat/${state.threadId}`, { params: { visitorId: state.visitorId } });
      body.innerHTML = '';
      seen.clear(); lastAt = '';
      (res.messages || []).forEach(bubble);
      if (!res.messages?.length) greet();
    } catch { greet(); }
  }

  async function poll() {
    if (!state.threadId) return;
    try {
      const res = await http.get(`/chat/${state.threadId}`, { params: { visitorId: state.visitorId, since: lastAt || undefined } });
      (res.messages || []).forEach(bubble);
    } catch { /* keep trying */ }
  }

  function startPoll() { stopPoll(); pollTimer = setInterval(poll, POLL_MS); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function toggle(next) {
    open = next ?? !open;
    panel.hidden = !open;
    el.classList.toggle('is-open', open);
    if (open) { loadHistory(); startPoll(); textArea.focus(); }
    else stopPoll();
  }

  el.querySelector('.live-chat__fab').addEventListener('click', () => toggle());
  el.querySelector('.live-chat__close').addEventListener('click', () => toggle(false));

  quick.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    textArea.value = QUICK[+b.dataset.i][1];
    textArea.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textArea.value.trim();
    if (!text) return;
    const fd = new FormData(form);
    const payload = {
      visitorId: state.visitorId || undefined,
      threadId: state.threadId || undefined,
      name: fd.get('name') || undefined,
      email: fd.get('email') || undefined,
      text,
    };
    textArea.value = '';
    const optimistic = { id: 'tmp-' + Date.now(), from: 'visitor', text, at: new Date().toISOString() };
    bubble(optimistic);
    quick.hidden = true;
    try {
      const res = await http.post('/chat', payload);
      state = { visitorId: res.visitorId, threadId: res.threadId };
      save(state);
      ident.hidden = true;
      // reconcile ids so poll dedupe works
      seen.delete(optimistic.id);
      body.lastElementChild?.remove();
      (res.messages || []).forEach(bubble);
      startPoll();
    } catch (err) {
      const div = document.createElement('div');
      div.className = 'live-chat__msg live-chat__msg--err';
      div.innerHTML = `<span>${escapeHtml(err?.data?.message || 'Could not send — please try again.')}</span>`;
      body.appendChild(div);
    }
  });

  textArea.addEventListener('input', () => {
    textArea.style.height = 'auto';
    textArea.style.height = Math.min(textArea.scrollHeight, 110) + 'px';
  });
}

export default mountChatWidget;
