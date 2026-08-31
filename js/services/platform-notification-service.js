/**
 * platform-notification-service.js - the Super Admin notification feed.
 * Platform-wide (not merchant-scoped); every call is gated on a platform actor.
 */
import http from '../core/http.js';
import bus from '../core/event-bus.js';
import store from '../core/store.js';

export const platformNotificationService = {
  async list(params = {}) {
    const res = await http.get('/platform/notifications', { params });
    store.set({ platformNotificationsUnread: res.unreadCount ?? 0 });
    return res;
  },
  async markRead(id) {
    await http.post(`/platform/notifications/${id}/read`);
    bus.emit('platform-notifications:changed');
  },
  async markAllRead() {
    await http.post('/platform/notifications/read-all');
    store.set({ platformNotificationsUnread: 0 });
    bus.emit('platform-notifications:changed');
  },
  remove: (id) => http.del(`/platform/notifications/${id}`),
  async refreshBadge() {
    try {
      const res = await http.get('/platform/notifications', { params: { unread: 'true', pageSize: 1 } });
      store.set({ platformNotificationsUnread: res.unreadCount || 0 });
      return res.unreadCount || 0;
    } catch { return 0; }
  },
};

export default platformNotificationService;
