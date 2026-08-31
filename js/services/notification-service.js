/**
 * notification-service.js
 */
import http from '../core/http.js';
import bus from '../core/event-bus.js';
import store from '../core/store.js';

export const notificationService = {
  async getNotifications(params = {}) {
    const res = await http.get('/notifications', { params });
    store.set({ notificationsUnread: res.unreadCount ?? store.get('notificationsUnread') });
    return res;
  },
  async markRead(id) {
    await http.post(`/notifications/${id}/read`);
    bus.emit('notifications:changed');
  },
  async markAllRead() {
    await http.post('/notifications/read-all');
    store.set({ notificationsUnread: 0 });
    bus.emit('notifications:changed');
  },
  remove(id) {
    return http.del(`/notifications/${id}`);
  },
  async refreshBadge() {
    const res = await http.get('/notifications', { params: { unread: 'true', pageSize: 1 } });
    store.set({ notificationsUnread: res.unreadCount || 0 });
    return res.unreadCount || 0;
  },
};

export default notificationService;
