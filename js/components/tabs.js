/**
 * tabs.js - accessible tabs.
 * createTabs(mount, { tabs:[{ id, label, render(panelEl) }], active, onChange })
 */
import { escapeHtml } from '../utils/dom.js';

export function createTabs(mount, { tabs, active, onChange } = {}) {
  let current = active || tabs[0]?.id;
  mount.innerHTML = `
    <div class="tabs" role="tablist">
      ${tabs.map((t) => `<button class="tab" role="tab" id="tab-${t.id}" data-id="${t.id}" aria-selected="${t.id === current}" aria-controls="panel-${t.id}">${escapeHtml(t.label)}${t.badge != null ? ` <span class="badge badge--neutral" style="margin-left:6px">${escapeHtml(t.badge)}</span>` : ''}</button>`).join('')}
    </div>
    <div class="tabpanel" role="tabpanel" id="panel-holder"></div>`;

  const tablist = mount.querySelector('.tabs');
  const panel = mount.querySelector('#panel-holder');

  function activate(id) {
    current = id;
    tablist.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    panel.id = `panel-${id}`;
    panel.setAttribute('aria-labelledby', `tab-${id}`);
    panel.replaceChildren();
    const tab = tabs.find((t) => t.id === id);
    const out = tab?.render?.(panel);
    if (out instanceof Node) panel.appendChild(out);
    else if (typeof out === 'string') panel.innerHTML = out;
    onChange?.(id);
  }

  tablist.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) activate(btn.dataset.id);
  });
  tablist.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const idx = tabs.findIndex((t) => t.id === current);
    const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
    activate(tabs[next].id);
    tablist.querySelector(`[data-id="${tabs[next].id}"]`).focus();
  });

  activate(current);
  return { activate, current: () => current };
}

export default createTabs;
