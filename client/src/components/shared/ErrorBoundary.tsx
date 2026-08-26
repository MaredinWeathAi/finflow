import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

/**
 * Contains a render error to the page that threw it.
 *
 * There was no error boundary anywhere in the app, which meant a single bad
 * field name on one screen unmounted the entire React root: the Reports tab
 * read `summary.savings_rate` where the API sends `savingsRate`, threw on
 * `undefined.toFixed()`, and took the whole application to a white screen with
 * no way back except a reload.
 *
 * A money app should never silently show nothing. If a screen cannot render,
 * say so, keep the rest of the app alive, and offer a way out.
 */
interface Props {
  children: ReactNode
  /** Shown in the message so the user knows which screen failed. */
  name?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error', this.props.name ?? '', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="bg-card rounded-2xl border border-danger/30 p-8 max-w-2xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div className="flex-1">
            <h2 className="text-base font-semibold">
              {this.props.name ? `${this.props.name} couldn't load` : "This page couldn't load"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1.5">
              Something went wrong rendering this screen. Your data is safe and the rest of the
              app still works — use the sidebar to go somewhere else, or try again.
            </p>
            <pre className="mt-4 p-3 rounded-lg bg-muted text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
              {error.message}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-2"
            >
              <RotateCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
