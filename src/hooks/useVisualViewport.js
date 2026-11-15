import { useEffect, useState } from 'react';

// Tracks the visual viewport (the area actually visible above the mobile
// keyboard) so layouts can resize instead of being scrolled out of view.
export function useVisualViewport() {
  const [height, setHeight] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight : 0,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return undefined;
    const vv = window.visualViewport;
    const update = () => setHeight(Math.round(vv.height));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return height;
}