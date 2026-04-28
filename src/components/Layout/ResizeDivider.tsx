import { useCallback, useRef } from "react";

interface ResizeDividerProps {
  onResize: (deltaX: number) => void;
}

export default function ResizeDivider({ onResize }: ResizeDividerProps) {
  const startXRef = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startXRef.current - moveEvent.clientX;
        startXRef.current = moveEvent.clientX;
        onResize(delta);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [onResize]
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-2 cursor-col-resize bg-border-subtle hover:bg-border-default active:bg-brand/30 flex-shrink-0 transition-colors"
    />
  );
}
