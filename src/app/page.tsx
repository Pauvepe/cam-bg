"use client";

import { useRef, useState, useEffect, useCallback } from "react";

interface SegmentationResult {
  confidenceMasks?: Array<{ getAsFloat32Array(): Float32Array }>;
}

// Process segmentation at this max width for performance
const SEG_MAX_W = 640;

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const smallRef = useRef<HTMLCanvasElement>(null);
  const bgScratchRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [bgRemoval, setBgRemoval] = useState(false);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [segmenter, setSegmenter] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);

  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const pinchStartDist = useRef<number>(0);
  const pinchStartZoom = useRef<number>(1.0);
  const canvasSizeRef = useRef({ w: 0, h: 0 });

  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 3.0;
  const DEFAULT_ZOOM = 1.0;

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
      setError("Error cargando modelo");
      setLoadingMsg("");
      return null;
    }
  }, []);

  const startCamera = useCallback(
    async (facing: "user" | "environment" = facingMode) => {
      try {
        setLoading(true);
        setLoadingMsg("Accediendo a la c\u00e1mara...");
        setError(null);
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities?.() as any;
        if (caps?.zoom) {
          try { await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min } as any] }); } catch {}
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStarted(true);
        setLoading(false);
        setLoadingMsg("");
      } catch (e: any) {
        setError("No se puede acceder a la c\u00e1mara: " + e.message);
        setLoading(false);
        setLoadingMsg("");
      }
    },
    [facingMode]
  );

  // Segmentation render loop - only runs when bgRemoval is ON
  useEffect(() => {
    if (!started || !bgRemoval || !segmenter || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d")!;
    const smallCanvas = smallRef.current!;
    const smallCtx = smallCanvas.getContext("2d", { willReadFrequently: true })!;
    const bgScratch = bgScratchRef.current!;
    const bgCtx = bgScratch.getContext("2d")!;

    let lastTime = 0;
    let mask: Float32Array | null = null;
    let prevVW = 0;
    let prevVH = 0;

    const render = (ts: number) => {
      if (!video.videoWidth) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;

      // Compute small processing size (max SEG_MAX_W wide)
      const scale = Math.min(1, SEG_MAX_W / vw);
      const sw = Math.round(vw * scale);
      const sh = Math.round(vh * scale);

      // Only resize canvases when video dimensions change
      if (vw !== prevVW || vh !== prevVH) {
        prevVW = vw;
        prevVH = vh;
        smallCanvas.width = sw;
        smallCanvas.height = sh;
        canvas.width = sw;
        canvas.height = sh;
        if (bgImage) {
          bgScratch.width = sw;
          bgScratch.height = sh;
        }
      }

      // Draw video at reduced resolution
      smallCtx.drawImage(video, 0, 0, sw, sh);

      // Run segmentation ~25fps
      if (ts - lastTime > 40) {
        lastTime = ts;
        try {
          segmenter.segmentForVideo(video, ts, (result: SegmentationResult) => {
            if (result.confidenceMasks?.[0]) {
              mask = result.confidenceMasks[0].getAsFloat32Array();
            }
          });
        } catch {}
      }

      if (mask) {
        const frame = smallCtx.getImageData(0, 0, sw, sh);
        const data = frame.data;

        // Mask is at video resolution, we need it at small resolution
        // MediaPipe returns mask at video res, so we sample it
        const maskW = vw;
        const maskH = vh;

        if (bgImage) {
          bgScratch.width = sw;
          bgScratch.height = sh;
          // Cover-fit bg
          const imgR = bgImage.width / bgImage.height;
          const canR = sw / sh;
          let sx2 = 0, sy2 = 0, sw2 = bgImage.width, sh2 = bgImage.height;
          if (imgR > canR) { sw2 = bgImage.height * canR; sx2 = (bgImage.width - sw2) / 2; }
          else { sh2 = bgImage.width / canR; sy2 = (bgImage.height - sh2) / 2; }
          bgCtx.drawImage(bgImage, sx2, sy2, sw2, sh2, 0, 0, sw, sh);
          const bgData = bgCtx.getImageData(0, 0, sw, sh).data;

          for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
              const pi = (y * sw + x) * 4;
              // Sample mask at corresponding video position
              const mx = Math.min(maskW - 1, Math.round(x / scale));
              const my = Math.min(maskH - 1, Math.round(y / scale));
              const c = mask[my * maskW + mx];
              if (c < 0.5) {
                data[pi] = bgData[pi]; data[pi+1] = bgData[pi+1]; data[pi+2] = bgData[pi+2];
              } else if (c < 0.75) {
                const t = (c - 0.5) / 0.25;
                data[pi] = Math.round(data[pi]*t + bgData[pi]*(1-t));
                data[pi+1] = Math.round(data[pi+1]*t + bgData[pi+1]*(1-t));
                data[pi+2] = Math.round(data[pi+2]*t + bgData[pi+2]*(1-t));
              }
            }
          }
        } else {
          for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
              const pi = (y * sw + x) * 4;
              const mx = Math.min(maskW - 1, Math.round(x / scale));
              const my = Math.min(maskH - 1, Math.round(y / scale));
              const c = mask[my * maskW + mx];
              if (c < 0.5) {
                data[pi] = 17; data[pi+1] = 17; data[pi+2] = 17;
              } else if (c < 0.75) {
                const t = (c - 0.5) / 0.25;
                data[pi] = Math.round(data[pi]*t + 17*(1-t));
                data[pi+1] = Math.round(data[pi+1]*t + 17*(1-t));
                data[pi+2] = Math.round(data[pi+2]*t + 17*(1-t));
              }
            }
          }
        }
        ctx.putImageData(frame, 0, 0);
      } else {
        ctx.drawImage(smallCanvas, 0, 0);
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [started, bgRemoval, segmenter, bgImage]);

  // Pinch zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onTS = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist.current = Math.sqrt(dx*dx + dy*dy);
        pinchStartZoom.current = zoom;
      }
    };
    const onTM = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom.current * (dist / pinchStartDist.current))));
      }
    };
    el.addEventListener("touchstart", onTS, { passive: false });
    el.addEventListener("touchmove", onTM, { passive: false });
    return () => { el.removeEventListener("touchstart", onTS); el.removeEventListener("touchmove", onTM); };
  }, [zoom]);

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onW = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + (e.deltaY > 0 ? -0.05 : 0.05))));
    };
    el.addEventListener("wheel", onW, { passive: false });
    return () => el.removeEventListener("wheel", onW);
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
    img.onload = () => { setBgImage(img); setBgUrl(url); if (!bgRemoval) toggleBgRemoval(); };
    img.src = url;
    e.target.value = "";
  };

  const takePhoto = () => {
    // Capture from whatever is visible
    const source = bgRemoval ? canvasRef.current : videoRef.current;
    if (!source) return;
    const tmp = document.createElement("canvas");
    if (source instanceof HTMLVideoElement) {
      tmp.width = source.videoWidth;
      tmp.height = source.videoHeight;
      const c = tmp.getContext("2d")!;
      if (facingMode === "user") { c.translate(tmp.width, 0); c.scale(-1, 1); }
      c.drawImage(source, 0, 0);
    } else {
      tmp.width = source.width;
      tmp.height = source.height;
      const c = tmp.getContext("2d")!;
      if (facingMode === "user") { c.translate(tmp.width, 0); c.scale(-1, 1); }
      c.drawImage(source, 0, 0);
    }
    setCapturedPhoto(tmp.toDataURL("image/jpeg", 0.92));
  };

  const savePhoto = () => {
    if (!capturedPhoto) return;
    const a = document.createElement("a"); a.href = capturedPhoto;
    a.download = `cambg-${Date.now()}.jpg`; a.click();
  };

  const switchCamera = async () => {
    const f = facingMode === "user" ? "environment" : "user";
    setFacingMode(f);
    await startCamera(f);
  };

  // Connect stream to video element AFTER it mounts
  useEffect(() => {
    if (started && videoRef.current && streamRef.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [started]);

  useEffect(() => {
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); cancelAnimationFrame(animFrameRef.current); };
  }, []);

  // --- START SCREEN ---
  if (!started) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ height: "100dvh", background: "#000" }}>
        <div className="text-white text-5xl font-bold tracking-tight mb-2">CamBG</div>
        <p className="text-white/40 text-center text-sm max-w-xs mb-8">{"C\u00e1mara con eliminaci\u00f3n de fondo"}</p>
        {error && <p className="text-red-400 text-sm text-center mb-4">{error}</p>}
        <button
          onClick={() => startCamera()}
          disabled={loading}
          className="bg-white text-black font-semibold px-8 py-4 rounded-2xl text-lg active:scale-95 transition-transform disabled:opacity-50"
        >
          {loading ? "Iniciando..." : "Abrir C\u00e1mara"}
        </button>
      </div>
    );
  }

  // --- PHOTO PREVIEW ---
  if (capturedPhoto) {
    return (
      <div className="flex flex-col bg-black" style={{ height: "100dvh" }}>
        <div className="flex-1 flex items-center justify-center p-4">
          <img src={capturedPhoto} alt="Foto" className="max-w-full max-h-full object-contain rounded-2xl" />
        </div>
        <div className="flex gap-4 justify-center pb-8 pt-4">
          <button onClick={() => setCapturedPhoto(null)} className="bg-white/10 text-white px-6 py-3 rounded-xl font-medium">Volver</button>
          <button onClick={savePhoto} className="bg-white text-black px-6 py-3 rounded-xl font-medium">Guardar</button>
        </div>
      </div>
    );
  }

  // --- CAMERA VIEW ---
  const mirrorX = facingMode === "user" ? -1 : 1;

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden bg-black"
      style={{ width: "100vw", height: "100dvh", margin: 0, padding: 0 }}
      onClick={() => setShowControls(s => !s)}
    >
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

      {/* Video element - shown directly in normal mode (GPU accelerated, no lag) */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          minWidth: "100%",
          minHeight: "100%",
          width: "auto",
          height: "auto",
          objectFit: "cover",
          transform: `translate(-50%, -50%) scale(${zoom * mirrorX}, ${zoom})`,
          transformOrigin: "center center",
          display: bgRemoval ? "none" : "block",
        }}
      />

      {/* Canvas - shown only in bg removal mode */}
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: `${zoom * 100}vw`,
          height: `${zoom * 100}dvh`,
          objectFit: "cover",
          transform: `translate(-50%, -50%) scaleX(${mirrorX})`,
          transformOrigin: "center center",
          display: bgRemoval ? "block" : "none",
          imageRendering: "auto",
        }}
      />

      {/* Scratch canvases for processing */}
      <canvas ref={smallRef} style={{ display: "none" }} />
      <canvas ref={bgScratchRef} style={{ display: "none" }} />

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
            <span className="text-white/60 text-sm">{loadingMsg || "Cargando..."}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-2 left-2 right-2 bg-red-500/80 text-white text-sm p-3 rounded-xl z-50">{error}</div>
      )}

      {showControls && (
        <>
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 z-10" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
            <div className="flex items-center justify-between px-3 py-2">
              <button
                onClick={e => { e.stopPropagation(); switchCamera(); }}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-black/40 active:bg-black/60"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>
                  <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/>
                  <path d="m16 3-3 3 3 3"/><path d="m8 21 3-3-3-3"/>
                </svg>
              </button>
              {bgUrl && (
                <button
                  onClick={e => { e.stopPropagation(); setBgImage(null); setBgUrl(null); }}
                  className="text-white text-xs bg-black/40 px-3 py-1.5 rounded-full"
                >Quitar fondo</button>
              )}
            </div>
          </div>

          {/* Zoom slider right */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1" onClick={e => e.stopPropagation()}>
            <span className="text-white font-bold text-[11px] bg-black/50 px-2 py-0.5 rounded-full">{zoom.toFixed(1)}x</span>
            <div className="relative h-44 w-8 flex items-center justify-center">
              <input
                type="range" min={MIN_ZOOM*100} max={MAX_ZOOM*100} value={zoom*100}
                onChange={e => setZoom(Number(e.target.value)/100)}
                className="absolute w-44 h-8 -rotate-90 origin-center appearance-none bg-transparent
                  [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-white/20 [&::-webkit-slider-runnable-track]:rounded-full
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:-mt-2"
                style={{ touchAction: "none" }}
              />
            </div>
            <div className="flex flex-col gap-1">
              {[0.3, 0.5, 1].map(z => (
                <button key={z} onClick={() => setZoom(z)}
                  className={`w-7 h-7 rounded-full text-[9px] font-bold flex items-center justify-center ${Math.abs(zoom-z)<0.05 ? "bg-white text-black" : "bg-black/40 text-white/70"}`}
                >{z}x</button>
              ))}
            </div>
          </div>

          {/* Bottom */}
          <div className="absolute bottom-0 left-0 right-0 z-10" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
            <div className="flex justify-center gap-3 mb-4" onClick={e => e.stopPropagation()}>
              <button onClick={() => setBgRemoval(false)}
                className={`text-xs font-semibold px-4 py-2 rounded-full ${!bgRemoval ? "bg-white text-black" : "bg-black/40 text-white/60"}`}
              >Normal</button>
              <button onClick={() => toggleBgRemoval()}
                className={`text-xs font-semibold px-4 py-2 rounded-full ${bgRemoval ? "bg-white text-black" : "bg-black/40 text-white/60"}`}
              >Sin fondo</button>
              <button onClick={() => pickBgImage()}
                className="text-xs font-semibold px-4 py-2 rounded-full bg-black/40 text-white/60"
              >Fondo</button>
            </div>
            <div className="flex items-center justify-center gap-8 pb-4" onClick={e => e.stopPropagation()}>
              <div onClick={pickBgImage}
                className="w-11 h-11 rounded-lg border-2 border-white/20 overflow-hidden flex items-center justify-center bg-black/30"
              >
                {bgUrl ? <img src={bgUrl} alt="" className="w-full h-full object-cover"/> : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" className="opacity-40">
                    <rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/>
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                  </svg>
                )}
              </div>
              <button onClick={e => { e.stopPropagation(); takePhoto(); }}
                className="w-[68px] h-[68px] rounded-full border-4 border-white flex items-center justify-center active:scale-90 transition-transform"
              ><div className="w-[56px] h-[56px] rounded-full bg-white"/></button>
              <button onClick={e => { e.stopPropagation(); setZoom(DEFAULT_ZOOM); }}
                className="w-11 h-11 rounded-lg border-2 border-white/20 flex items-center justify-center bg-black/30"
              ><span className="text-white/50 text-[10px] font-bold">RST</span></button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
