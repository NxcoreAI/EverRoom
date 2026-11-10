import { AlertTriangle } from 'lucide-react'
import React from 'react'

import { Button } from './primitives'
import './error-boundary.css'

interface ErrorBoundaryProps {
  /** 出错区域名（标签名/页面名），用于提示与重试 key。 */
  label: string
  children: React.ReactNode
  /** 重置边界时调用（例如切走标签后回来重新挂载子组件）。 */
  resetKey?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 局部错误边界：一个页面/标签渲染崩溃时只显示可重试的错误卡片，
 * 不再把整个应用白屏（Agent/设置/连接器等第三方数据形状异常时保命）。
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 开发期在控制台保留完整堆栈；生产由 Sentry 收集渲染错误。
    console.error(`[workbench] ${this.props.label} 渲染失败`, error, info.componentStack)
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  private retry = () => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="wb-errorboundary" role="alert">
        <div className="wb-errorboundary-card">
          <span className="wb-errorboundary-icon" aria-hidden="true"><AlertTriangle size={18} /></span>
          <div className="wb-errorboundary-text">
            <strong>{this.props.label}暂时无法显示</strong>
            <p>{error.message || '页面渲染时发生未知错误。'}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={this.retry}>重试</Button>
        </div>
      </div>
    )
  }
}
