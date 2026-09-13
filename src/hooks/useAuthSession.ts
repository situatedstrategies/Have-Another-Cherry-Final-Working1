import { useEffect } from 'react';
import { collection, query, deleteDoc, doc, getDocs, where } from 'firebase/firestore';
import {
  onAuthStateChanged,
  deleteUser,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  GoogleAuthProvider,
  OAuthProvider,
  EmailAuthProvider,
} from 'firebase/auth';
import { auth, db, authHeader, forgetKeepSignedIn } from '../firebase';
import { disableWebPush } from '../lib/push';
import { configureBilling, plusEntitlementActive } from '../lib/billing';
import type { Dispatch, SetStateAction } from 'react';
import { Expense, Group } from '../types';

type Setter<T> = Dispatch<SetStateAction<T>>;

export function useAuthSession({
  activeUser,
  setCurrentUser,
  setIsLoading,
  groupIds,
  group,
  removeSelfFromGroupById,
  setUserProfile,
  setGroup,
  setGroupUsers,
  setExpenses,
  setShowSettings,
  setShowPrivacyModal,
  setRcPlus,
}: {
  activeUser: any;
  setCurrentUser: Setter<any>;
  setIsLoading: Setter<boolean>;
  groupIds: string[];
  group: Group | null;
  removeSelfFromGroupById: (gid: string) => Promise<void>;
  setUserProfile: Setter<any>;
  setGroup: Setter<Group | null>;
  setGroupUsers: Setter<Record<string, any>>;
  setExpenses: Setter<Expense[]>;
  setShowSettings: Setter<boolean>;
  setShowPrivacyModal: Setter<boolean>;
  setRcPlus: Setter<boolean>;
}) {
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (!user) {
        setRcPlus(false);
        setIsLoading(false);
      } else {
        // Web billing is keyed to the Firebase uid so a purchase maps to
        // users/{uid}. Once configured, RevenueCat's own answer unlocks the
        // session immediately: a paid customer must never see the paywall
        // on sign-in because a profile write lagged or a webhook was lost.
        setRcPlus(false);
        configureBilling(user.uid)
          .then(() => plusEntitlementActive())
          .then((active) => setRcPlus(active))
          .catch(console.error);
        // Entitlement sync: promo allowlist plus RevenueCat, written by the
        // server; the profile listener picks it up. Silent on failure.
        authHeader()
          .then((h) => fetch('/api/plus-promo-sync', { method: 'POST', headers: h }))
          .catch(() => {});
      }
    });
    return () => unsubscribe();
  }, []);

  const handleSignOut = async () => {
    // Best effort: cleanup must never block signing out.
    const uid = auth.currentUser?.uid;
    if (uid) await disableWebPush(uid).catch(() => {});
    // The next visit asks for login again instead of restoring a session.
    forgetKeepSignedIn();
    // Let the auth listener reset state: clearing userProfile here would
    // flash ProfileSetup for a frame before currentUser clears.
    auth.signOut();
  };

  // Best-effort cleanup during account deletion (the rules allow to == self).
  const deleteMyInboundQueue = async () => {
    if (!activeUser) return;
    try {
      const snap = await getDocs(
        query(collection(db, 'transfer_queue'), where('to', '==', activeUser))
      );
      await Promise.allSettled(snap.docs.map((d) => deleteDoc(d.ref)));
    } catch (e) {
      console.error('Failed to clean up inbound queue', e);
    }
  };

  // Local ledger caches for every group, plus the backup secret.
  const clearLocalData = () => {
    groupIds.forEach((gid) => localStorage.removeItem('expenses_' + gid));
    if (group) localStorage.removeItem('expenses_' + group.id);
    if (activeUser) localStorage.removeItem(`group_secret_${activeUser}`);
  };

  // Firebase requires a recent login before account deletion. Apple needs the
  // popup flow: signing out and back in never satisfies the check.
  const reauthenticate = async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('No signed-in user');
    const providerId = user.providerData[0]?.providerId;
    if (providerId === 'google.com') {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
    } else if (providerId === 'apple.com') {
      const apple = new OAuthProvider('apple.com');
      apple.addScope('email');
      apple.addScope('name');
      await reauthenticateWithPopup(user, apple);
    } else if (providerId === 'password') {
      const pw = window.prompt(
        'For your security, please re-enter your password to permanently delete your account:'
      );
      if (!pw) throw new Error('cancelled');
      const credential = EmailAuthProvider.credential(user.email || '', pw);
      await reauthenticateWithCredential(user, credential);
    } else {
      throw new Error('Please sign out and sign back in, then try deleting your account again.');
    }
  };

  const handleDeleteAccount = async () => {
    if (
      !window.confirm(
        'Permanently delete your account? This removes you from your current group, deletes your app profile, clears local ledger data, and deletes your sign-in account. This action cannot be undone.'
      )
    )
      return;
    try {
      // First, so a cancelled reauthentication cannot leave the account half-deleted.
      await reauthenticate();

      // Firestore cleanup needs auth, so it precedes the auth-account deletion.
      for (const gid of groupIds) {
        try {
          await removeSelfFromGroupById(gid);
        } catch (e) {
          console.error('Failed to leave group during account deletion', gid, e);
        }
      }

      await deleteMyInboundQueue();

      await deleteDoc(doc(db, 'users', activeUser));

      clearLocalData();

      // Last: this revokes the auth the steps above needed.
      await deleteUser(auth.currentUser!);
      setShowSettings(false);
      setShowPrivacyModal(false);
      setUserProfile(null);
      setGroup(null);
      setGroupUsers({});
      setExpenses([]);
    } catch (err: any) {
      if (err?.message === 'cancelled') return;
      console.error('Error deleting account', err);
      alert(
        err?.message ||
          'Failed to delete your account. Please sign out, sign back in, and try again.'
      );
    }
  };

  return { handleSignOut, handleDeleteAccount };
}
