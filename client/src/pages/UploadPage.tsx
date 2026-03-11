import { useState, useEffect, useCallback, useRef } from 'react'
import { format, parseISO } from 'date-fns'
import {
  Upload,
  FileText,
  FileSpreadsheet,
  X,
  Check,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  SkipForward,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Clock,
  Info,
  Zap,
  CreditCard,
  Wallet,
  TrendingUp,
  TrendingDown,
  DollarSign,
} from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { useCategories } from '@/hooks/useCategories'
import { useAccounts } from '@/hooks/useAccounts'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { UploadSession, PendingItem, DuplicateMatch, Category } from '@/types'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return <FileText className="w-5 h-5 text-red-400" />
  return <FileSpreadsheet className="w-5 h-5 text-green-400" />
}

function getFileTypeLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'PDF'
  if (ext === 'xlsx' || ext === 'xls') return 'Excel'
  if (ext === 'csv') return 'CSV'
  return ext?.toUpperCase() || 'File'
}

function StatusBadge({ status }: { status: PendingItem['status'] }) {
  const config: Record<PendingItem['status'], { label: string; className: string }> = {
    pending: { label: 'Pending', className: 'bg-slate-500/10 text-slate-400' },
    approved: { label: 'Approved', className: 'bg-emerald-500/10 text-emerald-400' },
    skipped: { label: 'Skipped', className: 'bg-red-500/10 text-red-400' },
    duplicate: { label: 'Duplicate', className: 'bg-amber-500/10 text-amber-400' },
    imported: { label: 'Imported', className: 'bg-blue-500/10 text-blue-400' },
  }
  const c = config[status] || config.pending
  return (
    <span className={cn('text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full', c.className)}>
      {c.label}
    </span>
  )
}

function SessionStatusBadge({ status }: { status: UploadSession['status'] }) {
  const config: Record<UploadSession['status'], { label: string; className: string }> = {
    processing: { label: 'Processing', className: 'bg-blue-500/10 text-blue-400' },
    review: { label: 'In Review', className: 'bg-amber-500/10 text-amber-400' },
    completed: { label: 'Completed', className: 'bg-emerald-500/10 text-emerald-400' },
    failed: { label: 'Failed', className: 'bg-red-500/10 text-red-400' },
  }
  const c = config[status] || config.processing
  return (
    <span className={cn('text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full', c.className)}>
      {c.label}
    </span>
  )
}

function MatchScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const colorClass = pct > 80 ? 'text-emerald-400' : pct > 60 ? 'text-amber-400' : 'text-red-400'
  const bgClass = pct > 80 ? 'bg-emerald-500/10' : pct > 60 ? 'bg-amber-500/10' : 'bg-red-500/10'
  return (
    <span className={cn('text-xs font-bold tabular-nums px-2 py-0.5 rounded-full', bgClass, colorClass)}>
      {pct}% match
    </span>
  )
}

// ── Upload Drop Zone ────────────────────────────────────────────────────

