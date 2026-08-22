import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Small anchored dropdown: renders below an anchor element via portal +
// position:fixed so it escapes overflow/transform clipping (e.g. scrolling
// planner cards), clamped horizontally to the viewport. Closes on
// outside-click / scroll / resize.
// ponytail: no vertical flip by default — relies on the child's own
// max-height to scroll near the bottom. Pass `flip` for anchors that can sit
// at the bottom of the viewport (e.g. a sidebar footer control), which
// measures the rendered popover after mount and flips it above the anchor
// if it would otherwise overflow.
export function AnchoredPopover({
  anchorRef, width, onClose, className, style, children, flip = false,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  width: number;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  flip?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [flipChecked, setFlipChecked] = useState(false);

  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
    if (left < 8) left = 8;
    setPos({ top: r.bottom + 4, left });
    setFlipChecked(false);
  }, [anchorRef, width]);

  // Second pass: once the popover has actually rendered (so its real height
  // is known), flip it above the anchor if it overflows the viewport bottom.
  useLayoutEffect(() => {
    if (!flip || !pos || flipChecked || !ref.current) return;
    const a = anchorRef.current;
    if (a) {
      const height = ref.current.offsetHeight;
      if (pos.top + height > window.innerHeight - 8) {
        const r = a.getBoundingClientRect();
        setPos((p) => (p ? { ...p, top: Math.max(8, r.top - height - 4) } : p));
      }
    }
    setFlipChecked(true);
  }, [flip, pos, flipChecked, anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose, anchorRef]);

  if (!pos) return null;
  return createPortal(
    <div ref={ref} className={className} style={{ position: 'fixed', top: pos.top, left: pos.left, width, ...style }}>
      {children}
    </div>,
    document.body,
  );
}
