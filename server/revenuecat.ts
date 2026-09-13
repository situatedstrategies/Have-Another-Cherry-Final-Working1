// RevenueCat as the source of truth for a paid Cherry + entitlement.
//
// The webhook (/api/revenuecat-webhook) is the fast path: RevenueCat calls us
// the moment something changes. It is also a single point of failure: a
// wrong Authorization header, a secret left at "disabled", or a delivery that
// RevenueCat gave up retrying, and the purchase unlocks for one session (the
// client trusts the purchase result) and then vanishes on the next sign-in
// because users/{uid}.isPlus was never written. That is exactly what a
// customer saw on a web (Stripe) purchase.
//
// So the entitlement sync that every client already runs at sign-in also
// asks RevenueCat directly. GET /v1/subscribers/{app_user_id} answers with a
// public SDK key (it is the same call the SDKs make), and the app user id is
// the Firebase uid on every platform, so one request settles it regardless
// of which store the purchase came through.

export const PLUS_ENTITLEMENT_ID = 'have_another_cherry';

export type EntitlementSource =
  | 'revenuecat_ios'
  | 'revenuecat_android'
  | 'revenuecat_web'
  | 'promo';

export interface RcEntitlementState {
  active: boolean;
  source?: EntitlementSource;
  productId?: string;
  /** ISO datetime; absent for a non-expiring (lifetime) purchase. */
  expiresAt?: string;
}

const sourceForStore = (store: unknown): EntitlementSource => {
  const s = String(store || '').toLowerCase();
  if (s === 'play_store' || s === 'amazon') return 'revenuecat_android';
  if (s === 'stripe' || s === 'rc_billing' || s === 'paddle') return 'revenuecat_web';
  if (s === 'promotional') return 'promo';
  return 'revenuecat_ios';
};

/**
 * Pure: read the entitlement out of a v1 subscriber response. `now` is
 * injectable so the expiry rule can be tested without waiting.
 */
export function entitlementFromSubscriber(
  body: any,
  now: number = Date.now(),
  entitlementId: string = PLUS_ENTITLEMENT_ID
): RcEntitlementState {
  const subscriber = body?.subscriber;
  const ent = subscriber?.entitlements?.[entitlementId];
  if (!ent) return { active: false };

  const expiresRaw = ent.expires_date;
  const expiresMs = expiresRaw ? Date.parse(String(expiresRaw)) : NaN;
  // RevenueCat keeps an expired entitlement in the map with its old date, so
  // presence alone is not activity.
  if (expiresRaw && (!Number.isFinite(expiresMs) || expiresMs <= now)) {
    return { active: false };
  }

  const productId = String(ent.product_identifier || '');
  const sub = subscriber?.subscriptions?.[productId];
  const nonSub = Array.isArray(subscriber?.non_subscriptions?.[productId])
    ? subscriber.non_subscriptions[productId]
    : [];
  const store = sub?.store ?? nonSub[nonSub.length - 1]?.store;

  return {
    active: true,
    source: sourceForStore(store),
    productId,
    ...(expiresRaw ? { expiresAt: new Date(expiresMs).toISOString() } : {}),
  };
}

const apiKey = (): string =>
  String(process.env.REVENUECAT_API_KEY || process.env.VITE_RC_WEB_KEY || '').trim();

/**
 * Ask RevenueCat about one subscriber. Returns null when the check could not
 * be made (no key, network, non-200), which callers must treat as "unknown",
 * never as "not entitled": revoking on a timeout would lock out a paying
 * customer for the duration of an outage.
 */
export async function fetchRevenueCatEntitlement(uid: string): Promise<RcEntitlementState | null> {
  const key = apiKey();
  if (!key || !uid) return null;
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('RevenueCat subscriber lookup failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return entitlementFromSubscriber(await res.json());
  } catch (err: any) {
    console.error('RevenueCat subscriber lookup error:', err?.message || err);
    return null;
  }
}
