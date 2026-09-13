import { useState, useEffect, useCallback } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db, authHeader } from './firebase';
import { getFullMembers } from './lib/members';
import { isDarkCherry } from './lib/money';
import { hasPlus } from './lib/entitlements';
import { computeIncomeDiscrepancy } from './lib/incomeDiscrepancy';
import { SupportError } from './lib/errors';
import { Expense, Group } from './types';
import { useGroupMembership } from './hooks/useGroupMembership';
import { useAuthSession } from './hooks/useAuthSession';
import { useProfileSettings } from './hooks/useProfileSettings';
import { useLedgerSync } from './hooks/useLedgerSync';
import { useNotifications } from './hooks/useNotifications';
import { useExpenseMutations } from './hooks/useExpenseMutations';
import { useSettlements } from './hooks/useSettlements';
import ErrorSupportModal from './components/ErrorSupportModal';
import CherryLogo from './components/CherryLogo';
import ModuleBoundary from './components/ModuleBoundary';
import LoadingScreen from './components/LoadingScreen';
import BudgetPaymentsSettings from './components/BudgetPaymentsSettings';
import StatsSection from './components/StatsSection';
import ExpenseForm from './components/ExpenseForm';
import ExpenseDetail from './components/ExpenseDetail';
import SettleUpModal from './components/SettleUpModal';
import ExpenseList from './components/ExpenseList';
import AuthScreen from './components/AuthScreen';
import ProfileSetup from './components/ProfileSetup';
import BackupModal from './components/BackupModal';
import MonthlyComparisonChart from './components/MonthlyComparisonChart';
import GroupSetup from './components/GroupSetup';
import LegalModal, { LegalDoc } from './components/LegalModal';
import SettingsModal from './components/SettingsModal';
import PrivacyModal from './components/PrivacyModal';
import FinancialAlignmentModal from './components/FinancialAlignmentModal';
import PlanPurchase from './components/PlanPurchase';
import HouseholdVault from './components/HouseholdVault';
import RhythmCard from './components/RhythmCard';
import CherryPlusModal from './components/CherryPlusModal';
import OwedBreakdownModal from './components/OwedBreakdownModal';
import { ToastContainer, ToastMessage } from './components/Toast';
import {
  Plus,
  Sparkles,
  Settings,
  X,
  AlertCircle,
  Check,
  ChevronDown,
  TrendingUp,
  Vault as VaultIcon,
} from 'lucide-react';

