/**
 * chat.routes.js - the Live/Public site's support chat (mock).
 *
 * Real storage + real delivery (short polling - works on any static/PHP host):
 *   POST /chat                     PUBLIC  start a thread / append a message
 *   GET  /chat/:threadId?since=    PUBLIC  poll for new messages
 *   GET  /platform/chat            Super Admin  list threads
 *   GET  /platform/chat/:id        Super Admin  one thread + messages
 *   POST /platform/chat/:id/reply  Super Admin
 *   PATCH /platform/chat/:id       Super Admin  { status }
 */
import db from '../db.js';
import { ok, created, notFound, badRequest } from './router.js';
import { requirePlatform } from './platform-helpers.js';
import { getActor } from './context.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

const threads = () => db.collection('chat_threads');
const messages = () => db.collection('chat_messages');

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

function threadView(t) {
  const msgs = messages().all().filter((m) => m.threadId === t.id).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  return { ...t, messages: msgs };
}

export default function register(router) {
  /* -------------------------------------------------- public */
  router.post('/chat', ({ body }) => {
    const b = body || {};
    const text = String(b.text || '').trim();
    if (!text) badRequest('Message text is required', { text: 'Required' });
    const visitorId = String(b.visitorId || '').trim() || uuid();

    return db.tx(() => {
      let thread = b.threadId ? threads().get(b.threadId) : null;
      if (thread && thread.visitorId !== visitorId) thread = null; // don't attach to someone else's thread
      if (!thread) {
        thread = threads().insert({
          id: uuid(), visitorId,
          name: String(b.name || '').trim() || 'Visitor',
          email: isEmail(b.email) ? String(b.email).trim().toLowerCase() : '',
          subject: String(b.subject || 'Website chat').trim(),
          status: 'open', lastMessageAt: now(), unreadForAdmin: 0, at: now(),
        });
      } else {
        const patch = { lastMessageAt: now(), status: thread.status === 'closed' ? 'open' : thread.status };
        if (!thread.email && isEmail(b.email)) patch.email = String(b.email).trim().toLowerCase();
        if ((!thread.name || thread.name === 'Visitor') && b.name) patch.name = String(b.name).trim();
        threads().update(thread.id, patch);
        thread = threads().get(thread.id);
      }
      const msg = messages().insert({ id: uuid(), threadId: thread.id, from: 'visitor', by: thread.name, text, at: now() });
      threads().update(thread.id, { unreadForAdmin: (thread.unreadForAdmin || 0) + 1 });
      return created({ threadId: thread.id, visitorId, message: msg, messages: messages().all().filter((m) => m.threadId === thread.id).sort((a, c) => (a.at || '').localeCompare(c.at || '')) });
    });
  });

  router.get('/chat/:threadId', ({ params, query }) => {
    const thread = threads().get(params.threadId);
    if (!thread) notFound('Conversation');
    if (query.visitorId && thread.visitorId !== query.visitorId) notFound('Conversation');
    let msgs = messages().all().filter((m) => m.threadId === thread.id);
    if (query.since) msgs = msgs.filter((m) => (m.at || '') > query.since);
    msgs.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
    return ok({ threadId: thread.id, status: thread.status, messages: msgs });
  });

  /* -------------------------------------------------- Super Admin */
  router.get('/platform/chat', ({ query }) => {
    requirePlatform();
    let rows = threads().all().sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
    if (query.status && query.status !== 'all') rows = rows.filter((t) => t.status === query.status);
    return ok({
      data: rows.map((t) => ({ ...t, messageCount: messages().count((m) => m.threadId === t.id) })),
      open: threads().count((t) => t.status === 'open'),
    });
  });

  router.get('/platform/chat/:id', ({ params }) => {
    requirePlatform();
    const t = threads().get(params.id);
    if (!t) notFound('Conversation');
    threads().update(t.id, { unreadForAdmin: 0 });
    return ok(threadView(threads().get(t.id)));
  });

  router.post('/platform/chat/:id/reply', ({ params, body }) => {
    requirePlatform();
    const t = threads().get(params.id);
    if (!t) notFound('Conversation');
    const text = String(body?.text || '').trim();
    if (!text) badRequest('Reply text is required');
    return db.tx(() => {
      const msg = messages().insert({ id: uuid(), threadId: t.id, from: 'admin', by: getActor()?.name || 'POS TXbd', text, at: now() });
      threads().update(t.id, { status: 'answered', lastMessageAt: now(), unreadForAdmin: 0 });
      return created({ message: msg, thread: threadView(threads().get(t.id)) });
    });
  });

  router.patch('/platform/chat/:id', ({ params, body }) => {
    requirePlatform();
    const t = threads().get(params.id);
    if (!t) notFound('Conversation');
    const status = ['open', 'answered', 'closed'].includes(body?.status) ? body.status : t.status;
    return ok(threads().update(t.id, { status }));
  });
}
