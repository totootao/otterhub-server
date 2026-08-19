"use client";

import { GlobalAudioPlayer } from "./GlobalAudioPlayer";
import { GlobalVideoPlayer } from "./GlobalVideoPlayer";
import { GlobalTextReader } from "./GlobalTextReader";

export function GlobalPreviewLayer() {
  return (
    <>
      <GlobalAudioPlayer />
      <GlobalVideoPlayer />
      <GlobalTextReader />
    </>
  );
}
