import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Search,
  Edit2,
  Trash2,
  X,
  Check,
  GripVertical,
  Tag,
  ArrowUpDown,
} from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { Category } from '@/types'

const EMOJI_OPTIONS = [
  '🏠', '🛒', '🍔', '🚗', '🛍️', '💡', '🏥', '🎬', '📱', '🛡️',
  '💪', '💇', '📚', '✈️', '🐾', '🎁', '📊', '💵', '💼', '💰',
  '🔄', '❓', '🎯', '🎮', '🏦', '💳', '🎵', '📦', '🏋️', '🧹',
  '👶', '🚌', '⛽', '🔧', '🏠', '🎓', '💊', '🦷', '👁️', '🧘',
]

const COLOR_OPTIONS = [
  '#6366F1', '#22C55E', '#F59E0B', '#3B82F6', '#8B5CF6', '#14B8A6',
  '#EF4444', '#EC4899', '#F97316', '#06B6D4', '#10B981', '#D946EF',
  '#0EA5E9', '#F472B6', '#A78BFA', '#FB923C', '#818CF8', '#34D399',
  '#94A3B8', '#64748B',
]

function CategoryForm({
  category,
  onSave,
  onCancel,
}: {
  category?: Category | null
  onSave: (data: Partial<Category>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(category?.name || '')
  const [icon, setIcon] = useState(category?.icon || '🏷️')
  const [color, setColor] = useState(category?.color || '#6366F1')
  const [isIncome, setIsIncome] = useState(category?.is_income || false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <h3 className="text-sm font-semibold mb-4">
        {category ? 'Edit Category' : 'New Category'}
      </h3>

      <div className="space-y-4">
        {/* Icon + Name */}
        <div className="flex items-start gap-3">
          <div className="relative">
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="w-12 h-12 rounded-xl border border-border/50 flex items-center justify-center text-2xl hover:bg-accent/30 transition-colors"
            >
              {icon}
            </button>
            {showEmojiPicker && (
              <div className="absolute top-14 left-0 z-20 bg-card rounded-xl border border-border/50 p-3 shadow-xl w-64 grid grid-cols-8 gap-1">
                {EMOJI_OPTIONS.map((emoji, i) => (
                  <button
                    key={i}
                    onClick={() => { setIcon(emoji); setShowEmojiPicker(false); }}
                    className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-accent/50 transition-colors text-lg"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Category name"
              className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              autoFocus
            />
          </div>
        </div>

        {/* Color Picker */}
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Color</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={cn(
                  'w-7 h-7 rounded-full transition-all',
                  color === c ? 'ring-2 ring-offset-2 ring-offset-background ring-primary scale-110' : 'hover:scale-110'
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {/* Type Toggle */}
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</label>
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
            <button
              onClick={() => setIsIncome(false)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                !isIncome ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
              )}
            >
              Expense
            </button>
            <button
              onClick={() => setIsIncome(true)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                isIncome ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
              )}
            >
              Income
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={() => {
              if (!name.trim()) { toast.error('Name is required'); return; }
              onSave({ name: name.trim(), icon, color, is_income: isIncome })
            }}
            className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
          >
            <Check className="w-4 h-4" />
            {category ? 'Save' : 'Create'}
          </button>
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'expense' | 'income'>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)

  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.get<Category[]>('/categories')
      setCategories(data)
    } catch (err) {
      console.error('Failed to fetch categories:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCategories()
  }, [fetchCategories])

  // Ensure defaults on first load if empty
  useEffect(() => {
    if (!loading && categories.length === 0) {
      api.post<any>('/categories/ensure-defaults').then((res) => {
        if (res.categories) {
          setCategories(res.categories)
          toast.success(`Created ${res.created} default categories`)
        }
      }).catch(() => {})
    }
  }, [loading, categories.length])

  const handleCreate = async (data: Partial<Category>) => {
    try {
      const res = await api.post<{ category: Category }>('/categories', data)
      setCategories((prev) => [...prev, res.category])
      setShowForm(false)
      toast.success('Category created')
    } catch (err: any) {
      toast.error(err.message || 'Failed to create category')
    }
  }

  const handleUpdate = async (data: Partial<Category>) => {
    if (!editingCategory) return
    try {
      const res = await api.put<{ category: Category }>(`/categories/${editingCategory.id}`, data)
      setCategories((prev) =>
        prev.map((c) => (c.id === editingCategory.id ? res.category : c))
      )
      setEditingCategory(null)
      toast.success('Category updated')
    } catch (err: any) {
      toast.error(err.message || 'Failed to update category')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/categories/${id}`)
      setCategories((prev) => prev.filter((c) => c.id !== id))
      toast.success('Category deleted')
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete category')
    }
  }

  const filtered = categories.filter((cat) => {
    const matchesSearch = !search || cat.name.toLowerCase().includes(search.toLowerCase())
    const matchesFilter = filter === 'all' ||
      (filter === 'income' && cat.is_income) ||
      (filter === 'expense' && !cat.is_income)
    return matchesSearch && matchesFilter
  })

  const expenseCategories = filtered.filter((c) => !c.is_income)
  const incomeCategories = filtered.filter((c) => c.is_income)

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 rounded-lg bg-muted animate-pulse" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Categories"
        description="Manage your transaction categories"
        action={
          <button
            onClick={() => { setShowForm(true); setEditingCategory(null); }}
            className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Category
          </button>
        }
      />

      {/* Search + Filter */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search categories..."
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div className="flex items-center bg-muted/50 rounded-lg p-0.5">
          {(['all', 'expense', 'income'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize',
                filter === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Add/Edit Form */}
      {(showForm || editingCategory) && (
        <div className="mb-6">
          <CategoryForm
            category={editingCategory}
            onSave={editingCategory ? handleUpdate : handleCreate}
            onCancel={() => { setShowForm(false); setEditingCategory(null); }}
          />
        </div>
      )}

      {/* Expense Categories */}
      {expenseCategories.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Expense Categories ({expenseCategories.length})
          </h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {expenseCategories.map((cat) => (
              <div
                key={cat.id}
                className="flex items-center gap-3 px-4 py-3 bg-card rounded-xl border border-border/50 hover:bg-accent/20 transition-colors group"
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                  style={{ backgroundColor: `${cat.color}20` }}
                >
                  {cat.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{cat.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                    <span className="text-[10px] text-muted-foreground uppercase">Expense</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditingCategory(cat); setShowForm(false); }}
                    className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(cat.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Income Categories */}
      {incomeCategories.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Income Categories ({incomeCategories.length})
          </h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {incomeCategories.map((cat) => (
              <div
                key={cat.id}
                className="flex items-center gap-3 px-4 py-3 bg-card rounded-xl border border-border/50 hover:bg-accent/20 transition-colors group"
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                  style={{ backgroundColor: `${cat.color}20` }}
                >
                  {cat.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{cat.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                    <span className="text-[10px] text-muted-foreground uppercase">Income</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditingCategory(cat); setShowForm(false); }}
                    className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(cat.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
          <Tag className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No categories found</p>
          <p className="text-xs text-muted-foreground mt-1">
            {search ? 'Try a different search term' : 'Create your first category to get started'}
          </p>
        </div>
      )}
    </div>
  )
}
