/**
 * platform/payment-settings.js - Super Admin -> Payment Settings.
 *
 * Configure the payment methods merchants see (bKash, Nagad, bank, card, ...):
 * account number, Bangla + English instructions, enabled/disabled. Plus the
 * gateway driver (manual = merchant submits a transaction ID you approve;
 * mock = auto-approve, demo only). The WhatsApp number lives under Settings ->
 * Contact (one source of truth); a shortcut copy is offered here.
 *
 * These records drive the centralized payment sheet everywhere a merchant pays
 * - plan purchase, additional branch, monthly charge. Nothing is hard-coded.
 * Real card / online-gateway secret keys are NEVER stored here; they live in
 * server-php/config/config.php.
 */
import platformService from '../../services/platform-service.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { icon } from '../../components/icons.js';
import { page, loading, errorBox, badge, tableCard } from './kit.js';

const TYPE_LABEL = { mfs: 'Mobile money', bank: 'Bank', card: 'Card' };

export default async function paymentSettingsPage(ctx, mount) {
  const p = page(mount, { title: 'Payment Settings', subtitle: 'Payment methods, Bangla instructions and the gateway — used across every merchant payment' });
  loading(p.body);

  let s;
  try {
    s = await platformService.settings();
  } catch (err) {
    return errorBox(p.body, err);
  }
  let methods = [...(s.paymentMethods || [])].sort((a, b) => (a.sort || 0) - (b.sort || 0));

  function reload() { paymentSettingsPage(ctx, mount); }

  async function saveMethods(next) {
    await platformService.updateSettings({ paymentMethods: next });
    toast.success('Saved');
    reload();
  }

  p.setActions([{ label: 'Add method', icon: 'plus', onClick: () => editMethod(null) }]);

  p.body.innerHTML = `
    <div class="card sa-tablecard" id="pm-list"></div>
    <div class="card card--pad" id="sec-gateway" style="margin-top:16px">
      <div class="form-section-title">Gateway behaviour</div>
      <p class="muted text-sm">How a submitted payment is handled. <strong>Manual</strong> — the merchant enters a transaction ID and their request waits for your approval under Payment Requests. <strong>Test</strong> — auto-approves instantly (demo only).</p>
      <div class="sa-form"></div>
      <p class="muted text-sm" style="margin-top:12px">Card / online-gateway integration is architecture-ready. Secret API keys are configured on the server (<code>server-php/config/config.php</code>), never here.</p>
    </div>`;

  renderList();

  function renderList() {
    methods = [...methods].sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const host = p.body.querySelector('#pm-list');
    if (!methods.length) {
      host.innerHTML = `<div class="sa-card sa-empty" style="padding:28px">Add bKash, Nagad, a bank account or a card option to get started.</div>`;
      return;
    }
    host.innerHTML = `<div class="sa-methods">${methods.map((m, i) => `
      <div class="sa-card sa-method ${m.status === 'disabled' ? 'is-off' : ''}" data-id="${escapeHtml(m.id)}">
        <div class="sa-method__top">
          <span class="sa-method__name">${escapeHtml(m.name)}</span>
          ${badge(m.status === 'disabled' ? 'disabled' : 'enabled', m.status === 'disabled' ? 'muted' : 'success')}
        </div>
        <span class="muted text-sm">${escapeHtml(TYPE_LABEL[m.type] || m.type)}${m.accountType ? ` · ${escapeHtml(m.accountType)}` : ''}</span>
        <span class="sa-method__num">${escapeHtml(m.accountNumber || '—')}</span>
        <div class="sa-method__actions">
          <button class="btn btn--ghost btn--sm js-toggle" data-id="${escapeHtml(m.id)}">${m.status === 'disabled' ? 'Enable' : 'Disable'}</button>
          <button class="btn btn--ghost btn--sm js-edit" data-id="${escapeHtml(m.id)}">${icon('edit', { size: 14 })} Edit</button>
          <button class="btn btn--ghost btn--sm js-move" data-id="${escapeHtml(m.id)}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
          <button class="btn btn--ghost btn--sm js-move" data-id="${escapeHtml(m.id)}" data-dir="1" aria-label="Move down" ${i === methods.length - 1 ? 'disabled' : ''}>&darr;</button>
          <button class="btn btn--ghost btn--sm js-del" data-id="${escapeHtml(m.id)}">${icon('trash', { size: 14 })}</button>
        </div>
      </div>`).join('')}</div>`;

    host.querySelectorAll('.js-edit').forEach((b) => b.addEventListener('click', () => editMethod(methods.find((m) => m.id === b.dataset.id))));
    host.querySelectorAll('.js-toggle').forEach((b) => b.addEventListener('click', () => {
      saveMethods(methods.map((m) => (m.id === b.dataset.id ? { ...m, status: m.status === 'disabled' ? 'enabled' : 'disabled' } : m)));
    }));
    host.querySelectorAll('.js-move').forEach((b) => b.addEventListener('click', () => {
      const idx = methods.findIndex((m) => m.id === b.dataset.id);
      const to = idx + Number(b.dataset.dir);
      if (to < 0 || to >= methods.length) return;
      const next = [...methods];
      [next[idx], next[to]] = [next[to], next[idx]];
      saveMethods(next.map((m, i) => ({ ...m, sort: i + 1 })));
    }));
    host.querySelectorAll('.js-del').forEach((b) => b.addEventListener('click', async () => {
      const m = methods.find((x) => x.id === b.dataset.id);
      if (!(await confirmDialog({ title: `Remove "${m.name}"?`, message: 'Merchants will no longer see this payment method.', confirmLabel: 'Remove', danger: true }))) return;
      saveMethods(methods.filter((x) => x.id !== b.dataset.id));
    }));
  }

  function editMethod(method) {
    const isEdit = !!method;
    const m = openModal({ title: isEdit ? `Edit ${method.name}` : 'Add payment method', size: 'md', body: '<div></div>' });
    createForm(m.$('.modal__body'), {
      fields: [
        { name: 'name', label: 'Method name', required: true, hint: 'e.g. bKash, Nagad, Rocket, Upay, Bank transfer' },
        { name: 'type', label: 'Type', type: 'select', options: [
          { value: 'mfs', label: 'Mobile financial service (bKash / Nagad / ...)' },
          { value: 'bank', label: 'Bank transfer / deposit' },
          { value: 'card', label: 'Debit / credit card' },
        ] },
        { name: 'accountType', label: 'Account type', type: 'select', options: [
          { value: '', label: '—' }, { value: 'personal', label: 'Personal' },
          { value: 'agent', label: 'Agent' }, { value: 'merchant', label: 'Merchant' },
        ] },
        { name: 'accountName', label: 'Account name' },
        { name: 'accountNumber', label: 'Account / number', hint: 'The number the merchant sends money to' },
        { name: 'instructionsBn', label: 'Payment instructions (Bangla)', type: 'textarea', rows: 8, colSpan: 'full', hint: 'One step per line — shown to the merchant as a numbered list.' },
        { name: 'instructionsEn', label: 'Payment instructions (English)', type: 'textarea', rows: 4, colSpan: 'full' },
        { name: 'note', label: 'Short note', hint: 'Optional — shown under the number' },
        { name: 'status', label: 'Status', type: 'select', options: [
          { value: 'enabled', label: 'Enabled (merchants can use it)' },
          { value: 'disabled', label: 'Disabled (hidden)' },
        ] },
        { name: 'sort', label: 'Display order', type: 'number' },
      ],
      values: isEdit ? { ...method } : { type: 'mfs', accountType: '', status: 'enabled', sort: methods.length + 1 },
      submitLabel: isEdit ? 'Save method' : 'Add method',
      onCancel: () => m.close(),
      onSubmit: async (v) => {
        const entry = {
          id: method?.id, name: v.name, type: v.type, accountType: v.accountType,
          accountName: v.accountName, accountNumber: v.accountNumber,
          instructionsBn: v.instructionsBn, instructionsEn: v.instructionsEn,
          note: v.note, status: v.status, sort: Number(v.sort) || methods.length + 1,
        };
        const next = isEdit
          ? methods.map((x) => (x.id === method.id ? entry : x))
          : [...methods, entry];
        m.close();
        await saveMethods(next);
      },
    });
  }

  createForm(p.body.querySelector('#sec-gateway .sa-form'), {
    fields: [
      { name: 'driver', label: 'Active gateway', type: 'select', options: [
        { value: 'manual', label: 'Manual — merchant submits a transaction ID, you approve it' },
        { value: 'mock', label: 'Test gateway — auto-approves instantly (demo only)' },
      ] },
      { name: 'displayName', label: 'Shown to merchants as' },
    ],
    values: { driver: s.gateway?.driver || 'manual', displayName: s.gateway?.displayName || '' },
    submitLabel: 'Save gateway',
    onSubmit: async (v) => {
      await platformService.updateSettings({ gateway: { driver: v.driver, displayName: v.displayName } });
      toast.success('Saved');
    },
  });
}
