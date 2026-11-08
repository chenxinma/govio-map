import { Panel } from '@xyflow/react';
import type { LineageKind } from '../../types';
import { lineageEdgeAppearance } from '../../utils/lineage';

const KINDS: LineageKind[] = ['data', 'semantic'];

/** 画布角落的血缘图例（T2.2）：说明数据血缘与语义血缘两种边的线型/色相区分 */
export default function LineageLegend() {
  return (
    <Panel
      position="top-left"
      className="!bg-bg-primary/95 !border-border-default !rounded-lg !shadow-sm px-3 py-2"
    >
      <div className="text-[11px] font-medium text-text-muted mb-1.5">血缘图例</div>
      <div className="flex flex-col gap-1.5">
        {KINDS.map((kind) => {
          const ap = lineageEdgeAppearance(kind);
          return (
            <div key={kind} className="flex items-center gap-2">
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 24,
                  borderTop: `2px ${ap.strokeDasharray ? 'dashed' : 'solid'} ${ap.stroke}`,
                }}
              />
              <span className="text-[11px] text-text-secondary">{ap.label}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
