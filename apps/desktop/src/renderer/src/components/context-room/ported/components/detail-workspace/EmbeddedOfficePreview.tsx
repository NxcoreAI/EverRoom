import { useEffect, useRef, useState } from 'react'

import { KnowledgeFileExternalCard } from '../detail-panels/KnowledgeFileExternalCard'
import { releaseEmbeddedOffice, setEmbeddedOffice } from '../../embeddedOffice'
import { attachOfficeViewport, type OfficeViewportAttachment } from '../../officeViewport'
import type { ContextRoomKnowledgeFileResource, ContextRoomRecord } from '../../types'

/**
 * Room 右区内嵌的 Office 只读预览宿主（替换云文档的编辑栏位置）。
 * 真正的文档是主进程 WebContentsView 叠在窗口上：这里只渲染占位 div，
 * 挂载时经 files.openOriginal 取实例并登记进 embeddedOffice 仲裁，
 * 矩形上报与弹层遮挡显隐交给 officeViewport（激活由 App 统一裁决）。
 */
export function EmbeddedOfficePreview({
  room,
  resource,
}: {
  room: ContextRoomRecord
  resource: ContextRoomKnowledgeFileResource
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    const office = window.nxcore?.office
    const files = window.nxcore?.files
    if (!host || !office || !files) {
      setFailed(true)
      return
    }
    let disposed = false
    let registered = false
    let attachment: OfficeViewportAttachment | null = null
    // 产物编辑：docx/pptx/xlsx 传 editable（主进程注册表据此建可编辑视图并把保存回填版本链）；
    // 其余格式（pdf、legacy .doc/.ppt/.xls）仍只读预览。
    const editable = /\.(docx|pptx|xlsx)$/.test(resource.originalName.toLowerCase())
    void files.openOriginal(
      resource.fileId,
      resource.originalName,
      undefined,
      editable ? { editable: true, roomId: room.id } : undefined,
    )
      .then((result) => {
        if (disposed) return
        if (result?.openedWith !== 'office') {
          setFailed(true)
          return
        }
        registered = true
        setEmbeddedOffice({ roomId: room.id, fileId: resource.fileId, instanceId: result.instanceId })
        attachment = attachOfficeViewport(host)
      })
      .catch((error) => {
        console.error('Failed to open the embedded Office preview.', error)
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
      // 先发零尺寸当帧隐藏原生视图，再让出激活权：App 仲裁的 IPC 慢一步到达。
      attachment?.detach()
      if (registered) releaseEmbeddedOffice(resource.fileId)
    }
  }, [room.id, resource.fileId, resource.originalName])

  if (failed) return <KnowledgeFileExternalCard resource={resource} />
  return (
    <div
      ref={hostRef}
      className="context-room-embedded-office-host"
      data-office-file-id={resource.fileId}
    />
  )
}
