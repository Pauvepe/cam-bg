"use client";

import { useRef, useState, useEffect, useCallback } from "react";

interface SegmentationResult {
  confidenceMasks?: Array<{ getAsFloat32Array(): Float32Array }>;
}

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [bgRemoval, setBgRemoval] = useState(false);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  // zoom < 1 = dezoom (person appears smaller, more "far away")
  // zoom = 1 = default fill
  // zoom > 1 = zoom in
  const [zoom, setZoom] = useState(0.75);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [segmenter, setSegmenter] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);

  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const pinchStartDist = useRef<number>(0);
  const pinchStartZoom = useRef<number>(0.75);

  const MIN_ZOOM = 0.25; // Very far - person is small
  const MAX_ZOOM = 3.0;
  const DEFAULT_ZOOM = 0.75; // Start a bit dezoomed like native camera

  // Load MediaPipe segmenter
  const loadSegmenter = useCallback(async () => {
    try {
      setLoadingMsg("Cargando modelo IA...");
      const vision = await import("@mediapipe/tasks-vision");
      const { ImageSegmenter, FilesetResolver } = vision;

      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );

      const seg = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });

      setSegmenter(seg);
      setLoadingMsg("");
      return seg;
    } catch (e) {
      console.error("Segmenter error:", e);
      setError("Error cargando segmentación");
      setLoadingMsg("");
      return null;
    }
  }, []);

  // Start camera
  const startCamera = useCallback(
    async (facing: "user" | "environment" = facingMode) => {
      try {
        setLoading(true);
        setLoadingMsg("Accediendo a la cámara...");
        setError(null);

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }

        // Request highest resolution possible for more dezoom headroom
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: facing,
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });

        streamRef.current = stream;

        // Try to set hardware zoom to minimum (widest angle)
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities?.() as any;
        if (caps?.zoom) {
          try {
            await track.applyConstraints({
              advanced: [{ zoom: caps.zoom.min } as any],
            });
          } catch {}
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setStarted(true);
        setLoading(false);
        setLoadingMsg("");
      } catch (e: any) {
        setError("No se puede acceder a la cámara: " + e.message);
        setLoading(false);
        setLoadingMsg("");
      }
    },
    [facingMode]
  );

  // Render loop - draws camera to output canvas with zoom applied
  useEffect(() => {
    if (!started || !videoRef.current || !outputRef.current) return;

    const video = videoRef.current;
    const output = outputRef.current;
    const outCtx = output.getContext("2d")!;
    const procCanvas = canvasRef.current!;
    const procCtx = procCanvas.getContext("2d", { willReadFrequently: true })!;
    const bgCanvas = bgCanvasRef.current!;
    const bgCtx = bgCanvas.getContext("2d")!;

    let lastSegTime = 0;
    let currentMask: Float32Array | null = null;

    const render = (timestamp: number) => {
      if (!video.videoWidth || !video.videoHeight) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;

      // Processing canvas = video resolution
      procCanvas.width = vw;
      procCanvas.height = vh;

      // Output canvas = screen size
      const rect = output.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      output.width = rect.width * dpr;
      output.height = rect.height * dpr;

      // --- SEGMENTATION ---
      if (bgRemoval && segmenter) {
        if (timestamp - lastSegTime > 40) {
          // ~25fps
          lastSegTime = timestamp;
          try {
            segmenter.segmentForVideo(video, timestamp, (result: SegmentationResult) => {
              if (result.confidenceMasks?.[0]) {
                currentMask = result.confidenceMasks[0].getAsFloat32Array();
              }
            });
          } catch {}
        }

        // Draw video to processing canvas
        procCtx.drawImage(video, 0, 0);

        if (currentMask) {
          const frame = procCtx.getImageData(0, 0, vw, vh);
          const data = frame.data;

          if (bgImage) {
            // Draw bg to bgCanvas
            bgCanvas.width = vw;
            bgCanvas.height = vh;
            const imgR = bgImage.width / bgImage.height;
            const canR = vw / vh;
            let sx = 0, sy = 0, sw = bgImage.width, sh = bgImage.height;
            if (imgR > canR) {
              sw = bgImage.height * canR;
              sx = (bgImage.width - sw) / 2;
            } else {
              sh = bgImage.width / canR;
              sy = (bgImage.height - sh) / 2;
            }
            bgCtx.drawImage(bgImage, sx, sy, sw, sh, 0, 0, vw, vh);
            const bgData = bgCtx.getImageData(0, 0, vw, vh).data;

            for (let i = 0; i < currentMask.length; i++) {
              const c = currentMask[i];
              const p = i * 4;
              if (c < 0.5) {
                data[p] = bgData[p];
                data[p + 1] = bgData[p + 1];
                data[p + 2] = bgData[p + 2];
              } else if (c < 0.75) {
                const t = (c - 0.5) / 0.25;
                data[p] = Math.round(data[p] * t + bgData[p] * (1 - t));
                data[p + 1] = Math.round(data[p + 1] * t + bgData[p + 1] * (1 - t));
                data[p + 2] = Math.round(data[p + 2] * t + bgData[p + 2] * (1 - t));
              }
            }
          } else {
            // No bg - transparent/dark background
            for (let i = 0; i < currentMask.length; i++) {
              const c = currentMask[i];
              const p = i * 4;
              if (c < 0.5) {
                data[p] = 20; data[p + 1] = 20; data[p + 2] = 20;
              } else if (c < 0.75) {
                const t = (c - 0.5) / 0.25;
                data[p] = Math.round(data[p] * t + 20 * (1 - t));
                data[p + 1] = Math.round(data[p + 1] * t + 20 * (1 - t));
                data[p + 2] = Math.round(data[p + 2] * t + 20 * (1 - t));
              }
            }
          }
          procCtx.putImageData(frame, 0, 0);
        }
      } else {
        procCtx.drawImage(video, 0, 0);
      }

      // --- DRAW TO OUTPUT with ZOOM ---
      // zoom=1 means video covers full output (cover-fit)
      // zoom<1 means video is smaller (dezoomed, shows borders)
      // zoom>1 means video is bigger (zoomed in, crops edges)
      outCtx.fillStyle = "#111";
      outCtx.fillRect(0, 0, output.width, output.height);

      // If bg removal with bg image and zoom < 1, draw bg behind
      if (bgRemoval && bgImage && zoom < 1) {
        const imgR = bgImage.width / bgImage.height;
        const canR = output.width / output.height;
        let dx = 0, dy = 0, dw = output.width, dh = output.height;
        if (imgR > canR) {
          dh = output.height;
          dw = dh * imgR;
          dx = (output.width - dw) / 2;
        } else {
          dw = output.width;
          dh = dw / imgR;
          dy = (output.height - dh) / 2;
        }
        outCtx.drawImage(bgImage, dx, dy, dw, dh);
      }

      // Cover-fit the processed video into output, then apply zoom
      const videoRatio = vw / vh;
      const outputRatio = output.width / output.height;
      let drawW: number, drawH: number;
      if (videoRatio > outputRatio) {
        // Video wider - fit by height
        drawH = output.height;
        drawW = drawH * videoRatio;
      } else {
        // Video taller - fit by width
        drawW = output.width;
        drawH = drawW / videoRatio;
      }

      // Apply zoom
      drawW *= zoom;
      drawH *= zoom;

      const drawX = (output.width - drawW) / 2;
      const drawY = (output.height - drawH) / 2;

      // Mirror for front camera
      outCtx.save();
      if (facingMode === "user") {
        outCtx.translate(output.width, 0);
        outCtx.scale(-1, 1);
        outCtx.drawImage(procCanvas, output.width - drawX - drawW, drawY, drawW, drawH);
      } else {
        outCtx.drawImage(procCanvas, drawX, drawY, drawW, drawH);
      }
      outCtx.restore();

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [started, bgRemoval, segmenter, bgImage, zoom, facingMode]);

  // Pinch to zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoom.current = zoom;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / pinchStartDist.current;
        setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom.current * scale)));
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [zoom]);

  // Mouse wheel zoom (desktop)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const toggleBgRemoval = useCallback(async () => {
    if (!bgRemoval && !segmenter) {
      setLoading(true);
      const seg = await loadSegmenter();
      setLoading(false);
      if (seg) setBgRemoval(true);
    } else {
      setBgRemoval(!bgRemoval);
    }
  }, [bgRemoval, segmenter, loadSegmenter]);

  const pickBgImage = () => fileInputRef.current?.click();

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setBgImage(img);
      setBgUrl(url);
      if (!bgRemoval) toggleBgRemoval();
    };
    img.src = url;
    e.target.value = "";
  };

  const takePhoto = () => {
    if (!outputRef.current) return;
    setCapturedPhoto(outputRef.current.toDataURL("image/png"));
  };

  const savePhoto = () => {
    if (!capturedPhoto) return;
    const a = document.createElement("a");
    a.href = capturedPhoto;
    a.download = `cambg-${Date.now()}.png`;
    a.click();
  };

  const switchCamera = async () => {
    const f = facingMode === "user" ? "environment" : "user";
    setFacingMode(f);
    await startCamera(f);
  };

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // --- START SCREEN ---
  if (!started) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh bg-black text-white gap-6 p-8">
        <div className="text-5xl font-bold tracking-tight">CamBG</div>
        <p className="text-white/40 text-center text-sm max-w-xs">
          Quita el fondo, pon la imagen que quieras, haz zoom o aléjate
        </p>
        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
        <button
          onClick={() => startCamera()}
          disabled={loading}
          className="bg-white text-black font-semibold px-8 py-4 rounded-2xl text-lg active:scale-95 transition-transform disabled:opacity-50"
        >
          {loading ? "Iniciando..." : "Abrir Cámara"}
        </button>
      </div>
    );
  }

  // --- PHOTO PREVIEW ---
  if (capturedPhoto) {
    return (
      <div className="flex flex-col h-dvh bg-black">
        <div className="flex-1 flex items-center justify-center p-4">
          <img src={capturedPhoto} alt="Foto" className="max-w-full max-h-full object-contain rounded-2xl" />
        </div>
        <div className="flex gap-4 justify-center pb-8 pt-4">
          <button
            onClick={() => setCapturedPhoto(null)}
            className="bg-white/10 text-white px-6 py-3 rounded-xl font-medium active:scale-95 transition-transform"
          >
            Volver
          </button>
          <button onClick={savePhoto} className="bg-white text-black px-6 py-3 rounded-xl font-medium active:scale-95 transition-transform">
            Guardar
          </button>
        </div>
      </div>
    );
  }

  // --- CAMERA VIEW ---
  return (
    <div ref={containerRef} className="relative h-dvh bg-black overflow-hidden" onClick={() => setShowControls((s) => !s)}>
      {/* Off-screen elements - video MUST NOT be display:none or browser won't decode frames */}
      <video ref={videoRef} playsInline muted autoPlay className="absolute w-1 h-1 opacity-0 pointer-events-none" style={{ top: -9999 }} />
      <canvas ref={canvasRef} className="absolute w-0 h-0 opacity-0 pointer-events-none" style={{ top: -9999 }} />
      <canvas ref={bgCanvasRef} className="absolute w-0 h-0 opacity-0 pointer-events-none" style={{ top: -9999 }} />
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

      {/* Output canvas - full screen */}
      <canvas ref={outputRef} className="absolute inset-0 w-full h-full" />

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
            <span className="text-white/60 text-sm">{loadingMsg || "Cargando..."}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-4 left-4 right-4 bg-red-500/80 text-white text-sm p-3 rounded-xl z-50">{error}</div>
      )}

      {showControls && (
        <>
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 pt-[env(safe-area-inset-top)] bg-gradient-to-b from-black/60 to-transparent z-10">
            <div className="flex items-center justify-between px-4 py-3">
              <button
                onClick={(e) => { e.stopPropagation(); switchCamera(); }}
                className="w-11 h-11 flex items-center justify-center rounded-full bg-white/15 active:bg-white/30"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                  <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                  <path d="m16 3-3 3 3 3" />
                  <path d="m8 21 3-3-3-3" />
                </svg>
              </button>

              <div className="flex gap-2">
                {bgUrl && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setBgImage(null); setBgUrl(null); }}
                    className="text-white/80 text-xs bg-white/15 px-3 py-2 rounded-full active:bg-white/30"
                  >
                    ✕ Fondo
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Zoom indicator + slider (right side) */}
          <div
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-white font-bold text-xs bg-black/40 px-2 py-0.5 rounded-full">
              {zoom < 1 ? `${zoom.toFixed(1)}x` : `${zoom.toFixed(1)}x`}
            </span>
            <div className="relative h-52 w-10 flex items-center justify-center">
              <input
                type="range"
                min={MIN_ZOOM * 100}
                max={MAX_ZOOM * 100}
                value={zoom * 100}
                onChange={(e) => setZoom(Number(e.target.value) / 100)}
                className="absolute w-52 h-10 -rotate-90 origin-center appearance-none bg-transparent cursor-pointer
                  [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:bg-white/25 [&::-webkit-slider-runnable-track]:rounded-full
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:-mt-[9px] [&::-webkit-slider-thumb]:shadow-lg"
                style={{ touchAction: "none" }}
              />
            </div>
            {/* Zoom presets */}
            <div className="flex flex-col gap-1 mt-1">
              {[0.3, 0.5, 1].map((z) => (
                <button
                  key={z}
                  onClick={() => setZoom(z)}
                  className={`w-8 h-8 rounded-full text-[10px] font-bold flex items-center justify-center transition-colors ${
                    Math.abs(zoom - z) < 0.05 ? "bg-white text-black" : "bg-white/15 text-white/70"
                  }`}
                >
                  {z}x
                </button>
              ))}
            </div>
          </div>

          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 pb-[env(safe-area-inset-bottom)] bg-gradient-to-t from-black/70 to-transparent z-10">
            {/* Mode tabs */}
            <div className="flex justify-center gap-4 mb-5 px-4" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setBgRemoval(false)}
                className={`text-xs font-semibold px-5 py-2.5 rounded-full transition-all ${
                  !bgRemoval ? "bg-white text-black shadow-lg" : "bg-white/10 text-white/60"
                }`}
              >
                Normal
              </button>
              <button
                onClick={() => toggleBgRemoval()}
                className={`text-xs font-semibold px-5 py-2.5 rounded-full transition-all ${
                  bgRemoval ? "bg-white text-black shadow-lg" : "bg-white/10 text-white/60"
                }`}
              >
                Sin fondo
              </button>
              <button
                onClick={() => pickBgImage()}
                className="text-xs font-semibold px-5 py-2.5 rounded-full bg-white/10 text-white/60 active:bg-white/25"
              >
                Galería
              </button>
            </div>

            {/* Shutter row */}
            <div className="flex items-center justify-center gap-10 pb-6" onClick={(e) => e.stopPropagation()}>
              {/* BG thumbnail */}
              <div
                onClick={() => pickBgImage()}
                className="w-12 h-12 rounded-xl border-2 border-white/25 overflow-hidden flex items-center justify-center bg-white/10 cursor-pointer active:scale-95 transition-transform"
              >
                {bgUrl ? (
                  <img src={bgUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" className="opacity-40">
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                  </svg>
                )}
              </div>

              {/* Shutter */}
              <button
                onClick={() => takePhoto()}
                className="w-[72px] h-[72px] rounded-full border-[4px] border-white flex items-center justify-center active:scale-90 transition-transform"
              >
                <div className="w-[60px] h-[60px] rounded-full bg-white" />
              </button>

              {/* Reset zoom */}
              <button
                onClick={() => setZoom(DEFAULT_ZOOM)}
                className="w-12 h-12 rounded-xl border-2 border-white/25 flex items-center justify-center bg-white/10 active:scale-95 transition-transform"
              >
                <span className="text-white/60 text-[11px] font-bold">RST</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
