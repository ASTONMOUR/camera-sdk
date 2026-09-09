// Camera control: open the stream, hand frames to the analyser, take the still.
//
// Two canvases on purpose. The analysis canvas is small and fixed (grabbing
// 1080p pixels 25 times a second is what makes browser camera apps stutter);
// the still canvas is full sensor resolution and is only touched when a capture
// actually fires. Nothing here decides *when* to capture — that is the
// automaton's job.

const ANALYSIS_WIDTH = 480;
const JPEG_QUALITY = 0.94;

export function createCamera(videoEl) {
  let stream = null;
  let analysisCanvas = null;
  let analysisCtx = null;
  let facing = "environment";

  async function start({ facingMode = "environment" } = {}) {
    await stop();
    facing = facingMode;
    // Ask for the best the device will give; browsers silently downscale rather
    // than failing, so these are targets and not requirements.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    // Safari resolves play() before metadata on a cold start; without this the
    // first few grabs read a 0x0 video and every frame looks empty.
    if (!videoEl.videoWidth) {
      await new Promise((resolve) => {
        videoEl.addEventListener("loadedmetadata", resolve, { once: true });
      });
    }

    analysisCanvas = document.createElement("canvas");
    sizeAnalysisCanvas();
    return { width: videoEl.videoWidth, height: videoEl.videoHeight, facingMode: facing };
  }

  function sizeAnalysisCanvas() {
    const ratio = videoEl.videoHeight / Math.max(1, videoEl.videoWidth);
    analysisCanvas.width = ANALYSIS_WIDTH;
    analysisCanvas.height = Math.max(1, Math.round(ANALYSIS_WIDTH * ratio));
    analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });
  }

  // One downscaled RGBA frame for the worker. Returns null when the video is
  // not producing pixels yet.
  function grab() {
    if (!analysisCtx || !videoEl.videoWidth) return null;
    if (analysisCanvas.height !== Math.round(ANALYSIS_WIDTH * (videoEl.videoHeight / videoEl.videoWidth))) {
      sizeAnalysisCanvas();
    }
    analysisCtx.drawImage(videoEl, 0, 0, analysisCanvas.width, analysisCanvas.height);
    const data = analysisCtx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
    return { rgba: data.data, width: data.width, height: data.height };
  }

  // Full-resolution still as a JPEG data URL — what actually gets uploaded.
  async function still() {
    if (!videoEl.videoWidth) throw new Error("camera is not streaming");
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  async function stop() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  async function flip() {
    return start({ facingMode: facing === "environment" ? "user" : "environment" });
  }

  return { start, stop, grab, still, flip, get facingMode() { return facing; } };
}
