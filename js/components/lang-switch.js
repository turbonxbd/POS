/**
 * lang-switch.js - বাংলা / English toggle. Mount into any topbar container.
 */
import { LANGS, getLang, applyLang } from '../core/i18n.js';
import bus from '../core/event-bus.js';

export function langSwitchHTML() {
  const cur = getLang();
  return `<div class="lang-switch" role="group" aria-label="Language" data-no-i18n>
    ${LANGS.map((l) => `<button type="button" data-lang="${l.code}" aria-pressed="${l.code === cur}">${l.label}</button>`).join('')}
  </div>`;
}

export function wireLangSwitch(root) {
  const el = root.querySelector('.lang-switch');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (b) applyLang(b.dataset.lang);
  });
  const sync = () => {
    const cur = getLang();
    el.querySelectorAll('button[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === cur)));
  };
  bus.on('lang:changed', sync);
  sync();
}

/** Convenience: insert the switch as the first child of a container element. */
export function mountLangSwitch(container) {
  if (!container || container.querySelector('.lang-switch')) return;
  container.insertAdjacentHTML('afterbegin', langSwitchHTML());
  wireLangSwitch(container);
}

export default mountLangSwitch;
