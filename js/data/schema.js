/**
 * schema.js - field metadata + validation schemas.
 * Consumed by the form component (to render + validate inline) and by services
 * (assertValid before hitting the API). The mock backend re-validates
 * authoritatively - never trust the client.
 */

export const productSchema = {
  name: { label: 'Product name', rules: ['required', ['maxLength', 120]], coerce: 'trim' },
  sku: { label: 'SKU', rules: [['maxLength', 60]], coerce: 'trim' },
  barcode: { label: 'Barcode', rules: [['maxLength', 40]], coerce: 'trim' },
  categoryId: { label: 'Category', rules: [] },
  brandId: { label: 'Brand', rules: [] },
  unit: { label: 'Unit', rules: ['required'] },
  costPrice: { label: 'Purchase price', rules: ['required', 'number', 'nonNegative'], coerce: 'number' },
  mrp: { label: 'MRP', rules: ['number', 'nonNegative'], coerce: 'number' },
  sellingPrice: { label: 'Selling price', rules: ['required', 'number', 'positive'], coerce: 'number' },
  wholesalePrice: { label: 'Wholesale price', rules: ['number', 'nonNegative'], coerce: 'number' },
  minStock: { label: 'Minimum stock', rules: ['number', 'nonNegative'], coerce: 'number' },
  maxStock: { label: 'Maximum stock', rules: ['number', 'nonNegative'], coerce: 'number' },
  openingStock: { label: 'Opening stock', rules: ['number', 'nonNegative'], coerce: 'number' },
};

export const categorySchema = {
  name: { label: 'Category name', rules: ['required', ['maxLength', 80]], coerce: 'trim' },
  order: { label: 'Display order', rules: ['integer'], coerce: 'number' },
};

export const brandSchema = {
  name: { label: 'Brand name', rules: ['required', ['maxLength', 80]], coerce: 'trim' },
};

export const customerSchema = {
  name: { label: 'Customer name', rules: ['required', ['maxLength', 120]], coerce: 'trim' },
  phone: { label: 'Phone', rules: ['phone'], coerce: 'trim' },
  email: { label: 'Email', rules: ['email'], coerce: 'trim' },
  openingBalance: { label: 'Opening balance', rules: ['number'], coerce: 'number' },
};

export const supplierSchema = {
  name: { label: 'Supplier name', rules: ['required', ['maxLength', 120]], coerce: 'trim' },
  phone: { label: 'Phone', rules: ['phone'], coerce: 'trim' },
  email: { label: 'Email', rules: ['email'], coerce: 'trim' },
  openingBalance: { label: 'Previous balance', rules: ['number'], coerce: 'number' },
};

export const employeeSchema = {
  name: { label: 'Full name', rules: ['required', ['maxLength', 120]], coerce: 'trim' },
  email: { label: 'Email', rules: ['required', 'email'], coerce: 'trim' },
  phone: { label: 'Phone', rules: ['phone'], coerce: 'trim' },
  roleId: { label: 'Role', rules: ['required'] },
  password: { label: 'Password', rules: [['minLength', 8]] },
};

export const expenseSchema = {
  category: { label: 'Category', rules: ['required'] },
  description: { label: 'Description', rules: ['required', ['maxLength', 160]], coerce: 'trim' },
  amount: { label: 'Amount', rules: ['required', 'number', 'positive'], coerce: 'number' },
  paymentMethod: { label: 'Payment method', rules: ['required'] },
};

export const taxSchema = {
  name: { label: 'Tax name', rules: ['required', ['maxLength', 60]], coerce: 'trim' },
  // rate applies to percentage VAT; a fixed-amount VAT sends `amount` instead —
  // the backend enforces the right one per `type`.
  rate: { label: 'Rate (%)', rules: ['number', ['min', 0], ['max', 100]], coerce: 'number' },
};

export const discountSchema = {
  name: { label: 'Name', rules: ['required', ['maxLength', 80]], coerce: 'trim' },
  type: { label: 'Type', rules: ['required', ['oneOf', ['percent', 'fixed']]] },
  value: { label: 'Value', rules: ['required', 'number', 'positive'], coerce: 'number' },
};

export const branchSchema = {
  name: { label: 'Branch name', rules: ['required', ['maxLength', 80]], coerce: 'trim' },
  code: { label: 'Code', rules: [['maxLength', 6]], coerce: 'trim' },
  phone: { label: 'Phone', rules: ['phone'], coerce: 'trim' },
};

export const UNITS = ['pcs', 'box', 'pack', 'set', 'ml', 'g', 'kg', 'litre', 'pair', 'dozen'];
export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'mobile', label: 'Mobile Banking' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
];
export const RETURN_REASONS = [
  { value: 'customer_request', label: 'Customer changed mind' },
  { value: 'defective', label: 'Defective / faulty' },
  { value: 'damaged', label: 'Damaged in transit' },
  { value: 'wrong_item', label: 'Wrong item sold' },
  { value: 'expired', label: 'Expired product' },
];
export const ADJUSTMENT_REASONS = [
  { value: 'recount', label: 'Stock recount' },
  { value: 'damage', label: 'Damage' },
  { value: 'lost', label: 'Lost / shrinkage' },
  { value: 'expiry', label: 'Expired' },
  { value: 'theft', label: 'Theft' },
  { value: 'correction', label: 'Data correction' },
  { value: 'manual', label: 'Other (manual)' },
];
