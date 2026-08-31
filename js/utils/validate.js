/**
 * validate.js - declarative validation used by services (authoritative) and by
 * the form component (inline UX). Same rules run in both places.
 */

export class ValidationError extends Error {
  constructor(errors, message = 'Validation failed') {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors; // { field: 'message' }
    this.status = 422;
  }
}

const RULES = {
  required: (v) => (v == null || v === '' || (Array.isArray(v) && v.length === 0)) && 'This field is required',
  string: (v) => v != null && typeof v !== 'string' && 'Must be text',
  number: (v) => v !== '' && v != null && !Number.isFinite(Number(v)) && 'Must be a number',
  integer: (v) => v !== '' && v != null && !Number.isInteger(Number(v)) && 'Must be a whole number',
  min: (v, n) => Number(v) < n && `Must be at least ${n}`,
  max: (v, n) => Number(v) > n && `Must be at most ${n}`,
  minLength: (v, n) => String(v || '').length < n && `Must be at least ${n} characters`,
  maxLength: (v, n) => String(v || '').length > n && `Must be at most ${n} characters`,
  email: (v) => v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && 'Enter a valid email',
  phone: (v) => v && !/^[0-9+\-\s()]{6,20}$/.test(String(v)) && 'Enter a valid phone number',
  pattern: (v, re) => v && !new RegExp(re).test(v) && 'Invalid format',
  oneOf: (v, list) => v != null && v !== '' && !list.includes(v) && `Must be one of: ${list.join(', ')}`,
  positive: (v) => v !== '' && v != null && Number(v) <= 0 && 'Must be greater than 0',
  nonNegative: (v) => v !== '' && v != null && Number(v) < 0 && 'Cannot be negative',
};

/**
 * validate(data, schema) -> { valid, errors, value }
 * schema: { field: { rules: ['required', ['min', 0]], label, coerce } }
 */
export function validate(data, schema) {
  const errors = {};
  const value = { ...data };
  for (const [field, def] of Object.entries(schema)) {
    let val = data[field];
    if (def.coerce === 'number') val = val === '' || val == null ? val : Number(val);
    if (def.coerce === 'trim' && typeof val === 'string') val = val.trim();
    if (def.coerce === 'boolean') val = Boolean(val);
    value[field] = val;

    const rules = def.rules || [];
    const isEmpty = val == null || val === '';
    for (const rule of rules) {
      const [name, arg] = Array.isArray(rule) ? rule : [rule, undefined];
      if (name !== 'required' && isEmpty) continue; // only 'required' checks emptiness
      const fn = RULES[name];
      if (!fn) continue;
      const result = fn(val, arg);
      if (result) {
        errors[field] = def.messages?.[name] || result;
        break;
      }
    }
    if (def.custom && !errors[field]) {
      const msg = def.custom(val, value);
      if (msg) errors[field] = msg;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors, value };
}

/** Throwing variant for service layer. */
export function assertValid(data, schema) {
  const { valid, errors, value } = validate(data, schema);
  if (!valid) throw new ValidationError(errors);
  return value;
}

export function isBlank(v) {
  return v == null || String(v).trim() === '';
}
