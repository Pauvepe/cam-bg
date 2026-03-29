"use client";

import { useRef, useState, useEffect, useCallback } from "react";

// MediaPipe types
interface SegmentationResult {
  categoryMask?: { canvas: HTMLCanvasElement; getAsFloat32Array(): Float32Array };
  confidenceMasks?: Array<{ canvas: HTMLCanvasElement; getAsFloat32Array(): Float32Array }>;
}

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bgRemoval, setBgRemoval] = useState(false);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [minHwZoom, setMinHwZoom] = useState(1);
  const [maxHwZoom, setMaxHwZoom] = useState(1);
  const [hwZoom, setHwZoom] = useState(1);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [segmenter, setSegmenter] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);

  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const pinchStartDist = useRef<number>(0);
  const pinchStartZoom = useRef<number>(1);

  // Load MediaPipe
  const loadSegmenter = useCallback(async () => {
    try {
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
      return seg;
    } catch (e) {
      console.error("Error loading segmenter:", e);
      setError("Error cargando el modelo de segmentación");
      return null;
    }
  }, []);

  // Start camera
  const startCamera = useCallback(
    async (facing: "user" | "environment" = facingMode) => {
      try {
        setLoading(true);
        setError(null);

        // Stop existing stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
        }

        // Request wide camera - try ultra wide first
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: facing,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            // @ts-ignore - zoom is valid on supported devices
            zoom: { ideal: 1 },
          },
          audio: false,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];

        // Check zoom capabilities
        const caps = track.getCapabilities?.() as any;
        if (caps?.zoom) {
          setMinHwZoom(caps.zoom.min);
          setMaxHwZoom(caps.zoom.max);
          setHwZoom(caps.zoom.min);
          // Set to minimum zoom (widest angle)
          await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min } as any] });
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setStarted(true);
        setLoading(false);
      } catch (e: any) {
        console.error("Camera error:", e);
        setError("No se puede acceder a la cámara: " + e.message);
        setLoading(false);
      }
    },
    [facingMode]
  );

  // Set hardware zoom
  const applyHwZoom = useCallback(
    async (val: number) => {
      if (!streamRef.current) return;
      const track = streamRef.current.getVideoTracks()[0];
      try {
        await track.applyConstraints({ advanced: [{ zoom: val } as any] });
        setHwZoom(val);
      } catch {
        // Zoom not supported on this device
      }
    },
    []
  );

  // Digital zoom (scale transform) - allows going BELOW 1.0 for dezoom effect
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3.0;

  // Render loop
  useEffect(() => {
    if (!started || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    let lastTime = 0;

    const render = (timestamp: number) => {
      if (!video.videoWidth) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      if (bgRemoval && segmenter) {
        // Throttle segmentation to ~30fps
        if (timestamp - lastTime > 33) {
          lastTime = timestamp;
          try {
            segmenter.segmentForVideo(video, timestamp, (result: SegmentationResult) => {
              if (!result.confidenceMasks || result.confidenceMasks.length === 0) return;

              const mask = result.confidenceMasks[0].getAsFloat32Array();

              // Draw video frame
              ctx.drawImage(video, 0, 0);

              const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const data = frame.data;

              // Draw background first if exists
              if (bgImage && bgCanvasRef.current) {
                const bgCtx = bgCanvasRef.current.getContext("2d")!;
                bgCanvasRef.current.width = canvas.width;
                bgCanvasRef.current.height = canvas.height;

                // Cover-fit the background
                const imgRatio = bgImage.width / bgImage.height;
                const canvasRatio = canvas.width / canvas.height;
                let sx = 0, sy = 0, sw = bgImage.width, sh = bgImage.height;
                if (imgRatio > canvasRatio) {
                  sw = bgImage.height * canvasRatio;
                  sx = (bgImage.width - sw) / 2;
                } else {
                  sh = bgImage.width / canvasRatio;
                  sy = (bgImage.height - sh) / 2;
                }
                bgCtx.drawImage(bgImage, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

                const bgFrame = bgCtx.getImageData(0, 0, canvas.width, canvas.height);
                const bgData = bgFrame.data;

                // Composite: person from video, background from image
                for (let i = 0; i < mask.length; i++) {
                  const confidence = mask[i];
                  const pi = i * 4;
                  if (confidence < 0.6) {
                    // Background pixel - use bg image
                    data[pi] = bgData[pi];
                    data[pi + 1] = bgData[pi + 1];
                    data[pi + 2] = bgData[pi + 2];
                  } else if (confidence < 0.8) {
                    // Edge - blend
                    const t = (confidence - 0.6) / 0.2;
                    data[pi] = data[pi] * t + bgData[pi] * (1 - t);
                    data[pi + 1] = data[pi + 1] * t + bgData[pi + 1] * (1 - t);
                    data[pi + 2] = data[pi + 2] * t + bgData[pi + 2] * (1 - t);
                  }
                  // else: person pixel, keep as is
                }
              } else {
                // No bg image - make background transparent/black
                for (let i = 0; i < mask.length; i++) {
                  const confidence = mask[i];
                  const pi = i * 4;
                  if (confidence < 0.6) {
                    data[pi] = 0;
                    data[pi + 1] = 0;
                    data[pi + 2] = 0;
                    data[pi + 3] = 0;
                  } else if (confidence < 0.8) {
                    const t = (confidence - 0.6) / 0.2;
                    data[pi + 3] = Math.round(255 * t);
                  }
                }
              }

              ctx.putImageData(frame, 0, 0);
            });
          } catch {
            ctx.drawImage(video, 0, 0);
          }
        }
      } else {
        // No segmentation - just draw video
        ctx.drawImage(video, 0, 0);
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [started, bgRemoval, segmenter, bgImage]);

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
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom.current * scale));
        setZoom(newZoom);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [zoom]);

  // Toggle bg removal
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

  // Pick background image
  const pickBgImage = () => {
    fileInputRef.current?.click();
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setBgImage(img);
      setBgUrl(url);
    };
    img.src = url;
    // Reset input
    e.target.value = "";
  };

  // Take photo
  const takePhoto = () => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL("image/png");
    setCapturedPhoto(dataUrl);
  };

  // Save photo
  const savePhoto = () => {
    if (!capturedPhoto) return;
    const a = document.createElement("a");
    a.href = capturedPhoto;
    a.download = `cambg-${Date.now()}.png`;
    a.click();
  };

  // Switch camera
  const switchCamera = async () => {
    const newFacing = facingMode === "user" ? "environment" : "user";
    setFacingMode(newFacing);
    await startCamera(newFacing);
  };

  // Cleanup
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // Start screen
  if (!started) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh bg-black text-white gap-6 p-8">
        <div className="text-5xl font-bold tracking-tight">CamBG</div>
        <p className="text-white/50 text-center text-sm max-w-xs">
          Cámara con eliminación de fondo en tiempo real
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

  // Photo preview
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
          <button
            onClick={savePhoto}
            className="bg-white text-black px-6 py-3 rounded-xl font-medium active:scale-95 transition-transform"
          >
            Guardar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-dvh bg-black overflow-hidden" onClick={() => setShowControls(!showControls)}>
      {/* Hidden elements */}
      <video ref={videoRef} playsInline muted className="hidden" />
      <canvas ref={bgCanvasRef} className="hidden" />
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

      {/* Camera feed */}
      <div className="absolute inset-0 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          className="w-full h-full object-cover"
          style={{
            transform: `scale(${zoom})${facingMode === "user" ? " scaleX(-1)" : ""}`,
            transformOrigin: "center center",
          }}
        />
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
            <span className="text-white/70 text-sm">Cargando modelo IA...</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute top-4 left-4 right-4 bg-red-500/80 text-white text-sm p-3 rounded-xl z-50">
          {error}
        </div>
      )}

      {showControls && (
        <>
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 pt-[env(safe-area-inset-top)] bg-gradient-to-b from-black/50 to-transparent z-10">
            <div className="flex items-center justify-between px-4 py-3">
              <button onClick={switchCamera} className="w-10 h-10 flex items-center justify-center rounded-full bg-white/15 active:bg-white/30">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                  <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                  <path d="m16 3-3 3 3 3" />
                  <path d="m8 21 3-3-3-3" />
                </svg>
              </button>

              {bgUrl && (
                <button
                  onClick={(e) => { e.stopPropagation(); setBgImage(null); setBgUrl(null); }}
                  className="text-white/80 text-xs bg-white/15 px-3 py-1.5 rounded-full active:bg-white/30"
                >
                  Quitar fondo
                </button>
              )}
            </div>
          </div>

          {/* Zoom slider - vertical on right side */}
          <div className="absolute right-4 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-2">
            <span className="text-white/70 text-[10px] font-medium">{zoom.toFixed(1)}x</span>
            <div className="relative h-48 w-8 flex items-center justify-center">
              <input
                type="range"
                min={MIN_ZOOM * 100}
                max={MAX_ZOOM * 100}
                value={zoom * 100}
                onChange={(e) => { e.stopPropagation(); setZoom(Number(e.target.value) / 100); }}
                onClick={(e) => e.stopPropagation()}
                className="absolute w-48 h-8 -rotate-90 origin-center appearance-none bg-transparent
                  [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-white/30 [&::-webkit-slider-runnable-track]:rounded-full
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:shadow-lg"
              />
            </div>
            <span className="text-white/40 text-[10px]">zoom</span>
          </div>

          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 pb-[env(safe-area-inset-bottom)] bg-gradient-to-t from-black/60 to-transparent z-10">
            {/* Mode buttons */}
            <div className="flex justify-center gap-6 mb-4 px-4">
              <button
                onClick={(e) => { e.stopPropagation(); setBgRemoval(false); }}
                className={`text-xs font-medium px-4 py-2 rounded-full transition-colors ${
                  !bgRemoval ? "bg-white text-black" : "bg-white/15 text-white/70"
                }`}
              >
                Normal
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); toggleBgRemoval(); }}
                className={`text-xs font-medium px-4 py-2 rounded-full transition-colors ${
                  bgRemoval ? "bg-white text-black" : "bg-white/15 text-white/70"
                }`}
              >
                Sin fondo
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); pickBgImage(); }}
                className="text-xs font-medium px-4 py-2 rounded-full bg-white/15 text-white/70 active:bg-white/30"
              >
                Fondo
              </button>
            </div>

            {/* Shutter + gallery */}
            <div className="flex items-center justify-center gap-12 pb-6">
              {/* Gallery preview */}
              <div
                onClick={(e) => { e.stopPropagation(); pickBgImage(); }}
                className="w-12 h-12 rounded-xl border-2 border-white/30 overflow-hidden flex items-center justify-center bg-white/10 cursor-pointer"
              >
                {bgUrl ? (
                  <img src={bgUrl} alt="bg" className="w-full h-full object-cover" />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-50">
                    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                  </svg>
                )}
              </div>

              {/* Shutter button */}
              <button
                onClick={(e) => { e.stopPropagation(); takePhoto(); }}
                className="w-[72px] h-[72px] rounded-full border-[4px] border-white flex items-center justify-center active:scale-90 transition-transform"
              >
                <div className="w-[60px] h-[60px] rounded-full bg-white" />
              </button>

              {/* Zoom reset */}
              <button
                onClick={(e) => { e.stopPropagation(); setZoom(1.0); applyHwZoom(minHwZoom); }}
                className="w-12 h-12 rounded-xl border-2 border-white/30 flex items-center justify-center bg-white/10"
              >
                <span className="text-white/70 text-[10px] font-bold">1x</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
