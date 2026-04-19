import { useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '../../store/canvas-store';
import { nodeTypes } from '../Nodes';
import FloatingPreviewPanel from './FloatingPreviewPanel';

export default function Canvas() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const previewPanels = useCanvasStore((s) => s.previewPanels);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const tableName = event.dataTransfer.getData('application/reactflow');
      if (!tableName) return;
      useCanvasStore.getState().addSourceTableToCanvas(tableName);
    },
    []
  );

  return (
    <div ref={reactFlowWrapper} className="relative w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={2}
        snapToGrid
        snapGrid={[15, 15]}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: true,
          style: { stroke: '#3ecf8e', strokeWidth: 2 },
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2e2e2e" />
        <Controls
          showInteractive={false}
          className="!bg-bg-surface !border-border-default !rounded-lg"
        />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case 'sourceTable': return 'hsl(270, 60%, 60%)';
              case 'sqlQuery': return 'hsl(152, 58%, 52%)';
              case 'dataFrame': return 'hsl(25, 75%, 55%)';
              case 'report': return 'hsl(270, 60%, 70%)';
              default: return '#898989';
            }
          }}
          maskColor="rgba(23, 23, 23, 0.8)"
          className="!bg-bg-primary !border-border-default !rounded-lg"
        />
      </ReactFlow>

      {previewPanels.map((panel) => (
        <FloatingPreviewPanel key={panel.id} panel={panel} />
      ))}
    </div>
  );
}
