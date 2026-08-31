/**
 * form.js - declarative form builder with inline validation.
 *
 * createForm(mount, {
 *   fields: [{ name, label, type, options, required, hint, placeholder, value,
 *              min, max, step, rows, prefix, suffix, colSpan, when(values),
 *              rules (validate.js), transform(v) }],
 *   schema: validate.js schema (optional, merged with field rules),
 *   values: initial values,
 *   onSubmit: async (values, form) => {},
 *   submitLabel, cancelLabel, onCancel,
 * })
 * types: text,email,tel,number,money,password,textarea,select,multiselect,
 *        checkbox,switch,date,datetime-local,hidden,color,custom
 * returns { getValues, setValues, setError, validate, submit, el, setBusy, field }
 */
import { escapeHtml } from '../utils/dom.js';
import { validate as runValidate } from '../utils/validate.js';
import money from '../utils/money.js';
import { icon } from './icons.js';

export function createForm(mount, opts) {
  const {
    fields, values: initial = {}, onSubmit, onCancel,
    submitLabel = 'Save', cancelLabel = 'Cancel', schema = {}, layout = 'grid',
    hideActions = false,
  } = opts;

  const values = { ...initial };
  fields.forEach((f) => {
    if (values[f.name] === undefined) {
      values[f.name] = f.value ?? (f.type === 'checkbox' || f.type === 'switch' ? false : f.type === 'multiselect' ? [] : '');
    }
  });

  const form = document.createElement('form');
  form.className = 'form-body stack';
  form.style.setProperty('--stack-gap', 'var(--sp-4)');
  form.noValidate = true;
  mount.replaceChildren(form);

  const grid = document.createElement('div');
  grid.className = layout === 'grid' ? 'field-grid' : 'stack';
  if (layout !== 'grid') grid.style.setProperty('--stack-gap', 'var(--sp-4)');
  form.appendChild(grid);

  const fieldEls = {};

  function fieldVisible(f) {
    return !f.when || f.when(values);
  }

  function renderField(f) {
    if (f.type === 'hidden') return null;
    const wrap = document.createElement('div');
    wrap.className = 'field';
    if (f.colSpan === 'full') wrap.style.gridColumn = '1 / -1';
    wrap.dataset.name = f.name;

    const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
    const req = f.required ? '<span class="req" aria-hidden="true">*</span>' : '';
    const labelHtml = f.type === 'checkbox' || f.type === 'switch' ? '' : `<label class="label" for="${id}">${escapeHtml(f.label || f.name)} ${req}</label>`;

    let control = '';
    const v = values[f.name];
    const common = `id="${id}" name="${f.name}" ${f.disabled ? 'disabled' : ''} aria-describedby="${id}-hint"`;

    switch (f.type) {
      case 'textarea':
        control = `<textarea class="textarea" ${common} rows="${f.rows || 3}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(v || '')}</textarea>`;
        break;
      case 'select':
        control = `<select class="select" ${common}>
          ${f.placeholder ? `<option value="">${escapeHtml(f.placeholder)}</option>` : ''}
          ${(f.options || []).map((o) => optionHtml(o, v)).join('')}
        </select>`;
        break;
      case 'multiselect':
        control = `<div class="stack" style="--stack-gap:var(--sp-1);border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:var(--sp-2);max-height:200px;overflow:auto">
          ${(f.options || []).map((o) => `<label class="check"><input type="checkbox" value="${escapeHtml(o.value)}" ${(v || []).includes(o.value) ? 'checked' : ''} data-multi="${f.name}"> ${escapeHtml(o.label)}</label>`).join('')}
        </div>`;
        break;
      case 'checkbox':
      case 'switch': {
        const cls = f.type === 'switch' ? 'switch' : 'check';
        const inner = f.type === 'switch'
          ? `<input type="checkbox" ${common} ${v ? 'checked' : ''}><span class="switch__track"><span class="switch__thumb"></span></span><span>${escapeHtml(f.label)}</span>`
          : `<input type="checkbox" ${common} ${v ? 'checked' : ''}> <span>${escapeHtml(f.label)}</span>`;
        control = `<label class="${cls}">${inner}</label>`;
        break;
      }
      case 'money':
        control = `<div class="input-group">
          <span class="input-group__addon">${escapeHtml(f.prefix || money.format(0).split(' ')[0])}</span>
          <input class="input" type="number" inputmode="decimal" step="0.01" min="${f.min ?? 0}" ${common} value="${v === '' || v == null ? '' : money.toMajor(v)}" placeholder="0.00">
        </div>`;
        break;
      case 'custom':
        control = f.render ? f.render(v, values) : '';
        break;
      default: {
        const type = f.type || 'text';
        const addonPre = f.prefix ? `<span class="input-group__addon">${escapeHtml(f.prefix)}</span>` : '';
        const addonPost = f.suffix ? `<span class="input-group__addon">${escapeHtml(f.suffix)}</span>` : '';
        const input = `<input class="input" type="${type}" ${common} value="${escapeHtml(v ?? '')}" placeholder="${escapeHtml(f.placeholder || '')}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}>`;
        control = addonPre || addonPost ? `<div class="input-group">${addonPre}${input}${addonPost}</div>` : input;
      }
    }

    wrap.innerHTML = `${labelHtml}${control}
      <div class="field-hint" id="${id}-hint" ${f.hint ? '' : 'hidden'}>${escapeHtml(f.hint || '')}</div>
      <div class="field-error" data-error hidden></div>`;

    // wire input events
    const input = wrap.querySelector('input,select,textarea');
    if (input && f.type !== 'multiselect') {
      const evt = ['checkbox', 'switch', 'select'].includes(f.type) || input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        values[f.name] = readControl(f, wrap);
        clearError(f.name);
        if (fields.some((x) => x.when)) refreshVisibility();
        opts.onChange?.(f.name, values[f.name], values);
      });
      input.addEventListener('blur', () => validateField(f));
    }
    if (f.type === 'multiselect') {
      wrap.querySelectorAll(`[data-multi="${f.name}"]`).forEach((cb) =>
        cb.addEventListener('change', () => {
          values[f.name] = wrap.querySelectorAll(`[data-multi="${f.name}"]:checked`);
          values[f.name] = [...wrap.querySelectorAll(`[data-multi="${f.name}"]:checked`)].map((c) => c.value);
          clearError(f.name);
        }),
      );
    }
    if (f.type === 'custom' && f.wire) f.wire(wrap, values, (name, val) => (values[name] = val));

    fieldEls[f.name] = wrap;
    return wrap;
  }

  function readControl(f, wrap) {
    const input = wrap.querySelector('input,select,textarea');
    if (!input) return values[f.name];
    if (f.type === 'checkbox' || f.type === 'switch') return input.checked;
    if (f.type === 'money') return input.value === '' ? '' : money.toMinor(input.value);
    if (f.type === 'number') return input.value === '' ? '' : Number(input.value);
    if (f.type === 'multiselect') return [...wrap.querySelectorAll(`[data-multi="${f.name}"]:checked`)].map((c) => c.value);
    return input.value;
  }

  function refreshVisibility() {
    fields.forEach((f) => {
      const el = fieldEls[f.name];
      if (!el) return;
      el.hidden = !fieldVisible(f);
    });
  }

  function buildSchema() {
    const merged = { ...schema };
    fields.forEach((f) => {
      // a field hidden by its when() is not submitted, so it must not be validated
      if (!fieldVisible(f)) {
        delete merged[f.name];
        return;
      }
      const rules = [...(f.rules || [])];
      if (f.required && !rules.includes('required')) rules.unshift('required');
      if (f.type === 'email') rules.push('email');
      if (f.type === 'tel') rules.push('phone');
      if (rules.length) merged[f.name] = { label: f.label, rules, custom: f.custom };
    });
    return merged;
  }

  function validateAll() {
    const visibleValues = {};
    fields.forEach((f) => {
      if (fieldVisible(f)) visibleValues[f.name] = values[f.name];
    });
    const { valid, errors } = runValidate(visibleValues, buildSchema());
    Object.keys(fieldEls).forEach((n) => clearError(n));
    for (const [name, msg] of Object.entries(errors)) setError(name, msg);
    if (!valid) {
      const first = fieldEls[Object.keys(errors)[0]];
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      first?.querySelector('input,select,textarea')?.focus();
    }
    return valid;
  }

  function validateField(f) {
    const s = buildSchema();
    if (!s[f.name]) return true;
    const { errors } = runValidate({ [f.name]: values[f.name] }, { [f.name]: s[f.name] });
    if (errors[f.name]) setError(f.name, errors[f.name]);
    else clearError(f.name);
    return !errors[f.name];
  }

  function setError(name, msg) {
    const wrap = fieldEls[name];
    if (!wrap) return;
    const err = wrap.querySelector('[data-error]');
    err.hidden = false;
    err.innerHTML = `${icon('alert-circle', { size: 13 })} ${escapeHtml(msg)}`;
    wrap.querySelector('input,select,textarea')?.setAttribute('aria-invalid', 'true');
    wrap.querySelector('.input,.select,.textarea')?.classList.add('input--invalid');
  }
  function clearError(name) {
    const wrap = fieldEls[name];
    if (!wrap) return;
    const err = wrap.querySelector('[data-error]');
    err.hidden = true;
    err.textContent = '';
    wrap.querySelector('input,select,textarea')?.removeAttribute('aria-invalid');
    wrap.querySelector('.input--invalid')?.classList.remove('input--invalid');
  }

  fields.forEach((f) => {
    const el = renderField(f);
    if (el) {
      grid.appendChild(el);
      if (!fieldVisible(f)) el.hidden = true;
    }
  });

  let actions;
  if (!hideActions) {
    actions = document.createElement('div');
    actions.className = 'form-actions';
    actions.innerHTML = `
      ${onCancel ? `<button type="button" class="btn btn--ghost js-form-cancel">${escapeHtml(cancelLabel)}</button>` : ''}
      <button type="submit" class="btn btn--primary js-form-submit">${escapeHtml(submitLabel)}</button>`;
    form.appendChild(actions);
    actions.querySelector('.js-form-cancel')?.addEventListener('click', () => onCancel?.());
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    fields.forEach((f) => (values[f.name] = fieldVisible(f) ? readControl(f, fieldEls[f.name] || form) : values[f.name]));
    fields.forEach((f) => {
      if (f.transform && values[f.name] !== '' && values[f.name] != null) values[f.name] = f.transform(values[f.name]);
    });
    if (!validateAll()) return;
    api.setBusy(true);
    try {
      await onSubmit?.(getClean(), api);
    } catch (err) {
      if (err?.errors) {
        Object.entries(err.errors).forEach(([n, m]) => setError(n, m));
      } else {
        api.formError(err?.data?.message || err?.message || 'Could not save. Please try again.');
      }
    } finally {
      api.setBusy(false);
    }
  });

  function getClean() {
    const out = {};
    fields.forEach((f) => {
      if (f.type === 'hidden') out[f.name] = values[f.name];
      else if (fieldVisible(f)) out[f.name] = values[f.name];
    });
    // include hidden-typed initial values
    Object.keys(initial).forEach((k) => {
      if (!(k in out)) out[k] = initial[k];
    });
    return out;
  }

  const api = {
    el: form,
    getValues: getClean,
    raw: () => ({ ...values }),
    setValues(patch) {
      Object.assign(values, patch);
      // re-render affected fields
      fields.forEach((f) => {
        if (f.name in patch && fieldEls[f.name]) {
          const fresh = renderField(f);
          fieldEls[f.name].replaceWith(fresh);
        }
      });
      refreshVisibility();
    },
    setOptions(name, options) {
      const f = fields.find((x) => x.name === name);
      if (!f) return;
      f.options = options;
      const sel = fieldEls[name]?.querySelector('select');
      if (sel) {
        const cur = values[name];
        sel.innerHTML = (f.placeholder ? `<option value="">${escapeHtml(f.placeholder)}</option>` : '') + options.map((o) => optionHtml(o, cur)).join('');
      }
    },
    setError,
    clearError,
    validate: validateAll,
    submit: () => form.requestSubmit(),
    setBusy(busy) {
      form.querySelectorAll('input,select,textarea,button').forEach((n) => (n.disabled = busy));
      const btn = form.querySelector('.js-form-submit');
      if (btn) {
        btn.classList.toggle('is-loading', busy);
        btn.innerHTML = busy ? `<span class="spinner spinner--invert"></span> Saving…` : escapeHtml(submitLabel);
      }
    },
    formError(msg) {
      let banner = form.querySelector('.js-form-error');
      if (!banner) {
        banner = document.createElement('div');
        banner.className = 'alert alert--danger js-form-error';
        form.prepend(banner);
      }
      banner.innerHTML = `<span class="alert__icon">${icon('alert-circle')}</span><div class="alert__body">${escapeHtml(msg)}</div>`;
      banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    field: (name) => fieldEls[name],
  };
  return api;
}

function optionHtml(o, current) {
  const opt = typeof o === 'string' ? { value: o, label: o } : o;
  const sel = String(current) === String(opt.value) ? 'selected' : '';
  return `<option value="${escapeHtml(opt.value)}" ${sel} ${opt.disabled ? 'disabled' : ''}>${escapeHtml(opt.label)}</option>`;
}

export default createForm;
