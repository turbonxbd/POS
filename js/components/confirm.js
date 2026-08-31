/**
 * confirm.js - promise-based confirmation dialog for dangerous actions.
 * const ok = await confirmDialog({ title, message, confirmLabel, danger:true });
 */
import { openModal } from './modal.js';
import { escapeHtml } from '../utils/dom.js';
import { icon } from './icons.js';

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  detail = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  requireText = null, // require typing this string to enable confirm
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
      m.close();
    };

    const m = openModal({
      title,
      size: 'sm',
      closeOnBackdrop: true,
      body: `
        <div class="stack" style="--stack-gap:var(--sp-3)">
          <div class="row" style="align-items:flex-start;gap:var(--sp-3)">
            <span style="color:var(--${danger ? 'danger' : 'warning'}-solid);flex-shrink:0">${icon(danger ? 'alert-triangle' : 'alert-circle', { size: 22 })}</span>
            <div>
              <p style="color:var(--text-primary)">${escapeHtml(message)}</p>
              ${detail ? `<p class="muted text-sm" style="margin-top:6px">${escapeHtml(detail)}</p>` : ''}
            </div>
          </div>
          ${requireText ? `
          <label class="field">
            <span class="label">Type <strong>${escapeHtml(requireText)}</strong> to confirm</span>
            <input class="input js-confirm-text" autocomplete="off" spellcheck="false">
          </label>` : ''}
        </div>`,
      footer: `
        <button class="btn btn--ghost js-cancel">${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'} js-confirm" ${requireText ? 'disabled' : ''}>${escapeHtml(confirmLabel)}</button>`,
      onClose: () => done(false),
    });

    const confirmBtn = m.$('.js-confirm');
    m.$('.js-cancel').addEventListener('click', () => done(false));
    confirmBtn.addEventListener('click', () => done(true));

    if (requireText) {
      const input = m.$('.js-confirm-text');
      input.addEventListener('input', () => {
        confirmBtn.disabled = input.value.trim() !== requireText;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) done(true);
      });
    } else {
      setTimeout(() => confirmBtn.focus(), 80);
    }
  });
}

export default confirmDialog;