export default function App() {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const activeUser = currentUser?.uid;
  const [userProfile, setUserProfile] = useState<any>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [groupUsers, setGroupUsers] = useState<Record<string, any>>({});

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [groupSecret, setGroupSecret] = useState('');
  useEffect(() => {
    if (activeUser) {
      setGroupSecret(localStorage.getItem(`group_secret_${activeUser}`) || '');
    }
  }, [activeUser]);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showAlignmentModal, setShowAlignmentModal] = useState(false);
  const [showPlanPurchase, setShowPlanPurchase] = useState(false);
  const [showVault, setShowVault] = useState(false);
  const [showCherryPlus, setShowCherryPlus] = useState(false);
  // The one error dialog, set from any failure point.
  const [supportError, setSupportError] = useState<SupportError | null>(null);
  const [owedModal, setOwedModal] = useState<null | 'you_owe' | 'owed_to_you'>(null);
  const [dismissedWaiting, setDismissedWaiting] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalDoc | null>(null);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [showSettleModal, setShowSettleModal] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // Stable identities so Toast's auto-dismiss timer is not reset on every render.
  const addToast = useCallback(
    (title: string, message: string, type: 'info' | 'success' | 'error' = 'info') => {
      setToasts((prev) => [
        ...prev,
        { id: Date.now().toString() + Math.random().toString(), title, message, type },
      ]);
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const {
    activeGroupId,
    groupIds,
    groupSummaries,
    memberIdsKey,
    applyJoinedGroup,
    removeSelfFromGroupById,
    handleSwitchGroup,
    handleLeaveGroup,
    handleAddSeat,
    handleRemoveSeat,
    handleRecalculateSplit,
    handleResendInvite,
  } = useGroupMembership({
    currentUser,
    activeUser,
    userProfile,
    setUserProfile,
    group,
    setGroup,
    setGroupUsers,
    groupUsers,
    setExpenses,
    setSelectedExpense,
    setEditingExpense,
    setShowAddGroup,
    setShowSettings,
    setShowGroupMenu,
    setShowPrivacyModal,
    setDismissedWaiting,
    addToast,
    setSupportError,
  });

  // RevenueCat's live answer for this user, read at sign-in (useAuthSession)
  // and set after a purchase. ORed with the profile flag below so a paid
  // customer is unlocked even before users/{uid}.isPlus catches up.
  const [rcPlus, setRcPlus] = useState(false);

  const { handleSignOut, handleDeleteAccount } = useAuthSession({
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
  });

  const {
    thresholdInput,
    setThresholdInput,
    venmoInput,
    setVenmoInput,
    zelleInput,
    setZelleInput,
    savingThreshold,
    savingHandles,
    paymentHandlesByUid,
    handleExportData,
    handleSaveName,
    handleSaveMarketingOptIn,
    handleSaveThreshold,
    handleSavePaymentHandles,
    handleRetakeQuiz,
  } = useProfileSettings({
    currentUser,
    activeUser,
    userProfile,
    setUserProfile,
    setIsLoading,
    group,
    groupUsers,
    expenses,
    addToast,
    setSupportError,
  });

  useLedgerSync({ activeUser, group, memberIdsKey, expenses, setExpenses, addToast });

  const { broadcastToMembers, notifyLedgerEvent, handleGentleRemind } = useNotifications({
    currentUser,
    activeUser,
    group,
    addToast,
  });

  const {
    handleAddComment,
    handleAddOrEditExpense,
    handleClaimExpense,
    handleDeleteExpense,
    syncExpenseUpdate,
  } = useExpenseMutations({
    activeUser,
    group,
    expenses,
    setExpenses,
    editingExpense,
    setEditingExpense,
    setShowForm,
    setSelectedExpense,
    broadcastToMembers,
    notifyLedgerEvent,
    addToast,
    setSupportError,
  });

  const { handleSettleUpProposal, handleConfirmSettleReceipt, handleVoidSettlement } =
    useSettlements({
      activeUser,
      group,
      expenses,
      selectedExpense,
      setShowSettleModal,
      syncExpenseUpdate,
      notifyLedgerEvent,
      addToast,
      setSupportError,
    });

  // Keep the selected expense current as background data changes.
  useEffect(() => {
    if (selectedExpense) {
      const updated = expenses.find((e) => e.id === selectedExpense.id);
      if (updated) {
        setSelectedExpense(updated);
      }
    }
  }, [expenses]);

  if (!currentUser) {
    return <AuthScreen />;
  }

  if (isLoading) {
    return <LoadingScreen label="Loading your ledger..." />;
  }

  if (userProfile && !userProfile.financialProfile) {
    return (
      <div className="animate-in fade-in duration-300">
        <ProfileSetup
          userId={activeUser}
          onComplete={() => {
            getDoc(doc(db, 'users', activeUser))
              .then((userDoc) => {
                if (userDoc.exists()) setUserProfile(userDoc.data() as any);
              })
              .catch((e) => console.error('Failed to reload profile', e));
          }}
        />
      </div>
    );
  }

  if (!activeGroupId) {
    return (
      <div className="animate-in fade-in duration-300">
        <GroupSetup onComplete={applyJoinedGroup} />
      </div>
    );
  }

  // Group data not here yet: a loading screen, never the create/join screen.
  if (!group) {
    return <LoadingScreen label="Loading your group..." />;
  }

  // Members who have not finished their quiz. Non-blocking: a dismissible banner.
  const missingProfiles = (group.memberIds || []).filter(
    (id) => id !== activeUser && groupUsers[id] && !groupUsers[id]?.financialProfile
  );

  // Dark Cherry amounts are hidden from everyone but their creator, so a
  // group total that included one would let members back the number out.
  const statsVisibleExpenses = expenses.filter((e) => !isDarkCherry(e) || e.paidBy === activeUser);

  // Gates vault, thresholds, rhythm, insights and Dark Cherry creation.
  const isPlus = hasPlus(userProfile) || rcPlus;

  // Each member's spending limit, and this user's shares that exceed their own.
  const memberThresholds: Record<string, number> = {};
  Object.entries(groupUsers).forEach(([uid, u]: any) => {
    memberThresholds[uid] = Number(u?.recurringThreshold) || 0;
  });
  const myThreshold = Number(userProfile?.recurringThreshold) || 0;
  const overThresholdExpenses =
    myThreshold > 0
      ? expenses.filter(
          (e) =>
            e.paidBy !== activeUser &&
            (e.shares?.[activeUser] || 0) > myThreshold &&
            !isDarkCherry(e)
        )
      : [];

  const { hasIncomeDiscrepancy, incomeDiscrepancyPct } = computeIncomeDiscrepancy(groupUsers);

  // Payments waiting for this user to confirm receipt.
  const pendingToConfirm = expenses.filter((e) =>
    (e.settlements || []).some((s) => s.status === 'pending' && s.receivedBy === activeUser)
  );
  const pendingConfirmCount = pendingToConfirm.reduce(
    (n, e) =>
      n +
      (e.settlements || []).filter((s) => s.status === 'pending' && s.receivedBy === activeUser)
        .length,
    0
  );

  return (
    <div
      className="min-h-screen bg-natural-bg text-natural-text font-sans antialiased pb-12 animate-in fade-in duration-300"
      style={{
        background:
          'radial-gradient(60% 40% at 78% 0%, rgba(196,18,0,.05), transparent 60%), #F4F4F5',
        backgroundRepeat: 'no-repeat',
      }}
      id="app-root"
    >
      <ToastContainer toasts={toasts} removeToast={removeToast} />
      <div className="h-px bg-natural-sidebar w-full" />

      <main className="max-w-6xl lg:max-w-7xl 2xl:max-w-[100rem] mx-auto px-4 sm:px-8 pt-6 sm:pt-10">
        {hasIncomeDiscrepancy && (
          <div className="mb-6 bg-natural-sidebar border-l-4 border-natural-primary p-4 rounded-r-xl shadow-sm animate-in fade-in slide-in-from-top-2">
            <div className="flex gap-3 items-start">
              <Sparkles className="h-5 w-5 text-natural-primary shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-natural-text">
                  Conversation Starter: Financial Alignment
                </h3>
                <p className="text-sm text-natural-muted mt-1">
                  It looks like there's a discrepancy between what you reported as your income and
                  what someone else in the group estimated (or vice versa). Money conversations can
                  be tough, but clarity is the first step to fairness.
                </p>
                <button
                  onClick={() => setShowAlignmentModal(true)}
                  className="mt-2 text-xs font-medium text-natural-primary cursor-pointer hover:underline"
                >
                  Review Financial Profiles
                </button>
              </div>
            </div>
          </div>
        )}

        <header
          className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8"
          id="app-header"
        >
          <div className="flex items-center gap-3 sm:gap-4 relative">
            <div className="shrink-0 p-1 bg-white border border-natural-border rounded-2xl shadow-sm hover:scale-105 transition-transform duration-300">
              <CherryLogo className="h-9 w-9 sm:h-14 sm:w-14" />
            </div>
            <h1 className="text-xl sm:text-4xl font-display font-semibold tracking-tight text-natural-text leading-tight">
              Have Another Cherry
            </h1>
          </div>

          {/* Three equal columns on phones; natural size in a row from sm up. */}
          <div
            className="grid grid-cols-3 gap-2 w-full sm:flex sm:w-auto sm:items-center sm:gap-3"
            id="header-controls"
          >
            <button
              onClick={() => (isPlus ? setShowVault(true) : setShowCherryPlus(true))}
              className="min-w-0 w-full sm:w-auto bg-white border border-natural-border text-natural-text hover:border-natural-primary hover:text-natural-primary font-semibold text-xs sm:text-xs px-2.5 sm:px-4 py-2.5 rounded-full shadow-sm flex items-center justify-center gap-1.5 whitespace-nowrap transition-all cursor-pointer"
              title="Household Vault"
            >
              <VaultIcon className="h-4 w-4 shrink-0" /> Vault
              {!isPlus && (
                <span className="hidden sm:inline text-[10px] font-bold tracking-wider text-white bg-natural-dark px-1 py-0.5 rounded">
                  Cherry +
                </span>
              )}
            </button>
            <button
              onClick={() => setShowPlanPurchase(true)}
              className="min-w-0 w-full sm:w-auto bg-white border border-natural-primary/30 text-natural-primary hover:bg-natural-sage/40 font-semibold text-xs sm:text-xs px-2.5 sm:px-4 py-2.5 rounded-full shadow-sm flex items-center justify-center gap-1.5 whitespace-nowrap transition-all cursor-pointer"
              title="Plan a shared purchase"
            >
              <TrendingUp className="h-4 w-4 shrink-0" />
              <span className="sm:hidden">Plan</span>
              <span className="hidden sm:inline">Plan a Purchase</span>
            </button>
            <button
              onClick={() => {
                setEditingExpense(null);
                setShowForm(true);
              }}
              className="min-w-0 w-full sm:w-auto bg-natural-primary hover:bg-natural-primary-ink text-white font-semibold text-xs sm:text-xs px-2.5 sm:px-5 py-2.5 rounded-full shadow-md hover:shadow-lg flex items-center justify-center gap-1.5 whitespace-nowrap transition-all cursor-pointer"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="sm:hidden">Log</span>
              <span className="hidden sm:inline">Log Expense</span>
            </button>
          </div>
        </header>

        <div className="space-y-6" id="dashboard-content">
          <div
            className="bg-white border border-natural-border rounded-xl p-4 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
            id="welcome-banner"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 bg-natural-sage text-natural-primary rounded-xl">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-natural-text">
                  Welcome back,{' '}
                  <span className="capitalize">
                    {userProfile?.name || currentUser?.displayName || 'Friend'}
                  </span>
                  !
                </h3>
                {userProfile?.weeklyGreeting?.text && (
                  <p className="text-xs text-natural-primary font-medium mt-1 italic leading-snug max-w-md">
                    {userProfile.weeklyGreeting.text}
                  </p>
                )}
                <div className="relative mt-0.5">
                  <button
                    onClick={() => setShowGroupMenu((v) => !v)}
                    className="text-xs text-natural-muted hover:text-natural-primary flex items-center gap-1 transition-colors"
                    title="Switch group"
                  >
                    Group:{' '}
                    <strong className="text-natural-text">{group.name || 'Unnamed Group'}</strong>
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${showGroupMenu ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {showGroupMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowGroupMenu(false)} />
                      <div className="absolute left-0 mt-1 z-20 w-64 bg-white border border-natural-border rounded-xl shadow-lg py-1 animate-in fade-in slide-in-from-top-1">
                        <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-natural-muted">
                          Your Groups
                        </p>
                        {groupIds.map((gid) => {
                          const isActive = gid === activeGroupId;
                          const name =
                            gid === group.id
                              ? group.name || 'Unnamed Group'
                              : groupSummaries[gid]?.name || 'Unnamed Group';
                          return (
                            <button
                              key={gid}
                              onClick={() => handleSwitchGroup(gid)}
                              disabled={isActive}
                              className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 transition-colors ${isActive ? 'font-bold text-natural-primary bg-natural-sage/20 cursor-default' : 'text-natural-text hover:bg-natural-bg'}`}
                            >
                              <span className="truncate">{name}</span>
                              {isActive && (
                                <Check size={14} className="text-natural-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                        <div className="border-t border-natural-border my-1" />
                        <button
                          onClick={() => {
                            setShowGroupMenu(false);
                            setShowAddGroup(true);
                          }}
                          className="w-full text-left px-3 py-2 text-xs font-semibold text-natural-primary hover:bg-natural-bg flex items-center gap-1.5 transition-colors"
                        >
                          <Plus size={14} /> Join or create another group
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setShowSettings(true)}
                className="text-natural-muted hover:text-natural-primary flex items-center gap-1.5 transition-colors bg-white px-3 py-1.5 border border-natural-border rounded-md shadow-sm"
                title="Account Settings"
              >
                <Settings size={14} />
                <span className="text-xs font-semibold uppercase tracking-widest">Settings</span>
              </button>
            </div>
          </div>

          {pendingConfirmCount > 0 && (
            <div className="bg-natural-primary/5 border border-natural-primary/30 rounded-xl p-4 shadow-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
              <div className="relative shrink-0 mt-0.5">
                <AlertCircle className="h-5 w-5 text-natural-primary" />
                <span className="absolute -top-1.5 -right-1.5 bg-natural-primary text-white text-xs font-bold rounded-full h-4 min-w-4 px-1 flex items-center justify-center">
                  {pendingConfirmCount}
                </span>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-bold text-natural-text">
                  {pendingConfirmCount === 1
                    ? 'A payment needs your confirmation'
                    : `${pendingConfirmCount} payments need your confirmation`}
                </h3>
                <p className="text-xs text-natural-muted mt-1">
                  Someone logged a payment to you. Confirm receipt so it clears and updates their
                  balance.
                </p>
              </div>
              <button
                onClick={() => setSelectedExpense(pendingToConfirm[0])}
                className="shrink-0 bg-natural-primary hover:bg-natural-primary-ink text-white font-semibold text-xs px-4 py-2 rounded-full shadow-sm transition-colors"
              >
                Review
              </button>
            </div>
          )}

          {overThresholdExpenses.length > 0 && (
            <div className="bg-natural-primary/5 border border-natural-primary/25 rounded-xl p-4 shadow-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
              <AlertCircle className="h-5 w-5 text-natural-primary shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-bold text-natural-text">
                  {overThresholdExpenses.length === 1
                    ? 'A shared expense is over your threshold'
                    : `${overThresholdExpenses.length} shared expenses are over your threshold`}
                </h3>
                <p className="text-xs text-natural-muted mt-1">
                  Your share{' '}
                  {overThresholdExpenses.length === 1 ? 'here exceeds' : 'on these exceeds'} your
                  spending threshold of ${myThreshold.toFixed(0)}. Worth a look, and a conversation
                  if the timing's tight.
                </p>
              </div>
              <button
                onClick={() => setSelectedExpense(overThresholdExpenses[0])}
                className="shrink-0 bg-natural-primary hover:bg-natural-primary-ink text-white font-semibold text-xs px-4 py-2 rounded-full shadow-sm transition-colors"
              >
                Review
              </button>
            </div>
          )}

          {missingProfiles.length > 0 && !dismissedWaiting && (
            <div className="bg-natural-primary/5 border border-natural-primary/25 rounded-xl p-4 shadow-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
              <Sparkles className="h-5 w-5 text-natural-primary shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-bold text-natural-text">
                  Some members are still setting up
                </h3>
                <p className="text-xs text-natural-muted mt-1">
                  You can start logging and settling expenses right away. Income-based splits and
                  financial insights will get more accurate once everyone finishes their profile
                  quiz.
                </p>
                <div className="mt-2 space-y-0.5">
                  {missingProfiles.map((id) => (
                    <div key={id} className="text-xs font-medium text-natural-primary">
                      {groupUsers[id]?.name || 'Someone'} hasn't completed setup yet.
                    </div>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setDismissedWaiting(true)}
                className="text-natural-primary hover:text-natural-dark bg-white/60 p-1 rounded-full border border-natural-primary/25 shrink-0"
                title="Dismiss"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Balances are a sticky right rail on large screens and a band above the ledger on phones. */}
          <div className="flex flex-col lg:flex-row lg:items-start gap-6">
            <div className="flex-1 min-w-0 space-y-6 order-2 lg:order-1">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-natural-muted uppercase tracking-widest">
                    Shared Ledger
                  </h3>
                </div>
                <ModuleBoundary label="Shared Ledger">
                  <ExpenseList
                    expenses={expenses}
                    group={group}
                    activeUser={activeUser}
                    onExpenseClick={(exp) => setSelectedExpense(exp)}
                  />
                </ModuleBoundary>
              </div>
              {/* Gated: month-over-month is on the paywall as "Insights and monthly trends". */}
              {isPlus && (
                <ModuleBoundary label="Monthly trends">
                  <MonthlyComparisonChart
                    expenses={statsVisibleExpenses}
                    members={getFullMembers(group)}
                  />
                </ModuleBoundary>
              )}
            </div>

            <div className="order-1 lg:order-2 lg:w-80 xl:w-96 shrink-0 lg:sticky lg:top-6 space-y-6">
              {/* Balances are the free splitter itself, never gated. */}
              <ModuleBoundary label="Balances">
                <StatsSection
                  expenses={statsVisibleExpenses}
                  group={group}
                  activeUser={activeUser}
                  orientation="rail"
                  onCardClick={(card) => setOwedModal(card)}
                />
              </ModuleBoundary>
              {!isPlus && (
                <button
                  type="button"
                  onClick={() => setShowCherryPlus(true)}
                  className="w-full text-left bg-white border border-natural-border rounded-2xl p-5 shadow-sm hover:border-natural-primary/40 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-natural-muted">
                      Insights
                    </span>
                    <span className="text-[10px] font-bold tracking-wider text-white bg-natural-dark px-1 py-0.5 rounded">
                      Cherry +
                    </span>
                  </div>
                  <p className="mt-2 font-display text-lg font-semibold text-natural-text">
                    See where the money actually goes
                  </p>
                  <p className="mt-1 text-sm text-natural-muted">
                    How it was paid, who is carrying the card, and how long things take to come
                    back. Arriving with the iOS and Android apps.
                  </p>
                  <span className="mt-3 inline-block text-sm font-semibold text-natural-primary">
                    Join the waitlist
                  </span>
                </button>
              )}
              <ModuleBoundary label="Rhythm">
                <RhythmCard
                  expenses={expenses}
                  locked={!isPlus}
                  onUnlock={() => setShowCherryPlus(true)}
                />
              </ModuleBoundary>
            </div>
          </div>
        </div>

        <footer
          className="text-center text-xs text-natural-muted mt-12 pb-6 scroll-end-safe space-y-1"
          id="app-footer"
        >
          <p>Have Another Cherry • Shared Home Ledger</p>
          <p className="font-mono">Real-time Cloud Sync Active</p>
        </footer>
      </main>

      {showAddGroup && (
        <div className="fixed inset-0 z-50 overflow-auto animate-in fade-in duration-200">
          <GroupSetup onComplete={applyJoinedGroup} onCancel={() => setShowAddGroup(false)} />
        </div>
      )}
      {showBackup && isPlus && (
        <BackupModal
          onClose={() => setShowBackup(false)}
          activeUser={activeUser}
          groupId={group.id}
          groupKeyHash={group.keyHash}
          localExpenses={expenses}
          setLocalExpenses={setExpenses}
          groupSecret={groupSecret}
          setGroupSecret={setGroupSecret}
        />
      )}
      {showSettings && group && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          userProfile={userProfile}
          currentUser={currentUser}
          group={group}
          groupUsers={groupUsers}
          onSaveName={handleSaveName}
          onSaveMarketingOptIn={handleSaveMarketingOptIn}
          onRetakeQuiz={handleRetakeQuiz}
          onRecalculateSplit={handleRecalculateSplit}
          onResendInvite={handleResendInvite}
          onAddSeat={handleAddSeat}
          onRemoveSeat={handleRemoveSeat}
          onLeaveGroup={handleLeaveGroup}
          onOpenBackup={() => {
            // Backups and export are Cherry +; free users get the upgrade page.
            setShowSettings(false);
            if (isPlus) {
              setShowBackup(true);
            } else {
              setShowCherryPlus(true);
            }
          }}
          onOpenPrivacy={() => setShowPrivacyModal(true)}
          onSignOut={() => {
            setShowSettings(false);
            handleSignOut();
          }}
          extraSection={
            <BudgetPaymentsSettings
              isPlus={isPlus}
              setShowSettings={setShowSettings}
              setShowCherryPlus={setShowCherryPlus}
              thresholdInput={thresholdInput}
              setThresholdInput={setThresholdInput}
              savingThreshold={savingThreshold}
              handleSaveThreshold={handleSaveThreshold}
              venmoInput={venmoInput}
              setVenmoInput={setVenmoInput}
              zelleInput={zelleInput}
              setZelleInput={setZelleInput}
              savingHandles={savingHandles}
              handleSavePaymentHandles={handleSavePaymentHandles}
            />
          }
        />
      )}

      {showPrivacyModal && (
        <PrivacyModal
          onClose={() => setShowPrivacyModal(false)}
          onOpenLegal={(d) => setLegalDoc(d)}
          onExportData={handleExportData}
          onDeleteAccount={handleDeleteAccount}
        />
      )}

      {owedModal && (
        <OwedBreakdownModal
          mode={owedModal}
          expenses={statsVisibleExpenses}
          group={group}
          activeUser={activeUser}
          isPlus={isPlus}
          onSelectExpense={(exp) => setSelectedExpense(exp)}
          onCherryPlus={() => setShowCherryPlus(true)}
          onToast={addToast}
          onClose={() => setOwedModal(null)}
        />
      )}

      {showCherryPlus && (
        <CherryPlusModal
          onClose={() => setShowCherryPlus(false)}
          customerEmail={currentUser?.email || userProfile?.email}
          onPurchased={() => {
            // Unlock now. The durable copy on users/{uid} is written by the
            // webhook and, independently, by the entitlement sync asked for
            // here, so the purchase survives sign-out even if the webhook
            // never lands.
            setRcPlus(true);
            setUserProfile((prev: any) => ({
              ...(prev || {}),
              isPlus: true,
              plusEntitlement: {
                source: 'revenuecat_web',
                updatedAt: new Date().toISOString(),
              },
            }));
            authHeader()
              .then((h) => fetch('/api/plus-promo-sync', { method: 'POST', headers: h }))
              .catch(() => {});
          }}
        />
      )}

      {supportError && (
        <ErrorSupportModal
          error={supportError.error}
          screen={supportError.screen}
          detail={supportError.detail}
          onClose={() => setSupportError(null)}
        />
      )}

      {showPlanPurchase && (
        <PlanPurchase
          group={group}
          activeUser={activeUser}
          groupUsers={groupUsers}
          expenses={expenses}
          onClose={() => setShowPlanPurchase(false)}
        />
      )}

      {showVault && isPlus && (
        <HouseholdVault
          groupId={group.id}
          activeUser={activeUser}
          expenses={expenses}
          memberNames={Object.fromEntries(getFullMembers(group).map((m) => [m.uid, m.name]))}
          categories={group.categories}
          onClose={() => setShowVault(false)}
        />
      )}

      {showAlignmentModal && (
        <FinancialAlignmentModal
          onClose={() => setShowAlignmentModal(false)}
          activeUser={activeUser}
          severityPct={incomeDiscrepancyPct}
          members={Object.entries(groupUsers).map(([uid, u]) => ({
            uid,
            name: u?.name || '',
            income: u?.income,
            partnerIncome: u?.partnerIncome,
            financialProfile: u?.financialProfile,
          }))}
        />
      )}

      {showForm && (
        <ExpenseForm
          group={group}
          activeUser={activeUser}
          onClose={() => {
            setShowForm(false);
            setEditingExpense(null);
          }}
          onSubmit={handleAddOrEditExpense}
          editingExpense={editingExpense}
          memberThresholds={memberThresholds}
          isPlus={isPlus}
        />
      )}

      {/* The live copy, so synced confirmations and edits show up immediately. */}
      {selectedExpense && (
        <ExpenseDetail
          expense={expenses.find((e) => e.id === selectedExpense.id) || selectedExpense}
          group={group}
          activeUser={activeUser}
          onClose={() => setSelectedExpense(null)}
          onEdit={() => {
            setEditingExpense(expenses.find((e) => e.id === selectedExpense.id) || selectedExpense);
            setSelectedExpense(null);
            setShowForm(true);
          }}
          onDelete={() => handleDeleteExpense(selectedExpense.id)}
          onSettleClick={() => setShowSettleModal(true)}
          onConfirmReceipt={(settlementId) => handleConfirmSettleReceipt(settlementId)}
          onVoidSettlement={(settlementId) => handleVoidSettlement(settlementId)}
          onAddComment={(text) => handleAddComment(selectedExpense.id, text)}
          onGentleRemind={() =>
            handleGentleRemind(expenses.find((e) => e.id === selectedExpense.id) || selectedExpense)
          }
          onClaim={(uid) => handleClaimExpense(selectedExpense.id, uid)}
        />
      )}

      {showSettleModal && selectedExpense && (
        <SettleUpModal
          expense={expenses.find((e) => e.id === selectedExpense.id) || selectedExpense}
          group={group}
          activeUser={activeUser}
          paymentHandlesByUid={paymentHandlesByUid}
          onClose={() => setShowSettleModal(false)}
          onSubmit={handleSettleUpProposal}
        />
      )}

      {legalDoc && <LegalModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}
    </div>
  );
}
