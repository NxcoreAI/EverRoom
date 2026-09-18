import { Crosshair, Maximize, Minus, Plus } from 'lucide-react';

import { useLocale } from '../../../../../i18n/LocaleContext';

export interface CanvasToolActions {
  zoomBy: (factor: number) => void;
  fitAll: () => void;
  recenter: () => void;
}

/** 画布右上角悬浮操作：缩小/放大/自适应/回中心（相机能力由宿主画布注入）。 */
export function GraphCanvasTools({ actions }: { actions: CanvasToolActions }) {
  const { t } = useLocale();
  const items: Array<[string, typeof Minus, () => void]> = [
    ['contextRoom:emergence.canvasZoomOut', Minus, () => actions.zoomBy(1 / 1.25)],
    ['contextRoom:emergence.canvasZoomIn', Plus, () => actions.zoomBy(1.25)],
    ['contextRoom:emergence.canvasFit', Maximize, actions.fitAll],
    ['contextRoom:emergence.canvasRecenter', Crosshair, actions.recenter],
  ];
  return (
    <div className="eg-canvas-tools">
      {items.map(([key, Icon, onClick]) => (
        <button key={key} type="button" title={t(key)} aria-label={t(key)} onClick={onClick}>
          <Icon aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
