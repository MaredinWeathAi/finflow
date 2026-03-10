import { useState, useCallback } from 'react'
import { api } from '@/lib/api'
import type { UploadSession } from '@/types'

interface UploadResponse {
  sessionId: string
  status: string
  files: any[]
  totalItems: number
  duplicateItems: number
  uncategorizedItems: number
  duplicates: any[]
}

export function useUpload() {
  const [sessions, setSessions] = useState<UploadSession[]>([])
  const [currentSession, setCurrentSession] = useState<UploadSession | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.get<UploadSession[]>('/upload/sessions')
      setSessions(res)
    } catch (err: any) {
      console.error('Failed to fetch upload sessions:', err)
      setError(err.message || 'Failed to fetch sessions')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchSession = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.get<UploadSession>(`/upload/sessions/${id}`)
      setCurrentSession(res)
      return res
    } catch (err: any) {
      console.error('Failed to fetch session:', err)
      setError(err.message || 'Failed to fetch session')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  const uploadFiles = useCallback(async (files: File[]) => {
    setIsUploading(true)
    setError(null)
    try {
      const formData = new FormData()
      files.forEach((file) => formData.append('files', file))
      const res = await api.upload<UploadResponse>('/upload', formData)
      // Refresh sessions list after upload
      await fetchSessions()
      // Load the new session
      if (res.sessionId) {
        await fetchSession(res.sessionId)
      }
      return res
    } catch (err: any) {
      console.error('Failed to upload files:', err)
      setError(err.message || 'Upload failed')
      return null
    } finally {
      setIsUploading(false)
    }
  }, [fetchSessions, fetchSession])

  const updateItem = useCallback(async (id: string, updates: Record<string, any>) => {
    setError(null)
    try {
      await api.put(`/upload/items/${id}`, updates)
      // Refresh current session to reflect changes
      if (currentSession?.id) {
        await fetchSession(currentSession.id)
      }
    } catch (err: any) {
      console.error('Failed to update item:', err)
      setError(err.message || 'Failed to update item')
    }
  }, [currentSession?.id, fetchSession])

  const importSession = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; imported: number }>(`/upload/sessions/${id}/import`)
      await fetchSessions()
      await fetchSession(id)
      return res
    } catch (err: any) {
      console.error('Failed to import session:', err)
      setError(err.message || 'Failed to import session')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [fetchSessions, fetchSession])

  const importAll = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; imported: number }>(`/upload/sessions/${id}/import`, { importAll: true })
      await fetchSessions()
      await fetchSession(id)
      return res
    } catch (err: any) {
      console.error('Failed to import all:', err)
      setError(err.message || 'Failed to import all')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [fetchSessions, fetchSession])

  const deleteSession = useCallback(async (id: string) => {
    setError(null)
    try {
      await api.delete(`/upload/sessions/${id}`)
      setCurrentSession(null)
      await fetchSessions()
    } catch (err: any) {
      console.error('Failed to delete session:', err)
      setError(err.message || 'Failed to delete session')
    }
  }, [fetchSessions])

  return {
    sessions,
    currentSession,
    uploadFiles,
    fetchSessions,
    fetchSession,
    updateItem,
    importSession,
    importAll,
    deleteSession,
    isUploading,
    isLoading,
    error,
    refetch: fetchSessions,
  }
}
