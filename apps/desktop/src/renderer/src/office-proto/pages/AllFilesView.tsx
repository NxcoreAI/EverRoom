import React, { useEffect, useState } from 'react'

import { type OfficeFile, fetchRealFiles, files, type RealOfficeFile } from '../data'
import { FileTable, PageHead } from './parts'

/** 所有文件：有真实文件库时显示真实文件（点开进标签页，由编辑页走内置 Office 预览），
 *  无桥/为空时回退原型 mock 列表。 */
export function AllFilesView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [real, setReal] = useState<RealOfficeFile[] | null>(null)
  // 文件库全量计数（total 不受 list limit 影响）；无桥/失败为 null，回退 mock 列表长度。
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchRealFiles().then((result) => {
      if (cancelled || !result) return
      setReal(result.items)
      setTotal(result.total)
    })
    return () => { cancelled = true }
  }, [])

  const shown = real && real.length > 0 ? real.map((x) => x.file) : files
  const hint = total !== null && total > 0 ? `共 ${total} 个文件` : `共 ${shown.length} 个文件`
  return (
    <>
      <PageHead title="所有文件" hint={hint} />
      <FileTable files={shown} onOpenFile={onOpenFile} onToast={onToast} />
    </>
  )
}
