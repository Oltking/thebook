import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown instead of the default panel, if given. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render-time throw and shows a recoverable panel instead of unmounting
 * the tree to a blank page.
 *
 * The app had no boundary anywhere, so a single bad value on the order-entry path
 * blanked the whole interface — including, notably, any resting orders the user
 * might have wanted to cancel (audit M-01). The input that caused it is fixed in
 * `units.ts`, but the boundary is what makes the next one survivable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return <>{this.props.fallback}</>;

    return (
      <div
        role="alert"
        style={{
          margin: '24px auto',
          maxWidth: 560,
          padding: 24,
          borderRadius: 14,
          border: '1px solid var(--border, #2a2f3a)',
          background: 'var(--bg-panel, #14171f)',
          color: 'var(--text-primary, #e6e8ee)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Something went wrong on this screen</h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-secondary, #98a1b3)', lineHeight: 1.5 }}>
          Your funds are not affected — nothing here holds them. Your balances, resting orders and
          claims live on chain and are unchanged.
        </p>
        <pre
          style={{
            margin: '0 0 16px',
            padding: 12,
            borderRadius: 10,
            overflowX: 'auto',
            fontSize: 12,
            background: 'var(--bg-elev, #0e1117)',
            color: 'var(--text-secondary, #98a1b3)',
          }}
        >
          {error.message}
        </pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={this.reset} style={btn}>Try again</button>
          <button type="button" onClick={() => window.location.reload()} style={btn}>Reload the app</button>
        </div>
      </div>
    );
  }
}

const btn: React.CSSProperties = {
  padding: '9px 16px',
  borderRadius: 10,
  border: '1px solid var(--border, #2a2f3a)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
};
