import { useState } from 'react'
import { Sparkles, CreditCard, Target, ArrowRight, Check, Wallet, Upload } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { toast } from 'sonner'

interface OnboardingWizardProps {
  userName: string
  onComplete: () => void
}

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to FinFlow',
    subtitle: 'Let\'s set up your financial dashboard in 3 quick steps',
    icon: Sparkles,
  },
  {
    id: 'account',
    title: 'Add Your First Account',
    subtitle: 'Start by adding a bank account to track your money',
    icon: CreditCard,
  },
  {
    id: 'budget',
    title: 'Set a Monthly Budget',
    subtitle: 'Tell us how much you want to spend each month',
    icon: Wallet,
  },
  {
    id: 'done',
    title: 'You\'re All Set!',
    subtitle: 'Start adding transactions or import from your bank',
    icon: Check,
  },
]

const ACCOUNT_TYPES = [
  { value: 'checking', label: 'Checking', icon: '🏦' },
  { value: 'savings', label: 'Savings', icon: '💰' },
  { value: 'credit', label: 'Credit Card', icon: '💳' },
]

const DEFAULT_CATEGORIES = [
  { name: 'Housing', icon: '🏠', color: '#6366F1', budget: 1500 },
  { name: 'Food & Dining', icon: '🍔', color: '#F59E0B', budget: 600 },
  { name: 'Transportation', icon: '🚗', color: '#3B82F6', budget: 400 },
  { name: 'Entertainment', icon: '🎬', color: '#EC4899', budget: 200 },
  { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', budget: 300 },
  { name: 'Utilities', icon: '💡', color: '#14B8A6', budget: 250 },
  { name: 'Health', icon: '🏥', color: '#EF4444', budget: 200 },
  { name: 'Salary', icon: '💵', color: '#10B981', budget: 0, isIncome: true },
]

export function OnboardingWizard({ userName, onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0)
  const [isCreating, setIsCreating] = useState(false)
  const navigate = useNavigate()

  // Account form
  const [accountName, setAccountName] = useState('')
  const [accountType, setAccountType] = useState('checking')
  const [accountBalance, setAccountBalance] = useState('')
  const [institution, setInstitution] = useState('')

  // Budget
  const [monthlyBudget, setMonthlyBudget] = useState('3000')

  const handleCreateAccount = async () => {
    if (!accountName) return toast.error('Please enter an account name')
    setIsCreating(true)
    try {
      await api.post('/accounts', {
        name: accountName,
        type: accountType,
        institution: institution || 'My Bank',
        balance: parseFloat(accountBalance) || 0,
        last_four: '',
        icon: ACCOUNT_TYPES.find(t => t.value === accountType)?.icon || '🏦',
        is_hidden: false,
      })
      toast.success('Account created!')
      setStep(2)
    } catch {
      toast.error('Failed to create account')
    } finally {
      setIsCreating(false)
    }
  }

  const handleSetupBudget = async () => {
    setIsCreating(true)
    try {
      // Create default categories and budgets
      const totalBudget = parseFloat(monthlyBudget) || 3000
      const scale = totalBudget / 3450 // Scale to user's budget

      for (const cat of DEFAULT_CATEGORIES) {
        const catRes = await api.post<{ id: string }>('/categories', {
          name: cat.name,
          icon: cat.icon,
          color: cat.color,
          budget_amount: cat.budget > 0 ? Math.round(cat.budget * scale) : null,
          is_income: cat.isIncome || false,
          parent_id: null,
          sort_order: 0,
        })

        if (cat.budget > 0 && catRes.id) {
          const now = new Date()
          const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
          await api.post('/budgets', {
            category_id: catRes.id,
            month,
            amount: Math.round(cat.budget * scale),
            rollover: false,
          })
        }
      }

      toast.success('Budget categories created!')
      setStep(3)
    } catch (err) {
      console.error(err)
      toast.error('Failed to set up budget')
    } finally {
      setIsCreating(false)
    }
  }

  const handleFinish = () => {
    localStorage.setItem('finflow_onboarded', 'true')
    onComplete()
  }

  const currentStep = STEPS[step]
  const StepIcon = currentStep.icon

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-lg shadow-2xl overflow-hidden">
        {/* Progress */}
        <div className="flex gap-1 p-4 pb-0">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={cn(
                'h-1 flex-1 rounded-full transition-all duration-500',
                i <= step ? 'bg-primary' : 'bg-muted'
              )}
            />
          ))}
        </div>

        <div className="p-8 text-center">
          {/* Icon */}
          <div className={cn(
            'w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5',
            step === 3 ? 'bg-emerald-500/20' : 'bg-primary/20'
          )}>
            <StepIcon className={cn(
              'w-8 h-8',
              step === 3 ? 'text-emerald-400' : 'text-primary'
            )} />
          </div>

          <h2 className="text-xl font-bold">
            {step === 0 ? `Welcome, ${userName.split(' ')[0]}!` : currentStep.title}
          </h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            {currentStep.subtitle}
          </p>

          {/* Step content */}
          {step === 0 && (
            <div className="mt-6 space-y-3 text-left max-w-xs mx-auto">
              {[
                { icon: CreditCard, text: 'Add a bank account' },
                { icon: Wallet, text: 'Set your budget' },
                { icon: Upload, text: 'Start tracking' },
              ].map(({ icon: Icon, text }, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-muted/50">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <span className="text-sm font-medium">{text}</span>
                </div>
              ))}
            </div>
          )}

          {step === 1 && (
            <div className="mt-6 space-y-3 text-left">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Account Name</label>
                <input
                  value={accountName}
                  onChange={e => setAccountName(e.target.value)}
                  placeholder="e.g. Chase Checking"
                  className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {ACCOUNT_TYPES.map(t => (
                  <button
                    key={t.value}
                    onClick={() => setAccountType(t.value)}
                    className={cn(
                      'p-3 rounded-xl border text-center transition-all',
                      accountType === t.value
                        ? 'border-primary bg-primary/10'
                        : 'border-border/50 hover:bg-accent'
                    )}
                  >
                    <span className="text-xl block">{t.icon}</span>
                    <span className="text-xs font-medium mt-1 block">{t.label}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Institution</label>
                  <input
                    value={institution}
                    onChange={e => setInstitution(e.target.value)}
                    placeholder="Chase, BofA..."
                    className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Current Balance</label>
                  <input
                    type="number"
                    step="0.01"
                    value={accountBalance}
                    onChange={e => setAccountBalance(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="mt-6 space-y-4 text-left">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Total Monthly Budget
                </label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                  <input
                    type="number"
                    value={monthlyBudget}
                    onChange={e => setMonthlyBudget(e.target.value)}
                    className="w-full h-12 pl-7 pr-4 rounded-lg border border-input bg-background text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                We'll create default categories (Housing, Food, Transport, etc.) scaled to your budget.
                You can customize them later.
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="mt-6 space-y-3 text-left max-w-xs mx-auto">
              {[
                { text: 'Add transactions manually or import from CSV', action: '/transactions' },
                { text: 'Upload bank statements to auto-import', action: '/upload' },
                { text: 'View your dashboard', action: '/' },
              ].map(({ text, action }, i) => (
                <button
                  key={i}
                  onClick={() => {
                    handleFinish()
                    navigate(action)
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-muted/50 hover:bg-accent transition-colors text-left"
                >
                  <span className="text-sm">{text}</span>
                  <ArrowRight className="w-4 h-4 text-muted-foreground ml-auto shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-6 pt-0 flex gap-3">
          {step > 0 && step < 3 && (
            <button
              onClick={() => setStep(s => s - 1)}
              className="flex-1 h-11 rounded-xl border border-input text-sm font-medium hover:bg-accent transition-colors"
            >
              Back
            </button>
          )}

          {step === 0 && (
            <button
              onClick={() => setStep(1)}
              className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
            >
              Get Started <ArrowRight className="w-4 h-4" />
            </button>
          )}

          {step === 1 && (
            <>
              <button
                onClick={handleCreateAccount}
                disabled={isCreating}
                className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isCreating ? 'Creating...' : 'Create Account'}
              </button>
              <button
                onClick={() => setStep(2)}
                className="h-11 px-4 rounded-xl text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <button
                onClick={handleSetupBudget}
                disabled={isCreating}
                className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isCreating ? 'Setting up...' : 'Set Up Budget'}
              </button>
              <button
                onClick={() => setStep(3)}
                className="h-11 px-4 rounded-xl text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip
              </button>
            </>
          )}

          {step === 3 && (
            <button
              onClick={handleFinish}
              className="flex-1 h-11 rounded-xl bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-500/90 transition-colors flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" /> Go to Dashboard
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
