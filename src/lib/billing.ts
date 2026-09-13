// Cherry + web billing via RevenueCat Web Billing. Dormant by default: nothing
// here runs without a Web Billing key, and callers fall back to the read-only
// entitlement. This is the only module that touches the purchases SDK.
// The SDK is keyed to the Firebase uid so RevenueCat's webhook lands on
// users/{uid}.isPlus, the same path the mobile apps use.

import {
  Purchases,
  PurchasesError,
  ErrorCode,
  type Package,
  type CustomerInfo,
} from '@revenuecat/purchases-js';

// Must match the entitlement identifier in the RevenueCat dashboard.
export const PLUS_ENTITLEMENT_ID = 'have_another_cherry';

// Publishable key, safe in the bundle. Empty by default; VITE_RC_WEB_KEY turns web selling on.
const RAW_KEY: string = ((import.meta as any).env?.VITE_RC_WEB_KEY || '').trim();

// A prefix check rather than truthiness: App Hosting rejects an empty value,
// so a backend that must not sell is switched off with a real string, and
// that string has to mean off.
const VALID_KEY_PREFIXES = ['strp_', 'rcb_', 'test_'];
const API_KEY: string = VALID_KEY_PREFIXES.some((p) => RAW_KEY.startsWith(p)) ? RAW_KEY : '';

export const isSandboxBilling = API_KEY.startsWith('test_');

/** Whether web billing is enabled for this build. */
export function billingAvailable(): boolean {
  return API_KEY.length > 0;
}

/**
 * Configure (or re-key) the SDK for the signed-in user. Call after Firebase
 * auth resolves. Never configure anonymously on purpose: an anonymous
 * purchase can't be mapped to users/{uid} by the webhook.
 */
export async function configureBilling(firebaseUid: string): Promise<void> {
  if (!billingAvailable() || !firebaseUid) return;
  if (Purchases.isConfigured()) {
    const shared = Purchases.getSharedInstance();
    if (shared.getAppUserId() !== firebaseUid) {
      await shared.changeUser(firebaseUid);
    }
    return;
  }
  Purchases.configure(API_KEY, firebaseUid);
}

export interface PlusPlan {
  /** RevenueCat package - pass back to purchasePlus. */
  pkg: Package;
  /** 'monthly' | 'yearly' | 'lifetime' | package identifier fallback. */
  key: string;
  title: string;
  /** Localized price string, e.g. "$3.99". */
  price: string;
}

const PLAN_ORDER = ['monthly', 'yearly', 'lifetime'];

function planKey(pkg: Package): string {
  const id = pkg.identifier.replace(/^\$rc_/, '').toLowerCase();
  if (id.includes('life')) return 'lifetime';
  if (id.includes('annual') || id.includes('year')) return 'yearly';
  if (id.includes('month')) return 'monthly';
  return id;
}

/** The current offering's plans, cheapest cadence first. Empty = not set up. */
export async function plusOfferings(): Promise<PlusPlan[]> {
  if (!Purchases.isConfigured()) return [];
  try {
    const offerings = await Purchases.getSharedInstance().getOfferings();
    const packages = offerings.current?.availablePackages ?? [];
    return packages
      .map((pkg) => ({
        pkg,
        key: planKey(pkg),
        title: pkg.webBillingProduct?.title || pkg.identifier,
        price: pkg.webBillingProduct?.currentPrice?.formattedPrice ?? '',
      }))
      .sort((a, b) => PLAN_ORDER.indexOf(a.key) - PLAN_ORDER.indexOf(b.key));
  } catch (e) {
    console.error('Could not load Cherry + offerings', e);
    return [];
  }
}

export type PurchaseOutcome =
  | { status: 'purchased'; customerInfo: CustomerInfo }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Open RevenueCat's hosted checkout for one plan. Resolves when the flow
 * closes. 'purchased' means the entitlement is already active on the
 * returned CustomerInfo - unlock the UI immediately; the webhook write to
 * users/{uid}.isPlus follows and makes it durable everywhere.
 */
export async function purchasePlus(
  plan: PlusPlan,
  customerEmail?: string
): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.getSharedInstance().purchase({
      rcPackage: plan.pkg,
      ...(customerEmail ? { customerEmail } : {}),
    });
    return { status: 'purchased', customerInfo };
  } catch (e) {
    if (e instanceof PurchasesError && e.errorCode === ErrorCode.UserCancelledError) {
      return { status: 'cancelled' };
    }
    console.error('Cherry + purchase failed', e);
    return {
      status: 'error',
      message:
        e instanceof PurchasesError && e.message
          ? e.message
          : 'The purchase did not go through - you have not been charged.',
    };
  }
}

/**
 * Web Billing's customer portal (the Customer Center equivalent on web):
 * update payment method, view invoices, cancel. Null when the user has no
 * web subscription to manage.
 */
// Stripe's hosted customer portal: the fallback when RevenueCat returns no
// managementURL. Public by design; it identifies nobody until an address is
// entered and verified by Stripe.
const STRIPE_PORTAL_URL = 'https://billing.stripe.com/p/login/bJe8wR3Xt08M1Ce889d7q00';

// Stores that manage their own subscriptions; Stripe's portal cannot help their customers.
const SELF_MANAGED_STORES = ['app_store', 'mac_app_store', 'play_store', 'amazon'];

/**
 * Whether RevenueCat currently holds an active Cherry + entitlement for the
 * configured user. Read straight from the SDK, so it is true on the very
 * next sign-in after a purchase even before the profile catches up. False
 * when billing is off or the SDK cannot answer.
 */
export async function plusEntitlementActive(): Promise<boolean> {
  if (!Purchases.isConfigured()) return false;
  try {
    const info = await Purchases.getSharedInstance().getCustomerInfo();
    return PLUS_ENTITLEMENT_ID in info.entitlements.active;
  } catch {
    return false;
  }
}

export async function manageSubscriptionUrl(): Promise<string | null> {
  if (!Purchases.isConfigured()) return null;
  try {
    const info = await Purchases.getSharedInstance().getCustomerInfo();
    if (info.managementURL) return info.managementURL;

    // Only offer the Stripe portal to someone who could plausibly be in it.
    const active = Object.values(info.entitlements.active);
    const boughtElsewhere = active.some((e) =>
      SELF_MANAGED_STORES.includes((e as { store?: string }).store ?? '')
    );
    return boughtElsewhere ? null : STRIPE_PORTAL_URL;
  } catch {
    return null;
  }
}
