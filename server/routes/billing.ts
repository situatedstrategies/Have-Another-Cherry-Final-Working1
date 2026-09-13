import express from 'express';
import { rateLimit, requireAuth, requireSecret } from '../middleware';
import { ensureAdminApp } from '../shared';
import { fetchRevenueCatEntitlement } from '../revenuecat';

const router = express.Router();

// ---- Cherry + entitlement sync ----
// Every client calls this once after sign-in (and the web client again right
// after a purchase). It settles users/{uid}.isPlus from two sources, in
// order:
//
//   1. PLUS_PROMO_EMAILS: sign-in emails that get Cherry + without paying.
//      The email comes from the verified token. Removing an address revokes
//      on the next sign-in; a paid entitlement is never replaced by promo.
//   2. RevenueCat's own record of the subscriber (server/revenuecat.ts). The
//      webhook is the fast path for the same fact; this is the one that
//      cannot be misconfigured away, so a web purchase survives sign-out even
//      if the webhook never arrived. A definitive "not entitled" from
//      RevenueCat revokes an entitlement that RevenueCat granted; an
//      unreachable RevenueCat changes nothing.
//
// The write goes through the Admin SDK because the rules forbid clients from
// touching isPlus.
const PROMO_PRODUCT = 'promo_allowlist';
const promoEmails = () =>
  new Set(
    String(process.env.PLUS_PROMO_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );

router.post('/api/plus-promo-sync', requireAuth, rateLimit('plus-promo', 20), async (req, res) => {
  try {
    const uid = (req as any).uid as string;
    const email = String((req as any).firebaseUser?.email || '').toLowerCase();
    const listed = !!email && promoEmails().has(email);

    await ensureAdminApp();
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const ref = getFirestore().collection('users').doc(uid);
    const snap = await ref.get();
    const data = snap.data() || {};
    const current = data.plusEntitlement || {};
    const heldByPromo = current.source === 'promo' && current.productId === PROMO_PRODUCT;
    const heldByStore = typeof current.source === 'string' && current.source.startsWith('revenuecat_');
    const now = new Date().toISOString();

    // 1. Allowlist.
    if (listed) {
      if (!data.isPlus || heldByPromo) {
        await ref.set(
          { isPlus: true, plusEntitlement: { source: 'promo', productId: PROMO_PRODUCT, updatedAt: now } },
          { merge: true }
        );
      }
      return res.json({ isPlus: true, source: data.isPlus && !heldByPromo ? current.source : 'promo' });
    }

    // 2. RevenueCat.
    const rc = await fetchRevenueCatEntitlement(uid);
    if (rc?.active) {
      const changed =
        !data.isPlus ||
        current.source !== rc.source ||
        current.productId !== rc.productId ||
        (current.expiresAt || null) !== (rc.expiresAt || null);
      if (changed) {
        await ref.set(
          {
            isPlus: true,
            plusEntitlement: {
              source: rc.source,
              productId: rc.productId || '',
              ...(rc.expiresAt ? { expiresAt: rc.expiresAt } : { expiresAt: FieldValue.delete() }),
              updatedAt: now,
            },
          },
          { merge: true }
        );
      }
      return res.json({ isPlus: true, source: rc.source, verified: 'revenuecat' });
    }

    // 3. Nothing grants it. Revoke only what this endpoint or the webhook
    //    granted, and only on a definitive answer.
    if (heldByPromo || (heldByStore && rc && !rc.active)) {
      await ref.set({ isPlus: false, plusEntitlement: FieldValue.delete() }, { merge: true });
      return res.json({ isPlus: false, revoked: true });
    }
    return res.json({ isPlus: !!data.isPlus });
  } catch (err: any) {
    console.error('Entitlement sync error:', err?.message || err);
    return res.status(500).json({ error: 'Could not check Cherry + status.' });
  }
});

// ---- Billing: RevenueCat webhook ----
// The activation point for paid subscriptions. RevenueCat calls this with
// appUserID = Firebase uid and the entitlement is mirrored onto users/{uid},
// which every client reads through hasPlus(). Dormant until
// REVENUECAT_WEBHOOK_AUTH is set; the same value goes in RevenueCat's
// webhook settings.
router.post(
  '/api/revenuecat-webhook',
  requireSecret({
    env: 'REVENUECAT_WEBHOOK_AUTH',
    header: 'authorization',
    notConfigured: 'Cherry + billing is not configured yet.',
    unauthorized: 'Unauthorized',
    disabledSentinel: true,
  }),
  async (req, res) => {
    try {
      const event = req.body?.event;
      const uid = event?.app_user_id;
      if (!uid || typeof uid !== 'string' || uid.startsWith('$RCAnonymousID')) {
        // Not mappable to an account; acknowledge so RevenueCat stops retrying.
        return res.status(200).json({ received: true, ignored: 'no mappable app_user_id' });
      }

      const type = String(event?.type || '');
      const ACTIVATING = [
        'INITIAL_PURCHASE',
        'RENEWAL',
        'UNCANCELLATION',
        'PRODUCT_CHANGE',
        'NON_RENEWING_PURCHASE',
      ];
      const DEACTIVATING = ['EXPIRATION'];
      if (!ACTIVATING.includes(type) && !DEACTIVATING.includes(type)) {
        // CANCELLATION and the rest leave the entitlement active until EXPIRATION.
        return res.status(200).json({ received: true, ignored: type });
      }

      await ensureAdminApp();
      const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
      const userRef = getFirestore().collection('users').doc(uid);

      if (DEACTIVATING.includes(type)) {
        await userRef.set({ isPlus: false, plusEntitlement: FieldValue.delete() }, { merge: true });
      } else {
        await userRef.set(
          {
            isPlus: true,
            plusEntitlement: {
              source:
                event?.store === 'PLAY_STORE'
                  ? 'revenuecat_android'
                  : event?.store === 'STRIPE' || event?.store === 'RC_BILLING'
                    ? 'revenuecat_web'
                    : 'revenuecat_ios',
              productId: event?.product_id || '',
              ...(event?.expiration_at_ms
                ? { expiresAt: new Date(Number(event.expiration_at_ms)).toISOString() }
                : {}),
              updatedAt: new Date().toISOString(),
            },
          },
          { merge: true }
        );
      }

      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error('RevenueCat webhook error:', err?.message || err);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

// ---- App Store server notifications ----
// A relay, not a second entitlement pipeline: RevenueCat stays the system of
// record (Apple -> here -> RevenueCat -> /api/revenuecat-webhook). Set
// APPLE_ASN_FORWARD_URL to RevenueCat's Apple notification URL; RevenueCat
// verifies the JWS itself, so the payload is forwarded untouched. Reachable
// at the path on any host and at the bare root of the purchasestatus.
// subdomain.
const handleApplePurchaseNotification = async (req: express.Request, res: express.Response) => {
  const signedPayload = req.body?.signedPayload;
  if (typeof signedPayload !== 'string' || !signedPayload) {
    return res.status(400).json({ error: 'Missing signedPayload' });
  }

  // Unverified peek at the type, for the log line only.
  let notificationType = 'unknown';
  try {
    const claims = JSON.parse(
      Buffer.from(signedPayload.split('.')[1], 'base64url').toString('utf8')
    );
    notificationType = String(claims?.notificationType || 'unknown');
    if (claims?.subtype) notificationType += `/${String(claims.subtype)}`;
  } catch {
    /* opaque payload; still forwarded */
  }

  const forwardUrl = process.env.APPLE_ASN_FORWARD_URL;
  if (!forwardUrl) {
    // Acknowledge so Apple does not mark the endpoint as failing.
    console.warn(
      `App Store notification received (${notificationType}) but APPLE_ASN_FORWARD_URL is not set; acknowledged without forwarding.`
    );
    return res.status(200).json({ received: true, forwarded: false });
  }

  try {
    const upstream = await fetch(forwardUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedPayload }),
    });
    if (!upstream.ok) {
      console.error(
        `App Store notification forward failed: ${upstream.status} (${notificationType})`
      );
      // Non-2xx so Apple retries; a purchase event must not be lost.
      return res.status(502).json({ error: 'Forward failed' });
    }
    console.log(`App Store notification relayed: ${notificationType}`);
    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('App Store notification relay error:', err?.message || err);
    return res.status(502).json({ error: 'Forward failed' });
  }
};

router.post('/api/apple-purchase-notifications', handleApplePurchaseNotification);
router.post('/', (req, res, next) => {
  const host = String(req.headers.host || '')
    .split(':')[0]
    .toLowerCase();
  if (!host.startsWith('purchasestatus.')) return next();
  return handleApplePurchaseNotification(req, res);
});

export default router;
