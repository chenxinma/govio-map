import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Search, X } from 'lucide-react';
import { useCanvasStore } from '../../store/canvas-store';
import type { CanvasNodeData } from '../../types';

export default function NodeFindBar() {
  const nodes = useCanvasStore((s) => s.nodes);
  const { getNode, setCenter, getZoom } = useReactFlow();
  const [query, setQuery] = useState('');
  const [viewIndex, setViewIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as string[];
    return nodes
      .filter((n) => {
        const d = n.data as unknown as CanvasNodeData;
        return d.title?.toLowerCase().includes(q);
      })
      .map((n) => n.id);
  }, [query, nodes]);

  // Reset navigation when the query changes
  useEffect(() => {
    setViewIndex(-1);
  }, [query]);

  // Keep view index in range if matches shrink (e.g. a node was deleted)
  useEffect(() => {
    if (viewIndex >= matches.length) setViewIndex(-1);
  }, [matches.length, viewIndex]);

  const centerOn = useCallback(
    (id: string) => {
      const node = getNode(id);
      if (!node) return;
      const w = node.measured?.width ?? node.width ?? 0;
      const h = node.measured?.height ?? node.height ?? 0;
      const pos = node.position;
      const x = pos.x + w / 2;
      const y = pos.y + h / 2;
      const zoom = Math.max(getZoom(), 1);
      setCenter(x, y, { zoom, duration: 400 });
    },
    [getNode, setCenter, getZoom]
  );

  const handleEnter = useCallback(() => {
    if (matches.length === 0) return;
    const next = viewIndex === -1 ? 0 : (viewIndex + 1) % matches.length;
    setViewIndex(next);
    centerOn(matches[next]);
  }, [matches, viewIndex, centerOn]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleEnter();
      } else if (e.key === 'Escape') {
        setQuery('');
        inputRef.current?.blur();
      }
    },
    [handleEnter]
  );

  const clear = useCallback(() => {
    setQuery('');
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();
  const counter = (() => {
    if (matches.length === 0) return trimmed ? '无匹配' : '';
    return viewIndex === -1 ? `${matches.length} 个匹配` : `${viewIndex + 1} / ${matches.length}`;
  })();

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-lg bg-bg-surface border border-border-default">
      <Search size={14} className="text-text-muted shrink-0" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="查找节点…"
        className="w-40 bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none"
      />
      {counter && (
        <span className="text-xs text-text-secondary tabular-nums whitespace-nowrap">{counter}</span>
      )}
      {trimmed && (
        <button
          onClick={clear}
          className="p-1 rounded-md text-text-muted hover:bg-bg-primary hover:text-text-primary transition-colors"
          title="清除"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
