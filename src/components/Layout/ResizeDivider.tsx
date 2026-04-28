import { useCallback, useRef } from 'react';

interface ResizeDividerProps {
  onResize: (deltaX: number) => void;
}

export default function ResizeDivider({ onResize }: ResizeDividerProps) {
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current) {
        onResize(e.movementX);
      }
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onResize]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/50 transition-colors flex-shrink-0"
    />
  );
}
