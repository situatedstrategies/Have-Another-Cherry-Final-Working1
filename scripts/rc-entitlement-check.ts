// server/revenuecat.ts: reading a Cherry + entitlement out of a RevenueCat
// v1 subscriber response. Run with npm run test:parity.
import { entitlementFromSubscriber } from '../server/revenuecat';

let bad = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const now = Date.parse('2026-09-13T00:00:00Z');
const future = '2026-10-13T00:00:00Z';
const past = '2026-08-13T00:00:00Z';
const sub = (over: any) => ({ subscriber: { entitlements: {}, subscriptions: {}, non_subscriptions: {}, ...over } });

// The case that bit a customer: a Stripe purchase through RevenueCat Web Billing.
const stripe = sub({
  entitlements: { have_another_cherry: { expires_date: future, product_identifier: 'hac_monthly01' } },
  subscriptions: { hac_monthly01: { store: 'stripe', expires_date: future } },
});
check('active stripe subscription is a web entitlement', entitlementFromSubscriber(stripe, now), {
  active: true, source: 'revenuecat_web', productId: 'hac_monthly01', expiresAt: new Date(Date.parse(future)).toISOString(),
});

check('rc_billing store also maps to web', entitlementFromSubscriber(sub({
  entitlements: { have_another_cherry: { expires_date: future, product_identifier: 'p' } },
  subscriptions: { p: { store: 'rc_billing' } },
}), now).source, 'revenuecat_web');

check('app store maps to ios', entitlementFromSubscriber(sub({
  entitlements: { have_another_cherry: { expires_date: future, product_identifier: 'p' } },
  subscriptions: { p: { store: 'app_store' } },
}), now).source, 'revenuecat_ios');

check('play store maps to android', entitlementFromSubscriber(sub({
  entitlements: { have_another_cherry: { expires_date: future, product_identifier: 'p' } },
  subscriptions: { p: { store: 'play_store' } },
}), now).source, 'revenuecat_android');

// Lifetime: no expiry, store comes from non_subscriptions.
check('lifetime purchase has no expiresAt and reads the store from non_subscriptions', entitlementFromSubscriber(sub({
  entitlements: { have_another_cherry: { expires_date: null, product_identifier: 'hac_lifetime00' } },
  non_subscriptions: { hac_lifetime00: [{ store: 'stripe', purchase_date: past }] },
}), now), { active: true, source: 'revenuecat_web', productId: 'hac_lifetime00' });

// Expired entitlements stay in the map; presence is not activity.
check('an expired entitlement is not active', entitlementFromSubscriber(sub({
  entitlements: { have_another_cherry: { expires_date: past, product_identifier: 'p' } },
  subscriptions: { p: { store: 'stripe' } },
}), now), { active: false });

check('no entitlement at all', entitlementFromSubscriber(sub({}), now), { active: false });
check('a different entitlement id does not count', entitlementFromSubscriber(sub({
  entitlements: { something_else: { expires_date: future, product_identifier: 'p' } },
}), now), { active: false });
check('garbage input is not active', entitlementFromSubscriber(null, now), { active: false });
check('unparseable expiry is treated as not active', entitlementFromSubscriber(sub({
  entitlements: { have_another_cherry: { expires_date: 'soon', product_identifier: 'p' } },
}), now), { active: false });

console.log(bad ? `\n${bad} FAILURES` : '\nall RevenueCat entitlement rules hold');
if (bad) process.exit(1);
