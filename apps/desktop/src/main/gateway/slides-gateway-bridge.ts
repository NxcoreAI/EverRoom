import type { GatewaySupervisor } from './gateway-supervisor'
import type { SlidesPageImagesStatus } from '../../shared/slides'

/** slides 配图会话轮询桥：过目卡在后台逐张生成期间拉最新快照。 */
export class SlidesGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  async pageImagesStatus(documentId: string): Promise<SlidesPageImagesStatus | null> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(
      `${connection.baseUrl}/v1/slides/page-images/${encodeURIComponent(documentId)}`,
      { headers: { Authorization: `Bearer ${connection.token}` } },
    )
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`slides 请求失败（${response.status}）`)
    return response.json() as Promise<SlidesPageImagesStatus>
  }
}
