import type { Page } from "patchright";

export interface PresentedVideoFrame {
  pixels: number[][];
  mediaTime: number;
  presentedFrames: number;
  width: number;
  height: number;
  sourcePath: string;
  sourceRevision: string | null;
}

/** Capture inside the browser's presentation callback, rather than treating
 * HAVE_CURRENT_DATA as proof that a decoded frame has reached the compositor.
 * Expected colors are deliberately not part of readiness or retry logic. */
export async function presentedVideoFrame(
  page: Page,
  selector: string,
  expectedSource: string,
  play: () => Promise<unknown>,
  capture = { width: 32, height: 18, points: [[16, 9]] },
): Promise<PresentedVideoFrame> {
  const key = "studio-frame-" + Math.random().toString(36).slice(2);
  await page.evaluate(
    ({ selector, key, expectedSource, capture }) => {
      const video = document.querySelector(selector) as HTMLVideoElement | null;
      if (!video) throw new Error("Preview video is absent");
      const state = window as unknown as Record<string, unknown>;
      let cancel: () => void = () => {};
      const promise = new Promise<PresentedVideoFrame>((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(
          () => fail(new Error("Preview presented no frame within 10 seconds")),
          10000,
        );
        let callback = 0;
        const cleanup = () => {
          clearTimeout(timer);
          video.cancelVideoFrameCallback(callback);
          video.pause();
        };
        const fail = (error: Error) => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(error);
        };
        cancel = () => fail(new Error("Preview frame capture cancelled"));
        callback = video.requestVideoFrameCallback((_time, metadata) => {
          if (finished) return;
          try {
            if (video.currentSrc !== expectedSource)
              throw new Error(
                "Preview source changed before frame presentation",
              );
            const canvas = document.createElement("canvas");
            canvas.width = capture.width;
            canvas.height = capture.height;
            const context = canvas.getContext("2d", {
              willReadFrequently: true,
            });
            if (!context) throw new Error("Preview capture has no 2D context");
            context.drawImage(video, 0, 0, capture.width, capture.height);
            const source = new URL(video.currentSrc);
            const frame = {
              pixels: capture.points.map(([x, y]) =>
                Array.from(context.getImageData(x!, y!, 1, 1).data),
              ),
              mediaTime: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              width: metadata.width,
              height: metadata.height,
              sourcePath: source.pathname,
              sourceRevision: source.searchParams.get("revision"),
            };
            finished = true;
            cleanup();
            resolve(frame);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      // A stalled click must not cause an unhandled browser rejection while the
      // caller is still executing the action; awaiting the original still fails.
      void promise.catch(() => {});
      state[key] = { promise, cancel };
    },
    { selector, key, expectedSource, capture },
    false,
  );
  try {
    await play();
    return await page.evaluate(
      async (key) =>
        await (
          window as unknown as Record<
            string,
            { promise: Promise<PresentedVideoFrame> }
          >
        )[key]!.promise,
      key,
      false,
    );
  } finally {
    await page
      .evaluate(
        (key) => {
          const state = window as unknown as Record<string, { cancel(): void }>;
          state[key]?.cancel();
          delete state[key];
        },
        key,
        false,
      )
      .catch(() => undefined);
  }
}
