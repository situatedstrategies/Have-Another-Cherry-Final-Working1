import React, { useEffect, useState } from 'react';
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  getAdditionalUserInfo,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db, applyKeepSignedIn } from '../firebase';
import { preloadRecaptcha, verifyRecaptcha } from '../lib/recaptcha';
import { Mail, Lock, User } from 'lucide-react';
import LegalModal, { LegalDoc } from './LegalModal';
import {
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_REQUIREMENTS,
  checkPassword,
  isPasswordValid,
} from '../lib/password';
import CherryLogo from './CherryLogo';

// Eligibility is 13+ (parent or guardian permission under 18) and signup records an age attestation.
const TERMS_VERSION = '2026-09-02';

const NO_ACCOUNT_MESSAGE =
  'We could not find an account for that email. Check the spelling, or create one.';
const OTHER_PROVIDER_MESSAGE = 'This email signs in with Google or Apple. Use that button instead.';
const OFFLINE_MESSAGE = 'Could not reach the server. Check your connection and try again.';

// Firebase folds an unknown address and a wrong password into one error, so a
// failed sign-in asks the server whether the address has an account and which
// sign-in methods it has. Null means the check itself failed.
async function accountLookup(
  email: string
): Promise<{ exists: boolean; providers: string[] } | null> {
  try {
    const res = await fetch('/api/account-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.exists !== 'boolean') return null;
    return {
      exists: data.exists,
      providers: Array.isArray(data.providers)
        ? data.providers.filter((p: unknown) => typeof p === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

const isCredentialMismatch = (code: unknown) =>
  code === 'auth/invalid-credential' ||
  code === 'auth/wrong-password' ||
  code === 'auth/user-not-found';

// Turn Firebase's internal auth error codes into friendly text.
function friendlyAuthError(err: any): string {
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return "That email or password doesn't match. Please try again.";
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/email-already-in-use':
      return 'An account already exists for this email. Try logging in instead.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return PASSWORD_POLICY_MESSAGE;
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled.';
    case 'auth/account-exists-with-different-credential':
      return 'You already have an account with this email using a different sign-in method. Try that one.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/operation-not-allowed':
      return "That sign-in method isn't switched on for this app yet. Please try another way to sign in.";
    case 'auth/network-request-failed':
      return 'Couldn’t reach the sign-in service. Check your connection. VPNs, ad blockers, or strict privacy settings can block it. Then try again.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in window. Allow popups for this site and try again.';
    case 'auth/unauthorized-domain':
      return 'Sign-in isn’t authorized on this domain. Please use the official app link.';
    case 'auth/ui-timeout':
      return 'Sign-in is taking too long. If a Google window opened and closed without signing you in, your browser may be blocking cross-site sign-in. Try email and password, or a different browser.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// Rejects if the auth call neither resolves nor rejects within `ms`, so the UI
// can recover instead of sitting on "Please wait..." forever. If the underlying
// sign-in still completes later, onAuthStateChanged picks it up regardless.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: any = new Error('Sign-in timed out');
      err.code = 'auth/ui-timeout';
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Record proof-of-consent on the user's doc (merge so it doesn't disturb other fields).
async function recordTermsAcceptance(uid: string) {
  try {
    await setDoc(
      doc(db, 'users', uid),
      {
        termsAcceptedAt: new Date().toISOString(),
        termsVersion: TERMS_VERSION,
        // The 13+ attestation made at signup (under 18 requires a parent or
        // guardian's permission, per the Terms).
        ageAttestedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error('Failed to record terms acceptance', e);
  }
}

// Which view to open on. The marketing site sends people here from two very
// different buttons: "Create an account" and "Log in". Landing a would-be
// signup on the login form and making them find a small text link at the bottom
// is where that funnel leaked, so the intent travels in the URL.
//
// Accepts ?signup / ?signup=1 / #signup, and the login equivalents, so the site
// can link either way without this having to know which form it used.
function initialIsLogin(): boolean {
  if (typeof window === 'undefined') return true;
  const { search, hash } = window.location;
  const q = new URLSearchParams(search);
  const wantsSignup = q.has('signup') || q.get('mode') === 'signup' || hash === '#signup';
  const wantsLogin = q.has('login') || q.get('mode') === 'login' || hash === '#login';
  if (wantsSignup) return false;
  if (wantsLogin) return true;
  return true;
}

export default function AuthScreen() {
  const [isLogin, setIsLogin] = useState(initialIsLogin);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  // Separate loading flags so a hung Google popup can never wedge the email
  // form (or vice versa); both buttons still disable during any attempt.
  const [emailLoading, setEmailLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const loading = emailLoading || googleLoading || appleLoading;
  const [agreeTerms, setAgreeTerms] = useState(false);
  // Opt-in to staying signed in across visits. Off by default: without it the
  // session ends with the browser tab and the next visit asks for login again.
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalDoc | null>(null);
  const [isReset, setIsReset] = useState(false);
  const [info, setInfo] = useState('');

  // Load the reCAPTCHA script up front so the badge is visible on the auth
  // screen and the first submit does not pay the script download cost.
  useEffect(() => {
    preloadRecaptcha();
  }, []);

  // Complete a Google sign-in that came back via the redirect flow (mobile).
  // Success swaps this screen out through onAuthStateChanged; this hook only
  // needs to record consent for brand-new accounts and surface failures.
  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => {
        if (result && getAdditionalUserInfo(result)?.isNewUser) {
          return recordTermsAcceptance(result.user.uid);
        }
      })
      .catch((err) => {
        // This check runs on every load, usually with no redirect pending, so a
        // network hiccup here is not worth alarming the user over. Real sign-in
        // attempts report their own network failures.
        if (err?.code !== 'auth/network-request-failed') {
          setError(friendlyAuthError(err));
        }
      });
  }, []);

  // Switch between Log in / Sign up / Reset views, clearing any messages.
  const switchMode = (next: 'login' | 'signup' | 'reset') => {
    setError('');
    setInfo('');
    setIsReset(next === 'reset');
    if (next !== 'reset') setIsLogin(next === 'login');
  };

  // Password policy for new accounts, shared with the reset form in
  // AuthActionHandler so the two cannot drift apart.
  const passwordChecks = checkPassword(password);
  const passwordValid = isPasswordValid(password);

  // One popup/redirect dance shared by every federated provider (Google,
  // Apple), so their behavior can never drift apart.
  const handleProviderAuth = async (
    provider: GoogleAuthProvider | OAuthProvider,
    setBusy: (v: boolean) => void
  ) => {
    // New (sign-up) accounts must accept the terms first - matches the email flow.
    if (!isLogin && !agreeTerms) {
      setError(
        "Please confirm you're at least 13 and agree to the Terms of Service and Privacy Policy to create an account."
      );
      return;
    }
    setError('');
    // Mobile browsers (and home-screen installs) handle popups poorly or not at
    // all; the full-page redirect flow is the reliable path there. The popup
    // stays for desktop, where redirect would lose in-page state unnecessarily.
    const preferRedirect = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    try {
      setBusy(true);
      // Store and apply the "keep me signed in" choice before anything
      // happens, especially before the redirect flow navigates away from the
      // app. Inside the try so a persistence failure (private browsing, a
      // browser that blocks storage) reports instead of wedging the button.
      await applyKeepSignedIn(keepSignedIn);
      if (preferRedirect) {
        // Navigates away from the app; the watchdog only matters if the
        // pre-redirect handshake stalls, so the button can't stick forever.
        await withTimeout(signInWithRedirect(auth, provider), 30_000);
        return;
      }
      // Long timeout: the user may legitimately spend time in the popup. If the
      // popup completes but can never message back (blocked cross-site storage),
      // this unfreezes the UI with an actionable error instead of hanging.
      const result = await withTimeout(signInWithPopup(auth, provider), 90_000);
      // Record consent for brand-new accounts (the provider already verified
      // the email address).
      if (getAdditionalUserInfo(result)?.isNewUser) {
        await recordTermsAcceptance(result.user.uid);
      }
    } catch (err: any) {
      // A blocked or unsupported popup still has a way forward: the redirect flow.
      if (
        err?.code === 'auth/popup-blocked' ||
        err?.code === 'auth/operation-not-supported-in-this-environment'
      ) {
        try {
          await signInWithRedirect(auth, provider);
          return;
        } catch (redirectErr: any) {
          err = redirectErr;
        }
      }
      setError(friendlyAuthError(err));
      setBusy(false);
    }
  };

  const handleGoogleAuth = () => handleProviderAuth(new GoogleAuthProvider(), setGoogleLoading);

  const handleAppleAuth = () => {
    const provider = new OAuthProvider('apple.com');
    // Apple only shares name and email on the very first authorization, and
    // only when asked; Firebase fills displayName from it for new accounts.
    provider.addScope('email');
    provider.addScope('name');
    return handleProviderAuth(provider, setAppleLoading);
  };

  // Request a password reset email. This hits our server endpoint, which mints a
  // Firebase reset link and delivers it via Resend from reset@haveanothercherry.com.
  // An address with no account gets told so; the server answers 404 with the
  // message to show.
  const handleResetPassword = async () => {
    setError('');
    setInfo('');
    if (!email) {
      setError('Enter your email address to reset your password.');
      return;
    }
    setEmailLoading(true);
    try {
      const res = await fetch('/api/send-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to send reset email. Please try again later.');
      }
      setInfo(
        `A password reset link is on its way to ${email}. Check your inbox and your spam folder.`
      );
    } catch (err: any) {
      // A fetch that never reached the server rejects with a TypeError whose
      // message is written for developers ("Failed to fetch").
      setError(
        err instanceof TypeError
          ? OFFLINE_MESSAGE
          : err?.message || 'Unable to send reset email. Please try again later.'
      );
    } finally {
      setEmailLoading(false);
    }
  };

  // Ask the server to mail a confirmation link. Failures are logged and dropped:
  // the account is already created by this point, and the user can be sent
  // another link later. Never surface this as a signup error.
  const sendVerificationEmail = async (user: FirebaseUser, displayName: string) => {
    try {
      const token = await user.getIdToken();
      await fetch('/api/send-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(displayName ? { name: displayName } : {}),
      });
    } catch (err) {
      console.error('Could not send the verification email', err);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isReset) {
      await handleResetPassword();
      return;
    }

    if (!isLogin) {
      if (!passwordValid) {
        // Name the rule that failed rather than the whole policy. The one
        // people hit is the 15-character ceiling: a password manager pastes
        // 20 characters, the checklist quietly shows one unmet item, and the
        // policy sentence reads like the password is fine.
        const missing = PASSWORD_REQUIREMENTS.filter((req) => !passwordChecks[req.key]).map((req) => req.label.toLowerCase());
        setError(
          missing.length === 1
            ? `Your password needs ${missing[0]}.`
            : `Your password still needs: ${missing.join(', ')}.`
        );
        return;
      }
      if (!agreeTerms) {
        setError(
          "Please confirm you're at least 13 and agree to the Terms of Service and Privacy Policy to create an account."
        );
        return;
      }
    }

    setEmailLoading(true);
    try {
      // Firebase App Check already protects the application.
      // Keep the custom reCAPTCHA assessment as telemetry only; it must not
      // prevent legitimate users from reaching Firebase Authentication.
      void verifyRecaptcha(isLogin ? 'LOGIN' : 'SIGNUP');
      await applyKeepSignedIn(keepSignedIn);
      if (isLogin) {
        await withTimeout(signInWithEmailAndPassword(auth, email, password), 30_000);
      } else {
        const userCred = await withTimeout(
          createUserWithEmailAndPassword(auth, email, password),
          30_000
        );
        if (name.trim()) {
          await updateProfile(userCred.user, { displayName: name.trim() });
        }
        await recordTermsAcceptance(userCred.user.uid);

        // Confirm the address for password signups. Google accounts skip this:
        // Google has already verified the address, and Firebase marks them
        // verified on creation, so the endpoint would no-op anyway.
        //
        // Deliberately not awaited into the UI. The auth listener swaps this
        // screen out the moment the account exists, so there is nothing left to
        // show a result on, and a slow or failed email must never be what stops
        // someone getting into the app they just signed up for.
        void sendVerificationEmail(userCred.user, name.trim());
      }
    } catch (err: any) {
      let message = friendlyAuthError(err);
      if (isLogin && isCredentialMismatch(err?.code)) {
        const account = await accountLookup(email);
        if (account && !account.exists) {
          message = NO_ACCOUNT_MESSAGE;
        } else if (account && account.exists && !account.providers.includes('password')) {
          // The address is real but was created through Google or Apple, so
          // there is no password to match: "doesn't match" would send them
          // off to reset a password they never had.
          message = OTHER_PROVIDER_MESSAGE;
        }
      }
      setError(message);
      setEmailLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-natural-sidebar flex flex-col font-sans">
      <nav className="w-full flex items-center justify-between px-6 py-4">
        <a href="https://haveanothercherry.com" className="flex items-center gap-2">
          <CherryLogo className="h-6 w-6" />
          <span className="font-display font-semibold text-natural-text tracking-tight">
            Have Another Cherry
          </span>
        </a>
        <a
          href="https://haveanothercherry.com/blog"
          className="text-sm font-medium text-natural-muted hover:text-natural-text transition-colors"
        >
          Blog
        </a>
      </nav>

      <div className="flex-1 flex items-center justify-center p-4">
        <div
          className={`bg-white rounded-lg shadow-sm border border-natural-border w-full overflow-hidden relative ${isReset ? 'max-w-sm' : 'max-w-sm sm:max-w-3xl'}`}
        >
          <div className="p-8">
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center mb-4">
                <CherryLogo className="h-10 w-10" />
              </div>
              <h1 className="text-2xl sm:text-3xl font-semibold font-display text-natural-text mb-1 tracking-tight">
                Have Another Cherry
              </h1>
            </div>

            {/* Wide and short rather than narrow and tall: on anything larger
              than a phone the email form sits in the left column and the
              Apple and Google buttons in the right, with the divider standing
              between them. On a phone it stacks as before. */}
            <div
              className={
                isReset ? '' : 'sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-8 sm:items-start'
              }
            >
              <div>
                {/* Both ways in, side by side, in the same shape the marketing site
              uses. The old version put "Sign up" in a small text link below the
              fold of a phone screen, so arriving from a "Create an account"
              button meant hunting for the form you had already asked for. */}
                {isReset ? (
                  <div className="text-center mb-6">
                    <h2 className="text-sm font-medium text-natural-muted">Reset your password</h2>
                  </div>
                ) : (
                  <div
                    className="grid grid-cols-2 gap-1 p-1 mb-6 bg-natural-sidebar border border-natural-border rounded-full"
                    role="tablist"
                  >
                    {(
                      [
                        ['login', 'Log in'],
                        ['signup', 'Sign up'],
                      ] as const
                    ).map(([mode, label]) => {
                      const active = isLogin === (mode === 'login');
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => switchMode(mode)}
                          className={`min-h-11 px-3 rounded-full font-mono text-xs transition-all cursor-pointer ${
                            active
                              ? 'bg-white text-natural-text font-medium shadow-sm'
                              : 'text-natural-muted hover:text-natural-text'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {error && (
                  <div className="bg-natural-primary/5 text-natural-primary p-3 rounded-md mb-6 text-sm font-medium border border-natural-primary/15 flex items-start gap-2">
                    <span className="shrink-0">⚠️</span>
                    <span>{error}</span>
                  </div>
                )}

                {info && (
                  <div className="bg-natural-sidebar text-natural-text p-3 rounded-md mb-6 text-sm font-medium border border-natural-border flex items-start gap-2">
                    <span className="shrink-0">✅</span>
                    <span>{info}</span>
                  </div>
                )}

                <form onSubmit={handleEmailAuth} className="space-y-4 mb-6 sm:mb-0">
                  {isReset && (
                    <p className="text-sm text-natural-muted -mt-1">
                      Enter the email address for your account and we'll send you a link to create a
                      new password.
                    </p>
                  )}

                  {!isLogin && !isReset && (
                    <div>
                      <label className="block text-xs font-semibold text-natural-text uppercase tracking-wide mb-1.5">
                        Name
                      </label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 text-natural-accent h-4 w-4" />
                        <input
                          type="text"
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 bg-white border border-natural-border focus:border-natural-muted focus:ring-1 focus:ring-natural-muted rounded-md text-natural-text placeholder-natural-accent font-sans text-sm outline-none transition-all"
                          placeholder="Name"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-semibold text-natural-text uppercase tracking-wide mb-1.5">
                      Email
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-natural-accent h-4 w-4" />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-white border border-natural-border focus:border-natural-muted focus:ring-1 focus:ring-natural-muted rounded-md text-natural-text placeholder-natural-accent font-sans text-sm outline-none transition-all"
                        placeholder="you@example.com"
                      />
                    </div>
                  </div>

                  {!isReset && (
                    <div>
                      <label className="block text-xs font-semibold text-natural-text uppercase tracking-wide mb-1.5">
                        Password
                      </label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-natural-accent h-4 w-4" />
                        <input
                          type="password"
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 bg-white border border-natural-border focus:border-natural-muted focus:ring-1 focus:ring-natural-muted rounded-md text-natural-text placeholder-natural-accent font-sans text-sm outline-none transition-all"
                          placeholder="••••••••"
                          minLength={isLogin ? undefined : 8}
                        />
                      </div>
                      {!isLogin && (
                        <div className="mt-2">
                          <p className="text-xs font-semibold text-natural-text mb-1">
                            Create a password with:
                          </p>
                          <ul className="space-y-1">
                            {PASSWORD_REQUIREMENTS.map((req) => (
                              <li
                                key={req.key}
                                className={`flex items-center gap-1.5 text-xs ${
                                  passwordChecks[req.key]
                                    ? 'text-natural-text'
                                    : error
                                      ? 'text-natural-primary font-semibold'
                                      : 'text-natural-muted'
                                }`}
                              >
                                <span>{passwordChecks[req.key] ? '✓' : '○'}</span> {req.label}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {isLogin && (
                        <div className="text-right mt-1.5">
                          <button
                            type="button"
                            onClick={() => switchMode('reset')}
                            className="text-xs font-medium text-natural-primary hover:underline"
                          >
                            Forgot password?
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {!isLogin && !isReset && (
                    <label className="flex items-start gap-2 text-xs text-natural-muted cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={agreeTerms}
                        onChange={(e) => setAgreeTerms(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-natural-border text-natural-primary focus:ring-natural-primary"
                      />
                      <span>
                        I'm at least 13 years old (13 to 17 with a parent or guardian's permission),
                        and I agree to the{' '}
                        <button
                          type="button"
                          onClick={() => setLegalDoc('terms')}
                          className="font-semibold text-natural-primary hover:underline"
                        >
                          Terms of Service
                        </button>{' '}
                        and{' '}
                        <button
                          type="button"
                          onClick={() => setLegalDoc('privacy')}
                          className="font-semibold text-natural-primary hover:underline"
                        >
                          Privacy Policy
                        </button>
                        .
                      </span>
                    </label>
                  )}

                  {!isReset && (
                    /* Applies to whichever way they sign in, email below or Google
                 further down: the handlers both read this one checkbox. */
                    <label className="flex items-start gap-2 text-xs text-natural-muted cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={keepSignedIn}
                        onChange={(e) => setKeepSignedIn(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-natural-border text-natural-primary focus:ring-natural-primary"
                      />
                      <span>
                        <span className="font-semibold text-natural-text">
                          Keep me signed in on this device.
                        </span>{' '}
                        Skip the login screen next time. Signing out in Settings turns this back
                        off.
                      </span>
                    </label>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-natural-primary text-white font-medium py-2 px-4 rounded-md hover:bg-natural-primary/90 transition-colors shadow-sm disabled:opacity-70 disabled:cursor-not-allowed mt-2"
                  >
                    {emailLoading
                      ? 'Please wait...'
                      : isReset
                        ? 'Send reset link'
                        : isLogin
                          ? 'Log In'
                          : 'Sign Up'}
                  </button>
                </form>
              </div>

              {!isReset && (
                <>
                  <div className="relative mb-6 sm:mb-0 sm:h-full sm:min-h-[16rem] sm:w-px sm:flex sm:justify-center">
                    <div className="absolute inset-0 flex items-center sm:items-stretch sm:justify-center">
                      <div className="w-full border-t border-natural-border sm:w-px sm:border-t-0 sm:border-l"></div>
                    </div>
                    <div className="relative flex justify-center text-xs sm:items-center sm:h-full">
                      <span className="px-2 bg-white text-natural-muted sm:py-2">or</span>
                    </div>
                  </div>

                  <div className="sm:pt-1">
                    <button
                      onClick={handleAppleAuth}
                      type="button"
                      disabled={loading}
                      className="w-full bg-black text-white font-medium py-2 px-4 rounded-md hover:bg-black/85 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-70 disabled:cursor-not-allowed text-sm mb-3"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 384 512" aria-hidden="true">
                        <path
                          fill="currentColor"
                          d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
                        />
                      </svg>
                      {appleLoading ? 'Waiting for Apple...' : 'Continue with Apple'}
                    </button>

                    <button
                      onClick={handleGoogleAuth}
                      type="button"
                      disabled={loading}
                      className="w-full bg-white border border-natural-border text-natural-text font-medium py-2 px-4 rounded-md hover:bg-natural-sidebar transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-70 disabled:cursor-not-allowed text-sm"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24">
                        <path
                          fill="currentColor"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="currentColor"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="currentColor"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="currentColor"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                      {googleLoading ? 'Waiting for Google...' : 'Continue with Google'}
                    </button>
                  </div>
                </>
              )}
            </div>

            {isReset ? (
              <p className="text-center text-sm text-natural-muted mt-6">
                Remembered your password?{' '}
                <button
                  onClick={() => switchMode('login')}
                  className="text-natural-text hover:underline font-medium transition-colors"
                >
                  Back to log in
                </button>
              </p>
            ) : (
              !isLogin && (
                /* The same promise the marketing site makes at the moment of the
               click, repeated where the hesitation actually lands. */
                <p className="text-center font-mono text-xs leading-relaxed text-natural-accent mt-6">
                  Everything you need is free. No credit card required.
                </p>
              )
            )}
          </div>
        </div>
      </div>

      {legalDoc && <LegalModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}
    </div>
  );
}
