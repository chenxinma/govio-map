import { Component, useEffect, type ReactNode } from 'react';
import AppLayout from './components/Layout/AppLayout';
import { useCanvasStore } from './store/canvas-store';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-screen flex items-center justify-center bg-bg-canvas text-text-primary">
          <div className="text-center">
            <p className="text-lg mb-2">渲染错误</p>
            <p className="text-sm text-text-muted mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-brand/10 border border-brand-border rounded-lg text-brand hover:bg-brand/20"
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  useEffect(() => {
    useCanvasStore.getState().subscribeToCanvas();
  }, []);

  return (
    <ErrorBoundary>
      <AppLayout />
    </ErrorBoundary>
  );
}
