/**
 * platform/merchant-detail.js - one merchant: business, subscription, branches,
 * users, billing history + suspend/activate + record a payment.
 */
import platformService from '../../services/platform-service.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { page, loading, errorBox, tableCard, badge, fmtMoney, fmtDate, fmtDateTime, liveRefresh } from './kit.js';

export default async function merchantDetailPage(ctx, mount) {
  const p = page(mount, { title: 'Merchant', subtitle: '', back: { href: '/merchants', label: 'All merchants' } });
  loading(p.body);
  let d;
  try {
    d = await platformService.merchant(ctx.params.id);
  } catch (err) {
    return errorBox(p.body, err);
  }
  const m = d.merchant;
  const sub = d.subscription;
  const live = sub?.liveStatus || 'none';
  const needsApproval = live === 'pending' || live === 'past_due' || live === 'expired'
    || d.payments.some((x) => (x.status || 'paid') === 'pending');
  p.setTitle(d.business?.name || m.name);
  p.setSubtitle(`${escapeHtml(sub?.planName || 'No plan')} · Registered ${fmtDate(m.registeredAt || m.createdAt)} · ${badgeText(m.status)}`);

  p.setActions([
    ...(needsApproval ? [{ label: 'Approve account', variant: 'primary', icon: 'check', onClick: approveAccount }] : []),
    m.status === 'active'
      ? { label: 'Suspend', variant: 'danger', icon: 'alert-triangle', onClick: () => setStatus('suspended') }
      : { label: 'Reactivate', variant: needsApproval ? 'ghost' : 'primary', icon: 'check', onClick: () => setStatus('active') },
    { label: 'Message merchant', variant: 'ghost', icon: 'bell', onClick: sendMessage },
    { label: 'Reset owner password', variant: 'ghost', icon: 'shield', onClick: resetOwner },
    { label: 'Record payment', variant: 'ghost', icon: 'banknote', onClick: recordPayment },
    { label: 'Manage subscription', variant: 'ghost', icon: 'rotate-ccw', onClick: manageSub },
  ]);

  p.body.innerHTML = `
    <div class="sa-detail-grid">
      <div class="card card--pad">
        <div class="form-section-title">Subscription</div>
        ${sub ? `
          <div class="sa-kv"><span>Plan</span><b>${escapeHtml(sub.planName || '—')}</b></div>
          <div class="sa-kv"><span>Status</span>${badge(sub.liveStatus)}</div>
          <div class="sa-kv"><span>Setup fee</span><b>${fmtMoney(sub.setupPrice || 0)} ${sub.setupPaid ? '· paid' : '· unpaid'}</b></div>
          <div class="sa-kv"><span>Monthly charge</span><b>${fmtMoney(sub.monthlyPrice ?? sub.planPrice)} / ${escapeHtml(sub.billingPeriod === 'yearly' ? 'year' : 'month')}</b></div>
          <div class="sa-kv"><span>Next billing</span><b>${fmtDate(sub.nextBillingAt || sub.expiresAt)}</b></div>
          ${sub.dueAmount ? `<div class="sa-kv"><span>Amount due now</span><b>${fmtMoney(sub.dueAmount)}</b></div>` : ''}
          <div class="sa-kv"><span>Branches</span><b>${d.branches.length} used · ${sub.branchLimit ?? sub.includedBranches ?? 1} allowed (${sub.extraBranchesPaid || 0} bought)</b></div>
          <div class="sa-kv"><span>Started</span><b>${fmtDate(sub.startedAt)}</b></div>
        ` : '<p class="muted">No subscription on record.</p>'}
      </div>
      <div class="card card--pad">
        <div class="form-section-title">Usage</div>
        <div class="sa-kv"><span>Products</span><b>${d.usage.products}</b></div>
        <div class="sa-kv"><span>Customers</span><b>${d.usage.customers}</b></div>
        <div class="sa-kv"><span>Sales</span><b>${d.usage.sales}</b></div>
        <div class="sa-kv"><span>Gross sales</span><b>${fmtMoney(d.usage.grossSales)}</b></div>
        <div class="sa-kv"><span>Last sale</span><b>${fmtDateTime(d.usage.lastSaleAt)}</b></div>
      </div>
      <div class="card card--pad">
        <div class="form-section-title">Business</div>
        <div class="sa-kv"><span>Phone</span><b>${escapeHtml(d.business?.phone || '—')}</b></div>
        <div class="sa-kv"><span>Email</span><b>${escapeHtml(d.business?.email || '—')}</b></div>
        <div class="sa-kv"><span>Address</span><b>${escapeHtml(d.business?.address || '—')}</b></div>
        <div class="sa-kv"><span>VAT / BIN</span><b>${escapeHtml(d.business?.vatNo || '—')}</b></div>
      </div>
    </div>

    <h3 class="sa-h3">Branches (${d.branches.length})</h3>
    ${tableCard({ head: ['Name', 'Code', 'Status'], rows: d.branches.map((b) => `<tr><td>${escapeHtml(b.name)}</td><td>${escapeHtml(b.code || '—')}</td><td>${badge(b.status)}</td></tr>`) })}

    <h3 class="sa-h3">Users (${d.users.length})</h3>
    ${tableCard({ head: ['Name', 'Email', 'Role', 'Status'], rows: d.users.map((u) => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(roleName(u.roleId))}</td><td>${badge(u.status)}</td></tr>`) })}

    <h3 class="sa-h3">Payments (${d.payments.length})</h3>
    ${tableCard({
      head: [{ label: 'Date' }, { label: 'Type' }, { label: 'Amount', num: true }, { label: 'Method' }, { label: 'Reference' }, { label: 'Status' }, { label: '' }],
      rows: d.payments.map((x) => `<tr>
        <td>${fmtDate(x.at)}</td>
        <td>${escapeHtml({ initial: 'Initial', monthly: 'Monthly', branch: 'Branch' }[x.type] || x.type || 'Monthly')}</td>
        <td class="num">${fmtMoney(x.amount)}</td>
        <td>${escapeHtml(x.method || '—')}</td>
        <td>${escapeHtml(x.reference || x.note || '—')}${x.proofImage ? ` · <a href="${escapeHtml(x.proofImage)}" target="_blank" rel="noopener">proof</a>` : ''}</td>
        <td>${badge(x.status || 'paid')}</td>
        <td>${(x.status || 'paid') === 'pending' ? `<button class="btn btn--ghost btn--sm js-confirm-pay" data-id="${x.id}">Approve</button> <button class="btn btn--ghost btn--sm js-reject-pay" data-id="${x.id}">Reject</button>` : ''}</td>
      </tr>`),
      empty: 'No payments recorded yet.',
    })}`;

  // ---- internal notes & tags (never shown to the merchant) ----
  const tags = m.tags || [];
  const notes = m.notes || [];
  p.body.insertAdjacentHTML('beforeend', `
    <h3 class="sa-h3">Internal notes &amp; tags</h3>
    <div class="card card--pad">
      <div class="form-section-title">Tags</div>
      <div class="sa-tags" id="sa-tag-list">
        ${tags.map((t) => `<span class="sa-tag">${escapeHtml(t)} <button class="sa-tag__x js-untag" data-t="${escapeHtml(t)}" aria-label="Remove tag">×</button></span>`).join('') || '<span class="muted text-sm">No tags yet.</span>'}
      </div>
      <div class="row" style="gap:8px;margin-top:8px">
        <input class="input js-tag-input" placeholder="Add a tag (e.g. VIP, chase-payment)" maxlength="24" style="max-width:260px">
        <button class="btn btn--ghost btn--sm js-tag-add">Add tag</button>
      </div>
      <div class="form-section-title" style="margin-top:16px">Notes</div>
      <div class="row" style="gap:8px;align-items:flex-start">
        <textarea class="input js-note-input" rows="2" placeholder="Add a private note about this merchant…" style="flex:1"></textarea>
        <button class="btn btn--primary btn--sm js-note-add">Add note</button>
      </div>
      <div id="sa-note-list" style="margin-top:12px">
        ${notes.length ? notes.map((n) => `<div class="sa-note">
          <p>${escapeHtml(n.text)}</p>
          <div class="sa-note__meta"><span>${escapeHtml(n.authorName || 'Super Admin')} · ${fmtDateTime(n.at)}</span>
            <button class="btn btn--ghost btn--sm js-note-del" data-id="${n.id}">Delete</button></div>
        </div>`).join('') : '<p class="muted text-sm">No notes yet.</p>'}
      </div>
    </div>`);

  const saveTags = async (next) => {
    try {
      await platformService.updateMerchant(m.id, { tags: next });
      reload();
    } catch (err) { toast.error(err?.data?.message || 'Could not update tags'); }
  };
  p.body.querySelector('.js-tag-add')?.addEventListener('click', () => {
    const inp = p.body.querySelector('.js-tag-input');
    const v = inp.value.trim();
    if (!v) return;
    saveTags([...new Set([...tags, ...v.split(',').map((x) => x.trim()).filter(Boolean)])]);
  });
  p.body.querySelector('.js-tag-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); p.body.querySelector('.js-tag-add').click(); } });
  p.body.querySelectorAll('.js-untag').forEach((b) => b.addEventListener('click', () => saveTags(tags.filter((t) => t !== b.dataset.t))));
  p.body.querySelector('.js-note-add')?.addEventListener('click', async () => {
    const inp = p.body.querySelector('.js-note-input');
    const text = inp.value.trim();
    if (!text) return;
    try {
      await platformService.addMerchantNote(m.id, text);
      toast.success('Note added');
      reload();
    } catch (err) { toast.error(err?.data?.message || 'Could not add note'); }
  });
  p.body.querySelectorAll('.js-note-del').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Delete this note?', confirmLabel: 'Delete', danger: true }))) return;
    await platformService.deleteMerchantNote(m.id, b.dataset.id);
    reload();
  }));

  if ((d.branchRequests || []).length) {
    p.body.insertAdjacentHTML('beforeend', `
      <h3 class="sa-h3">Additional branch purchases (${d.branchRequests.length})</h3>
      ${tableCard({
        head: [{ label: 'Date' }, { label: 'Branch' }, { label: 'Price', num: true }, { label: 'Status' }],
        rows: d.branchRequests.map((r) => `<tr>
          <td>${fmtDate(r.at)}</td>
          <td>${escapeHtml(r.name)}${r.code ? ` <span class="muted">(${escapeHtml(r.code)})</span>` : ''}</td>
          <td class="num">${fmtMoney(r.price)}</td>
          <td>${badge(r.status)}</td>
        </tr>`),
      })}`);
  }

  p.body.querySelectorAll('.js-confirm-pay').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Approve this payment?', message: 'Activates the subscription / branch and restores access.', confirmLabel: 'Approve' }))) return;
    await platformService.updatePayment(b.dataset.id, { status: 'paid' });
    toast.success('Payment approved');
    reload();
  }));
  p.body.querySelectorAll('.js-reject-pay').forEach((b) => b.addEventListener('click', async () => {
    const reason = window.prompt('Reason for rejecting this payment (shown to the merchant):', '');
    if (reason === null) return;
    await platformService.updatePayment(b.dataset.id, { status: 'rejected', reason });
    toast.success('Payment rejected');
    reload();
  }));

  function reload() { merchantDetailPage(ctx, mount); }
  liveRefresh(p.root, reload, 1500);

  async function approveAccount() {
    if (!(await confirmDialog({ title: `Approve ${d.business?.name || m.name}?`, message: 'Any pending payment is marked verified, the subscription is activated, and the merchant is notified.', confirmLabel: 'Approve & activate' }))) return;
    try {
      await platformService.approveMerchant(m.id);
      toast.success('Approved — the merchant now has access');
      reload();
    } catch (err) { toast.error(err?.data?.message || 'Could not approve'); }
  }

  async function setStatus(status) {
    const ok = await confirmDialog({
      title: status === 'suspended' ? 'Suspend this merchant?' : 'Reactivate this merchant?',
      message: status === 'suspended'
        ? 'All of their staff are signed out immediately and cannot use the POS until reactivated. Their data is kept.'
        : 'Their staff can sign in and use the POS again.',
      confirmLabel: status === 'suspended' ? 'Suspend' : 'Reactivate',
      danger: status === 'suspended',
    });
    if (!ok) return;
    await platformService.updateMerchant(m.id, { status });
    toast.success(status === 'suspended' ? 'Merchant suspended' : 'Merchant reactivated');
    reload();
  }

  async function resetOwner() {
    if (!(await confirmDialog({
      title: `Reset the owner password for ${d.business?.name || m.name}?`,
      message: 'A new temporary password is generated and their current one stops working immediately. Share it with the merchant over a trusted channel; they should change it after signing in.',
      confirmLabel: 'Generate temporary password',
      danger: true,
    }))) return;
    try {
      const res = await platformService.resetMerchantOwner(m.id);
      const dlg = openModal({
        title: 'Temporary password',
        size: 'sm',
        body: `<p class="text-sm">For <strong>${escapeHtml(res.name)}</strong> · <span class="mono">${escapeHtml(res.email)}</span></p>
          <div class="sa-kv"><span>Temporary password</span><b class="mono" style="user-select:all">${escapeHtml(res.tempPassword)}</b></div>
          <p class="muted text-xs" style="margin-top:8px">Shown once. Send it to the merchant now; they sign in at the portal and change it from their profile.</p>`,
        footer: '<button class="btn btn--primary js-modal-close">Done</button>',
      });
      void dlg;
      reload();
    } catch (err) { toast.error(err?.data?.message || 'Could not reset the password'); }
  }

  function sendMessage() {
    const dlg = openModal({ title: `Message ${d.business?.name || m.name}`, size: 'sm', body: '<div></div>' });
    createForm(dlg.$('.modal__body'), {
      fields: [
        { name: 'title', label: 'Subject', value: 'Message from POS TXbd' },
        { name: 'message', label: 'Message', type: 'textarea', rows: 4, required: true, hint: 'Shown in the merchant’s notification bell.' },
        { name: 'level', label: 'Importance', type: 'select', value: 'info', options: [{ value: 'info', label: 'Normal' }, { value: 'warning', label: 'Important' }] },
      ],
      submitLabel: 'Send message',
      onCancel: () => dlg.close(),
      onSubmit: async (v) => {
        await platformService.messageMerchant(m.id, v);
        dlg.close();
        toast.success('Message sent to the merchant');
        reload();
      },
    });
  }

  function recordPayment() {
    const dlg = openModal({ title: 'Record a subscription payment', size: 'sm', body: '<div></div>' });
    createForm(dlg.$('.modal__body'), {
      fields: [
        { name: 'type', label: 'Payment for', type: 'select', value: sub && !sub.setupPaid ? 'initial' : 'monthly', options: [
          { value: 'initial', label: 'Initial / setup fee' },
          { value: 'monthly', label: 'Monthly server & backup charge' },
          { value: 'branch', label: 'Additional branch' },
        ] },
        { name: 'amount', label: 'Amount received', type: 'number', required: true, value: sub ? ((sub.setupPaid ? (sub.monthlyPrice ?? sub.planPrice) : sub.setupPrice) || 0) / 100 : '', hint: 'In major units, e.g. 1900' },
        { name: 'method', label: 'Method', type: 'select', value: 'bkash', options: [['bkash', 'bKash'], ['nagad', 'Nagad'], ['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['manual', 'Other']].map(([value, label]) => ({ value, label })) },
        { name: 'reference', label: 'Reference / txn id' },
      ],
      submitLabel: 'Record payment',
      onCancel: () => dlg.close(),
      onSubmit: async (v) => {
        await platformService.recordPayment({ merchantId: m.id, type: v.type, amount: Math.round(Number(v.amount) * 100), method: v.method, reference: v.reference });
        dlg.close();
        toast.success('Payment recorded');
        reload();
      },
    });
  }

  async function manageSub() {
    let plans = [];
    try { plans = (await platformService.plans()).data.filter((x) => x.status === 'active'); } catch { /* */ }
    if (!sub) { toast.warning('This merchant has no subscription row yet.'); return; }
    const dlg = openModal({ title: 'Manage subscription', size: 'sm', body: '<div></div>' });
    createForm(dlg.$('.modal__body'), {
      fields: [
        { name: 'action', label: 'Action', type: 'select', value: 'renew', options: [['renew', 'Renew (extend one period)'], ['change-plan', 'Change plan'], ['cancel', 'Cancel'], ['set-status', 'Set status manually']].map(([value, label]) => ({ value, label })) },
        { name: 'planId', label: 'Plan (for change-plan)', type: 'select', value: sub.planId || '', options: plans.map((x) => ({ value: x.id, label: x.name })) },
        { name: 'status', label: 'Status (for set-status)', type: 'select', value: sub.status, options: ['pending', 'active', 'trialing', 'expired', 'cancelled'].map((s) => ({ value: s, label: s })) },
      ],
      submitLabel: 'Apply',
      onCancel: () => dlg.close(),
      onSubmit: async (v) => {
        const body = v.action === 'set-status' ? { action: 'update', status: v.status, planId: v.planId } : { action: v.action, planId: v.planId };
        await platformService.updateSubscription(sub.id, body);
        dlg.close();
        toast.success('Subscription updated');
        reload();
      },
    });
  }

  function roleName(id) {
    return { role_owner: 'Branch Owner', role_admin: 'Admin', role_manager: 'Manager', role_cashier: 'Cashier', role_inventory: 'Inventory Manager', role_accountant: 'Accountant' }[id] || id || '—';
  }
}

function badgeText(s) { return s === 'active' ? 'Active account' : 'Suspended'; }