function UploadDropZone({
  files,
  setFiles,
  onUpload,
  isUploading,
}: {
  files: File[]
  setFiles: React.Dispatch<React.SetStateAction<File[]>>
  onUpload: () => void
  isUploading: boolean
}) {
  const [dragActive, setDragActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.match(/\.(csv|xlsx|xls|pdf)$/i)
    )
    if (droppedFiles.length === 0) {
      toast.error('Only CSV, Excel, and PDF files are supported')
      return
    }
    setFiles((prev) => {
      const combined = [...prev, ...droppedFiles]
      if (combined.length > 10) {
        toast.error('Maximum 10 files allowed')
        return combined.slice(0, 10)
      }
      return combined
    })
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return
    const selected = Array.from(e.target.files).filter((f) =>
      f.name.match(/\.(csv|xlsx|xls|pdf)$/i)
    )
    setFiles((prev) => {
      const combined = [...prev, ...selected]
      if (combined.length > 10) {
        toast.error('Maximum 10 files allowed')
        return combined.slice(0, 10)
      }
      return combined
    })
    e.target.value = ''
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <h2 className="text-lg font-semibold mb-4">Upload Transactions</h2>

      {/* Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all duration-200',
          dragActive
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary/50 hover:bg-accent/20'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.xlsx,.xls,.pdf"
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              'w-14 h-14 rounded-2xl flex items-center justify-center transition-colors',
              dragActive ? 'bg-primary/20' : 'bg-muted'
            )}
          >
            <Upload className={cn('w-7 h-7', dragActive ? 'text-primary' : 'text-muted-foreground')} />
          </div>
          <div>
            <p className="text-sm font-medium">
              {dragActive ? 'Drop files here' : 'Drag and drop your files here'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
          </div>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="w-3.5 h-3.5 text-red-400" />
              PDF
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileSpreadsheet className="w-3.5 h-3.5 text-green-400" />
              CSV
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileSpreadsheet className="w-3.5 h-3.5 text-green-400" />
              Excel
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">Up to 10 files, 10MB each</p>
        </div>
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {files.length} file{files.length !== 1 ? 's' : ''} selected
          </p>
          <div className="space-y-1.5">
            {files.map((file, idx) => (
              <div
                key={`${file.name}-${idx}`}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/50 border border-border/30"
              >
                {getFileIcon(file.name)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {getFileTypeLabel(file.name)} &middot; {formatFileSize(file.size)}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFile(idx)
                  }}
                  className="p-1 rounded-md hover:bg-accent transition-colors shrink-0"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={onUpload}
            disabled={isUploading || files.length === 0}
            className="mt-4 w-full h-11 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Uploading & Parsing...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Upload & Parse
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Statement Detection Results ─────────────────────────────────────────

interface FileResult {
  id: string;
  filename: string;
  fileType: string;
  rowCount: number;
  status: 'parsed' | 'error';
  errors?: string[];
  error?: string;
  depositCount?: number;
  withdrawalCount?: number;
  transferCount?: number;
  statementMeta?: {
    institution: string;
    accountType: string;
    accountNickname: string;
    period: { start: string; end: string };
    beginningBalance: number;
    endingBalance: number;
    summary: {
      totalDeposits: number;
      totalWithdrawals: number;
      totalTransfers: number;
      totalFees: number;
      transactionCount: number;
      transferCount: number;
    };
  };
}

function getAccountTypeIcon(accountType: string) {
  switch (accountType) {
    case 'checking':
      return <Wallet className="w-5 h-5 text-blue-400" />;
    case 'savings':
      return <DollarSign className="w-5 h-5 text-emerald-400" />;
    case 'credit_card':
      return <CreditCard className="w-5 h-5 text-purple-400" />;
    default:
      return <Wallet className="w-5 h-5 text-muted-foreground" />;
  }
}

function formatDateRange(start: string, end: string): string {
  try {
    const startDate = parseISO(start);
    const endDate = parseISO(end);
    return `${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d, yyyy')}`;
  } catch {
    return `${start} to ${end}`;
  }
}

function StatementDetectionCard({ file, isLoading }: { file: FileResult; isLoading: boolean }) {
  const { statementMeta, depositCount = 0, withdrawalCount = 0, transferCount = 0, status, error } = file;

  if (status === 'error') {
    return (
      <div className="bg-card rounded-2xl border border-red-500/20 p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center shrink-0 mt-0.5">
            <AlertCircle className="w-5 h-5 text-red-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{file.filename}</p>
            <p className="text-xs text-red-400 mt-1">{error || 'Failed to parse file'}</p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !statementMeta) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-muted rounded w-48" />
            <div className="h-3 bg-muted rounded w-64" />
            <div className="h-3 bg-muted rounded w-40 mt-3" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-start gap-4">
        {/* Account Icon */}
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          {getAccountTypeIcon(statementMeta.accountType)}
        </div>

        {/* Main Content */}
        <div className="flex-1 min-w-0">
          {/* Header: Bank + Account */}
          <div className="flex items-baseline gap-2 mb-2">
            <p className="text-sm font-semibold text-foreground">{statementMeta.institution}</p>
            <p className="text-xs text-muted-foreground">{statementMeta.accountNickname}</p>
          </div>

          {/* Statement Period */}
          <p className="text-xs text-muted-foreground mb-3">
            {formatDateRange(statementMeta.period.start, statementMeta.period.end)}
          </p>

          {/* Balance Row */}
          <div className="flex items-center gap-4 mb-4 p-3 rounded-lg bg-muted/30 border border-border/20">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Beginning</p>
              <p className="text-sm font-bold text-foreground">{formatCurrency(statementMeta.beginningBalance)}</p>
            </div>
            <div className="text-muted-foreground">
              <ArrowRight className="w-4 h-4" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Ending</p>
              <p className="text-sm font-bold text-foreground">{formatCurrency(statementMeta.endingBalance)}</p>
            </div>
          </div>

          {/* Transaction Breakdown */}
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
              <div className="flex items-center gap-1 mb-1">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Deposits</p>
              </div>
              <p className="text-sm font-bold text-emerald-400">{depositCount}</p>
            </div>
            <div className="p-2 rounded-lg bg-red-500/5 border border-red-500/20">
              <div className="flex items-center gap-1 mb-1">
                <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Withdrawals</p>
              </div>
              <p className="text-sm font-bold text-red-400">{withdrawalCount}</p>
            </div>
            <div className="p-2 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <div className="flex items-center gap-1 mb-1">
                <Zap className="w-3.5 h-3.5 text-blue-400" />
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Transfers</p>
              </div>
              <p className="text-sm font-bold text-blue-400">{transferCount}</p>
            </div>
          </div>

          {/* Status Badge */}
          <div className="mt-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Parsed successfully</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Upload Progress Indicator ──────────────────────────────────────

function UploadProgressIndicator({ step, totalSteps = 4 }: { step: number; totalSteps?: number }) {
  const steps = [
    { label: 'Uploading files...', icon: Upload },
    { label: 'Analyzing statements...', icon: FileText },
    { label: 'Categorizing transactions...', icon: Zap },
    { label: 'Complete!', icon: CheckCircle2 },
  ];

  const displaySteps = steps.slice(0, totalSteps);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="space-y-4">
        {displaySteps.map((s, idx) => {
          const stepNum = idx + 1;
          const isActive = stepNum === step;
          const isComplete = stepNum < step;

          return (
            <div key={idx} className="flex items-center gap-3">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-semibold text-xs transition-all',
                  isComplete
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {isComplete ? <Check className="w-4 h-4" /> : stepNum}
              </div>
              <div className="flex-1">
                <p
                  className={cn(
                    'text-sm font-medium',
                    isActive ? 'text-foreground' : isComplete ? 'text-emerald-400' : 'text-muted-foreground'
                  )}
                >
                  {s.label}
                </p>
              </div>
              {isActive && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Review Section ──────────────────────────────────────────────────────

function ReviewSummaryBar({ session, items, fileResults }: { session: UploadSession; items: PendingItem[]; fileResults?: FileResult[] }) {
  const totalItems = items.length
  const categorized = items.filter((i) => i.matched_category_id).length
  const duplicates = items.filter((i) => i.status === 'duplicate').length
  const needsReview = items.filter((i) => !i.matched_category_id && i.status === 'pending').length
  const totalDeposits = fileResults?.reduce((sum, f) => sum + (f.depositCount || 0), 0) || 0
  const totalWithdrawals = fileResults?.reduce((sum, f) => sum + (f.withdrawalCount || 0), 0) || 0
  const totalTransfers = fileResults?.reduce((sum, f) => sum + (f.transferCount || 0), 0) || 0

  return (
    <div className="space-y-4 mb-5">
      {/* Main Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Items</p>
          <p className="text-xl font-bold mt-1">{totalItems}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Auto-Categorized</p>
          <p className="text-xl font-bold mt-1 text-emerald-400">{categorized}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duplicates</p>
          <p className="text-xl font-bold mt-1 text-amber-400">{duplicates}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Needs Review</p>
          <p className="text-xl font-bold mt-1 text-red-400">{needsReview}</p>
        </div>
      </div>

      {/* File Breakdown */}
      {fileResults && fileResults.length > 0 && (
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {fileResults.length} File{fileResults.length !== 1 ? 's' : ''} Uploaded
          </p>
          <div className="space-y-2">
            {fileResults.map((file) => (
              <div key={file.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  {getFileIcon(file.filename)}
                  <span className="text-muted-foreground">{file.filename}</span>
                </div>
                {file.status === 'parsed' && (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span>{file.rowCount} rows</span>
                    {file.statementMeta && (
                      <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                        {file.statementMeta.accountNickname}
                      </span>
                    )}
                  </div>
                )}
                {file.status === 'error' && (
                  <span className="text-red-400 text-[10px]">Error parsing</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AllItemsTab({
  items,
  categories,
  accounts,
  onUpdateItem,
  onBulkApprove,
  onBulkSkipDuplicates,
}: {
  items: PendingItem[]
  categories: Category[]
  accounts: { id: string; name: string }[]
  onUpdateItem: (id: string, updates: Partial<PendingItem>) => void
  onBulkApprove: () => void
  onBulkSkipDuplicates: () => void
}) {
  const hasDuplicates = items.some((i) => i.status === 'duplicate')
  const hasPending = items.some((i) => i.status === 'pending')

  return (
    <div>
      {/* Bulk Actions */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {hasPending && (
          <button
            onClick={onBulkApprove}
            className="h-8 px-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-colors flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Approve All Pending
          </button>
        )}
        {hasDuplicates && (
          <button
            onClick={onBulkSkipDuplicates}
            className="h-8 px-3 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors flex items-center gap-1.5"
          >
            <SkipForward className="w-3.5 h-3.5" />
            Skip All Duplicates
          </button>
        )}
      </div>

      {/* Items Table */}
      <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/30">
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Amount
                </th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Date
                </th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Category
                </th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Account
                </th>
                <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No items found
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    className={cn(
                      'hover:bg-accent/20 transition-colors',
                      item.status === 'skipped' && 'opacity-50',
                      item.status === 'imported' && 'opacity-60'
                    )}
                  >
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{item.parsed_name}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={cn(
                          'font-semibold tabular-nums',
                          item.parsed_amount > 0 ? 'text-emerald-400' : 'text-foreground'
                        )}
                      >
                        {item.parsed_amount > 0 ? '+' : ''}
                        {formatCurrency(item.parsed_amount)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.parsed_date ? format(parseISO(item.parsed_date), 'MMM d, yyyy') : '--'}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={item.matched_category_id || ''}
                        onChange={(e) =>
                          onUpdateItem(item.id, { matched_category_id: e.target.value || null })
                        }
                        disabled={item.status === 'imported' || item.status === 'skipped'}
                        className="h-8 px-2 rounded-lg border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 max-w-[160px]"
                      >
                        <option value="">Uncategorized</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.icon} {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={item.matched_account_id || ''}
                        onChange={(e) =>
                          onUpdateItem(item.id, { matched_account_id: e.target.value || null })
                        }
                        disabled={item.status === 'imported' || item.status === 'skipped'}
                        className="h-8 px-2 rounded-lg border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 max-w-[140px]"
                      >
                        <option value="">Select...</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {item.status !== 'imported' && (
                          <>
                            <button
                              onClick={() => onUpdateItem(item.id, { status: 'approved' })}
                              disabled={item.status === 'approved'}
                              className={cn(
                                'p-1.5 rounded-md transition-colors',
                                item.status === 'approved'
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : 'hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-400'
                              )}
                              title="Approve"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => onUpdateItem(item.id, { status: 'skipped' })}
                              disabled={item.status === 'skipped'}
                              className={cn(
                                'p-1.5 rounded-md transition-colors',
                                item.status === 'skipped'
                                  ? 'bg-red-500/20 text-red-400'
                                  : 'hover:bg-red-500/10 text-muted-foreground hover:text-red-400'
                              )}
                              title="Skip"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function DuplicatesTab({
  items,
  duplicateMatches,
  onUpdateItem,
}: {
  items: PendingItem[]
  duplicateMatches: DuplicateMatch[]
  onUpdateItem: (id: string, updates: Partial<PendingItem>) => void
}) {
  const duplicateItems = items.filter((i) => i.status === 'duplicate')

  if (duplicateItems.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
        <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
        <p className="text-sm font-medium">No duplicates detected</p>
        <p className="text-xs text-muted-foreground mt-1">All uploaded items appear to be unique</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {duplicateItems.map((item) => {
        const match = duplicateMatches.find((m) => m.itemId === item.id)
        return (
          <div key={item.id} className="bg-card rounded-2xl border border-border/50 p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium">Potential Duplicate</span>
              </div>
              {match && <MatchScoreBadge score={match.score} />}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              {/* Uploaded Item */}
              <div className="rounded-xl border border-border/30 p-4 bg-muted/30">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-2">
                  Uploaded Item
                </p>
                <p className="text-sm font-medium">{item.parsed_name}</p>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatCurrency(item.parsed_amount)}
                  </span>
                  <span>{item.parsed_date ? format(parseISO(item.parsed_date), 'MMM d, yyyy') : '--'}</span>
                </div>
              </div>

              {/* Existing Match */}
              <div className="rounded-xl border border-amber-500/20 p-4 bg-amber-500/5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-2">
                  Existing Transaction
                </p>
                {item.duplicate_of ? (
                  <>
                    <p className="text-sm font-medium">Matching transaction found</p>
                    <p className="text-xs text-muted-foreground mt-1">ID: {item.duplicate_of.slice(0, 8)}...</p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Details not available</p>
                )}
              </div>
            </div>

            {/* Match Reasons */}
            {match && match.reasons.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {match.reasons.map((reason, idx) => (
                  <span
                    key={idx}
                    className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
                  >
                    {reason}
                  </span>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={() => onUpdateItem(item.id, { status: 'skipped' })}
                className="h-8 px-3 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors flex items-center gap-1.5"
              >
                <SkipForward className="w-3.5 h-3.5" />
                Skip (it's a duplicate)
              </button>
              <button
                onClick={() => onUpdateItem(item.id, { status: 'approved' })}
                className="h-8 px-3 rounded-lg bg-muted text-foreground text-xs font-medium hover:bg-accent transition-colors flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                Import Anyway
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ClarificationsTab({
  items,
  categories,
  onUpdateItem,
}: {
  items: PendingItem[]
  categories: Category[]
  onUpdateItem: (id: string, updates: Partial<PendingItem>) => void
}) {
  const uncategorized = items.filter((i) => !i.matched_category_id && i.status === 'pending')

  if (uncategorized.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
        <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
        <p className="text-sm font-medium">All items categorized</p>
        <p className="text-xs text-muted-foreground mt-1">
          Every item has been assigned a category
        </p>
      </div>
    )
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {uncategorized.map((item) => (
        <div key={item.id} className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-xl bg-red-500/10 flex items-center justify-center shrink-0">
              <AlertCircle className="w-5 h-5 text-red-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{item.parsed_name}</p>
              <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">
                  {formatCurrency(item.parsed_amount)}
                </span>
                <span>
                  {item.parsed_date ? format(parseISO(item.parsed_date), 'MMM d, yyyy') : '--'}
                </span>
              </div>
              {item.parsed_category && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Original: "{item.parsed_category}"
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Assign Category
            </label>
            <select
              value={item.matched_category_id || ''}
              onChange={(e) => {
                const categoryId = e.target.value || null
                onUpdateItem(item.id, {
                  matched_category_id: categoryId,
                  status: categoryId ? 'approved' : 'pending',
                })
              }}
              className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">Select a category...</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
              <Info className="w-3 h-3" />
              The system will learn from your choice
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ImportActionsBar({
  items,
  sessionId,
  onImportApproved,
  onImportAll,
  onDiscard,
  isImporting,
}: {
  items: PendingItem[]
  sessionId: string
  onImportApproved: () => void
  onImportAll: () => void
  onDiscard: () => void
  isImporting: boolean
}) {
  const approvedCount = items.filter(
    (i) => i.status === 'approved' || (i.status === 'pending' && i.matched_category_id)
  ).length
  const importableCount = items.filter((i) => i.status !== 'skipped' && i.status !== 'imported').length

  return (
    <div className="sticky bottom-0 z-10 bg-card/95 backdrop-blur-sm border-t border-border/50 -mx-1 px-1">
      <div className="flex items-center justify-between gap-3 py-4 flex-wrap">
        <button
          onClick={onDiscard}
          disabled={isImporting}
          className="h-10 px-4 rounded-lg border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Discard Session
        </button>

        <div className="flex items-center gap-3">
          <button
            onClick={onImportAll}
            disabled={isImporting || importableCount === 0}
            className="h-10 px-4 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isImporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            Approve & Import All
            <span className="text-[10px] font-bold bg-muted px-1.5 py-0.5 rounded-full">
              {importableCount}
            </span>
          </button>

          <button
            onClick={onImportApproved}
            disabled={isImporting || approvedCount === 0}
            className="h-10 px-4 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isImporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ArrowRight className="w-4 h-4" />
            )}
            Import Approved
            <span className="text-[10px] font-bold bg-emerald-500/50 px-1.5 py-0.5 rounded-full">
              {approvedCount}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

function UploadHistory({
  sessions,
  onSelectSession,
}: {
  sessions: UploadSession[]
  onSelectSession: (session: UploadSession) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)

  if (sessions.length === 0) return null

  return (
    <div className="mt-8">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors mb-3"
      >
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Upload History ({sessions.length})
      </button>

      {expanded && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <div className="divide-y divide-border/30">
            {sessions.map((session) => (
              <div key={session.id}>
                <div
                  className="flex items-center gap-4 px-5 py-4 hover:bg-accent/20 transition-colors cursor-pointer"
                  onClick={() =>
                    setExpandedSessionId(expandedSessionId === session.id ? null : session.id)
                  }
                >
                  <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center shrink-0">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {format(parseISO(session.created_at), 'MMM d, yyyy h:mm a')}
                      </span>
                      <SessionStatusBadge status={session.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {session.file_count} file{session.file_count !== 1 ? 's' : ''} &middot;{' '}
                      {session.imported_items} of {session.total_items} imported
                    </p>
                  </div>
                  <div className="shrink-0">
                    {expandedSessionId === session.id ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                </div>

                {expandedSessionId === session.id && (
                  <div className="px-5 pb-4 pt-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{session.total_items}</span> total items
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-emerald-400">{session.imported_items}</span> imported
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-amber-400">{session.duplicate_items}</span> duplicates
                      </div>
                      {session.status === 'review' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelectSession(session)
                          }}
                          className="ml-auto h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                        >
                          Resume Review
                        </button>
                      )}
                    </div>
                    {session.files && session.files.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {session.files.map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            {getFileIcon(file.filename)}
                            <span className="truncate">{file.filename}</span>
                            <span className="shrink-0">({file.row_count} rows)</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page Component ─────────────────────────────────────────────────

export function UploadPage() {
  const [step, setStep] = useState<'upload' | 'detection' | 'review'>('upload')
  const [uploadProgress, setUploadProgress] = useState(1) // 1-4 for progress steps
  const [files, setFiles] = useState<File[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [currentSession, setCurrentSession] = useState<UploadSession | null>(null)
  const [fileResults, setFileResults] = useState<FileResult[]>([])
  const [sessions, setSessions] = useState<UploadSession[]>([])
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([])
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([])
  const [activeTab, setActiveTab] = useState<'all' | 'duplicates' | 'clarifications'>('all')
  const [loading, setLoading] = useState(true)

  const { categories } = useCategories()
  const { accounts } = useAccounts()

  // Fetch sessions on mount
  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.get<UploadSession[]>('/upload/sessions')
      setSessions(Array.isArray(res) ? res : [])
    } catch (err) {
      console.error('Failed to fetch upload sessions:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // Fetch session details (items + duplicates)
  const fetchSessionDetails = useCallback(async (sessionId: string) => {
    try {
      const session = await api.get<UploadSession>(`/upload/sessions/${sessionId}`)
      setCurrentSession(session)
      setPendingItems(session.items || [])

      // Build duplicate matches from items that have duplicate_of set
      const matches: DuplicateMatch[] = (session.items || [])
        .filter((item) => item.status === 'duplicate' && item.duplicate_of)
        .map((item) => ({
          itemId: item.id,
          matchedTransactionId: item.duplicate_of!,
          score: item.confidence || 0.75,
          reasons: buildMatchReasons(item),
          matchType: 'existing' as const,
        }))
      setDuplicateMatches(matches)
    } catch (err) {
      console.error('Failed to fetch session details:', err)
      toast.error('Failed to load session details')
    }
  }, [])

  // Build match reasons from item data
  function buildMatchReasons(item: PendingItem): string[] {
    const reasons: string[] = []
    const confidence = item.confidence || 0
    if (confidence > 0.9) {
      reasons.push('Amount matches exactly')
      reasons.push('Date matches exactly')
      reasons.push('Similar name')
    } else if (confidence > 0.7) {
      reasons.push('Amount matches exactly')
      reasons.push('Date within 2 days')
    } else if (confidence > 0.5) {
      reasons.push('Similar amount')
      reasons.push('Similar name')
    } else {
      reasons.push('Partial match')
    }
    return reasons
  }

  // Handle file upload
  const handleUpload = async () => {
    if (files.length === 0) return

    setIsUploading(true)
    setUploadProgress(1)
    setStep('detection')

    try {
      const formData = new FormData()
      files.forEach((file) => {
        formData.append('files', file)
      })

      // Simulate progress through steps
      setTimeout(() => setUploadProgress(2), 500);
      setTimeout(() => setUploadProgress(3), 1500);

      const response = await api.upload<any>('/upload', formData)
      setCurrentSession(response)
      setFileResults(response.files || [])
      setFiles([])

      // Final progress step
      setTimeout(async () => {
        setUploadProgress(4)

        // Small delay before moving to review
        setTimeout(async () => {
          await fetchSessionDetails(response.id)
          setStep('review')
          setActiveTab('all')
          toast.success(`${response.total_items} items parsed from ${response.file_count} file${response.file_count !== 1 ? 's' : ''}`)
        }, 800)
      }, 800)
    } catch (err) {
      console.error('Upload failed:', err)
      toast.error('Failed to upload files. Please try again.')
      setStep('upload')
    } finally {
      setIsUploading(false)
    }
  }

  // Update a single item
  const handleUpdateItem = async (id: string, updates: Partial<PendingItem>) => {
    try {
      const payload: Record<string, unknown> = {}
      if (updates.status !== undefined) payload.status = updates.status
      if (updates.matched_category_id !== undefined) payload.matched_category_id = updates.matched_category_id
      if (updates.matched_account_id !== undefined) payload.matched_account_id = updates.matched_account_id

      await api.put(`/upload/items/${id}`, payload)

      setPendingItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
      )
    } catch (err) {
      console.error('Failed to update item:', err)
      toast.error('Failed to update item')
    }
  }

  // Bulk approve all pending items
  const handleBulkApprove = async () => {
    const pendingIds = pendingItems
      .filter((i) => i.status === 'pending')
      .map((i) => i.id)

    try {
      await Promise.all(
        pendingIds.map((id) => api.put(`/upload/items/${id}`, { status: 'approved' }))
      )
      setPendingItems((prev) =>
        prev.map((item) =>
          item.status === 'pending' ? { ...item, status: 'approved' as const } : item
        )
      )
      toast.success(`${pendingIds.length} items approved`)
    } catch {
      toast.error('Failed to approve items')
    }
  }

  // Bulk skip duplicates
  const handleBulkSkipDuplicates = async () => {
    const dupIds = pendingItems
      .filter((i) => i.status === 'duplicate')
      .map((i) => i.id)

    try {
      await Promise.all(
        dupIds.map((id) => api.put(`/upload/items/${id}`, { status: 'skipped' }))
      )
      setPendingItems((prev) =>
        prev.map((item) =>
          item.status === 'duplicate' ? { ...item, status: 'skipped' as const } : item
        )
      )
      toast.success(`${dupIds.length} duplicates skipped`)
    } catch {
      toast.error('Failed to skip duplicates')
    }
  }

  // Import approved items
  const handleImportApproved = async () => {
    if (!currentSession) return
    setIsImporting(true)
    try {
      const result = await api.post<{ imported: number }>(`/upload/sessions/${currentSession.id}/import`)
      toast.success(`${result.imported} transactions imported successfully`)
      setPendingItems((prev) =>
        prev.map((item) =>
          item.status === 'approved' ? { ...item, status: 'imported' as const } : item
        )
      )
      setCurrentSession((prev) =>
        prev ? { ...prev, status: 'completed', imported_items: result.imported } : null
      )
      await fetchSessions()
    } catch (err) {
      console.error('Import failed:', err)
      toast.error('Failed to import transactions')
    } finally {
      setIsImporting(false)
    }
  }

  // Import all items (approve + import)
  const handleImportAll = async () => {
    if (!currentSession) return
    setIsImporting(true)
    try {
      const result = await api.post<{ imported: number }>(`/upload/sessions/${currentSession.id}/import-all`)
      toast.success(`${result.imported} transactions imported successfully`)
      setPendingItems((prev) =>
        prev.map((item) =>
          item.status !== 'skipped'
            ? { ...item, status: 'imported' as const }
            : item
        )
      )
      setCurrentSession((prev) =>
        prev ? { ...prev, status: 'completed', imported_items: result.imported } : null
      )
      await fetchSessions()
    } catch (err) {
      console.error('Import all failed:', err)
      toast.error('Failed to import transactions')
    } finally {
      setIsImporting(false)
    }
  }

  // Discard session
  const handleDiscard = async () => {
    if (!currentSession) return
    try {
      await api.delete(`/upload/sessions/${currentSession.id}`)
      toast.success('Upload session discarded')
      setCurrentSession(null)
      setPendingItems([])
      setDuplicateMatches([])
      setStep('upload')
      await fetchSessions()
    } catch {
      toast.error('Failed to discard session')
    }
  }

  // Resume a previous session
  const handleSelectSession = async (session: UploadSession) => {
    await fetchSessionDetails(session.id)
    setStep('review')
    setActiveTab('all')
  }

  // Tab counts for badges
  const allCount = pendingItems.length
  const duplicatesCount = pendingItems.filter((i) => i.status === 'duplicate').length
  const clarificationsCount = pendingItems.filter(
    (i) => !i.matched_category_id && i.status === 'pending'
  ).length

  const tabs = [
    { key: 'all' as const, label: 'All Items', count: allCount },
    { key: 'duplicates' as const, label: 'Duplicates', count: duplicatesCount },
    { key: 'clarifications' as const, label: 'Needs Clarification', count: clarificationsCount },
  ]

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="opacity-0 animate-fade-in stagger-1">
          <div className="h-8 w-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-4 w-40 rounded-lg bg-muted animate-pulse mt-2" />
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-6 h-64 animate-pulse opacity-0 animate-fade-in stagger-2" />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Upload Transactions"
        description="Import transactions from bank statements and spreadsheets"
      />

      {step === 'upload' && (
        <>
          <UploadDropZone
            files={files}
            setFiles={setFiles}
            onUpload={handleUpload}
            isUploading={isUploading}
          />
          <UploadHistory sessions={sessions} onSelectSession={handleSelectSession} />
        </>
      )}

      {step === 'detection' && (
        <div className="space-y-6">
          {/* Progress Indicator */}
          <UploadProgressIndicator step={uploadProgress} />

          {/* Statement Detection Cards */}
          {fileResults.length > 0 && uploadProgress > 1 && (
            <div>
              <h2 className="text-lg font-semibold mb-4">Statement Detection</h2>
              <div className="space-y-3">
                {fileResults.map((file) => (
                  <StatementDetectionCard key={file.id} file={file} isLoading={uploadProgress < 4} />
                ))}
              </div>

              {/* Bulk Stats */}
              {uploadProgress === 4 && (
                <div className="mt-6 p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <p className="text-sm font-semibold text-emerald-400">All files processed</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {fileResults.reduce((sum, f) => sum + f.rowCount, 0)} transactions detected across{' '}
                    {fileResults.length} file{fileResults.length !== 1 ? 's' : ''}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {step === 'review' && currentSession && (
        <>
          {/* Back to upload button */}
          <button
            onClick={() => {
              setStep('upload')
              setCurrentSession(null)
              setPendingItems([])
              setDuplicateMatches([])
              setFileResults([])
            }}
            className="mb-4 text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <ChevronRight className="w-3 h-3 rotate-180" />
            Back to Upload
          </button>

          {/* Summary Bar */}
          <ReviewSummaryBar session={currentSession} items={pendingItems} fileResults={fileResults} />

          {/* Tab Navigation */}
          <div className="flex items-center gap-1 mb-5 border-b border-border/30">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'px-4 py-2.5 text-sm font-medium transition-colors relative flex items-center gap-2',
                  activeTab === tab.key
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span
                    className={cn(
                      'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                      activeTab === tab.key ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {tab.count}
                  </span>
                )}
                {activeTab === tab.key && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {activeTab === 'all' && (
            <AllItemsTab
              items={pendingItems}
              categories={categories}
              accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
              onUpdateItem={handleUpdateItem}
              onBulkApprove={handleBulkApprove}
              onBulkSkipDuplicates={handleBulkSkipDuplicates}
            />
          )}

          {activeTab === 'duplicates' && (
            <DuplicatesTab
              items={pendingItems}
              duplicateMatches={duplicateMatches}
              onUpdateItem={handleUpdateItem}
            />
          )}

          {activeTab === 'clarifications' && (
            <ClarificationsTab
              items={pendingItems}
              categories={categories}
              onUpdateItem={handleUpdateItem}
            />
          )}

          {/* Import Actions Bar */}
          <ImportActionsBar
            items={pendingItems}
            sessionId={currentSession.id}
            onImportApproved={handleImportApproved}
            onImportAll={handleImportAll}
            onDiscard={handleDiscard}
            isImporting={isImporting}
          />

          {/* History below review */}
          <UploadHistory sessions={sessions} onSelectSession={handleSelectSession} />
        </>
      )}
    </div>
  )
}
