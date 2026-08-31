/**
 * plans.js - the default POS TXbd subscription plans.
 *
 * Single source of truth for pricing: the Live/Public panel reads plans from
 * GET /plans, and the Super Admin panel edits these same records. Never hard-code
 * a price anywhere else - always read it from a plan.
 *
 * Prices are integer minor units (paisa), same as the rest of the money model.
 *
 * Every plan carries three prices:
 *   setupPrice      - one-time initial access / setup fee, paid before the
 *                     merchant account goes live
 *   monthlyPrice    - recurring server + backup charge (the subscription)
 *   extraBranchPrice- price of one branch beyond `includedBranches`; null falls
 *                     back to the platform default (platform_settings.billing)
 * `price` mirrors `monthlyPrice` so older readers (subscription snapshot, Live
 * panel) keep working.
 */

export const DEFAULT_PLANS = [
  {
    id: 'plan_starter',
    name: 'Starter',
    description: 'For a single shop getting started with POS.',
    setupPrice: 1500000,
    monthlyPrice: 90000,
    price: 90000,
    includedBranches: 1,
    extraBranchPrice: 250000,
    billingPeriod: 'monthly',
    currency: 'BDT',
    currencySymbol: '৳',
    popular: false,
    sortOrder: 1,
    status: 'active',
    features: [
      '1 branch included',
      'Up to 3 cashier accounts',
      'Unlimited products',
      'Barcode & invoice printing',
      'Sales & inventory reports',
      'Exchange & return',
    ],
    limits: { branches: 1, users: 3, products: 0 },
  },
  {
    id: 'plan_business',
    name: 'Business',
    description: 'For a growing business with more than one branch.',
    setupPrice: 2500000,
    monthlyPrice: 190000,
    price: 190000,
    includedBranches: 2,
    extraBranchPrice: 200000,
    billingPeriod: 'monthly',
    currency: 'BDT',
    currencySymbol: '৳',
    popular: true,
    sortOrder: 2,
    status: 'active',
    features: [
      '2 branches included',
      'Up to 15 cashier accounts',
      'Branch-wise stock & transfers',
      'Full analytics dashboard',
      'Customer accounts & loyalty',
      'Purchasing & suppliers',
      'Priority support',
    ],
    limits: { branches: 5, users: 15, products: 0 },
  },
  {
    id: 'plan_enterprise',
    name: 'Enterprise',
    description: 'For multi-outlet retailers that need it all.',
    setupPrice: 4000000,
    monthlyPrice: 390000,
    price: 390000,
    includedBranches: 5,
    extraBranchPrice: 150000,
    billingPeriod: 'monthly',
    currency: 'BDT',
    currencySymbol: '৳',
    popular: false,
    sortOrder: 3,
    status: 'active',
    features: [
      '5 branches included',
      'Unlimited cashier accounts',
      'Every Business feature',
      'Data export & backups',
      'Dedicated onboarding',
      'WhatsApp priority support',
    ],
    limits: { branches: 0, users: 0, products: 0 },
  },
];

export default DEFAULT_PLANS;
