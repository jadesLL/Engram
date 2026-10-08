/** Collapse high-frequency pointer/wheel events into one paint per display frame. */
export function createGraphFrame(
  paint: (planLabels: boolean) => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let frame: number | null = null;
  let labels = false;
  return {
    schedule(planLabels = false) {
      labels ||= planLabels;
      if (frame !== null) return;
      frame = request(() => {
        frame = null;
        const replan = labels;
        labels = false;
        paint(replan);
      });
    },
    cancel() {
      if (frame !== null) cancel(frame);
      frame = null;
      labels = false;
    },
  };
}
