import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { type ChatMetadataRecord } from "../../../services/db";
import type { MetadataAIConfig, StarmapConfig } from "../../../services/settingsService";
import type { BackgroundRequest } from "../../../types/messaging";
import type { ChatMeta } from "../../types";
import { ICONS, Icon } from "../../utils";
import { ChatPreviewCard, type PreviewData } from "../shared/ChatPreviewCard";

type StarmapNode = {
  chatId: string;
  x: number;
  y: number;
  z: number;
  clusterId: number;
  source: string;
  title: string;
  metaTitle?: string;
  description: string;
  synopsis: string;
  categories: string[];
  keywords: string[];
  metaSource: "manual" | "ai" | "unset";
  generatedAt?: number;
  metadataUpdatedAt?: number;
  lastSyncedTimestamp?: number;
  providerLastModifiedTimestamp?: number;
  /** `{ roughDate }` for a chat dated only roughly: the card shows that date, not the times */
  params?: Record<string, unknown>;
};

type StarmapPayload = {
  points: StarmapNode[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  embeddedCount: number;
  stats: {
    pointCount: number;
    clusterCount: number;
    durationMs: number;
    projection: "umap";
  };
};

interface EmbeddingQueueStatus {
  pending: number;
  processing: number;
  failed: number;
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl") ||
      canvas.getContext("webgl2")
    );
  } catch {
    return false;
  }
}

function colorForCluster(clusterId: number): THREE.Color {
  const hue = (clusterId * 47) % 360;
  return new THREE.Color(`hsl(${hue}, 80%, 60%)`);
}

interface StarmapCanvasProps {
  points: StarmapNode[];
  animationPlaying: boolean;
  onHover: (node: StarmapNode | null, x: number, y: number) => void;
  onSelect: (node: StarmapNode | null) => void;
}

function StarmapCanvas({ points, animationPlaying, onHover, onSelect }: StarmapCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const animationPlayingRef = useRef(animationPlaying);

  useEffect(() => {
    animationPlayingRef.current = animationPlaying;
  }, [animationPlaying]);

  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#070b13");

    const camera = new THREE.PerspectiveCamera(65, width / Math.max(1, height), 0.1, 2000);
    camera.position.set(0, 0, 4.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height);
    mountRef.current.appendChild(renderer.domElement);

    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);

    points.forEach((p, i) => {
      positions[i * 3] = p.x * 2.2;
      positions[i * 3 + 1] = p.y * 2.2;
      positions[i * 3 + 2] = p.z * 2.2;
      const c = colorForCluster(p.clusterId);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.06,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      sizeAttenuation: true,
    });

    const cloud = new THREE.Points(geometry, material);
    scene.add(cloud);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.11 };
    const pointer = new THREE.Vector2();

    let hoveredIndex = -1;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!mountRef.current) return;
      const rect = mountRef.current.getBoundingClientRect();

      if (isDragging) {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        cloud.rotation.y += dx * 0.004;
        cloud.rotation.x += dy * 0.004;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        return;
      }

      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(cloud);

      if (hits.length === 0) {
        if (hoveredIndex !== -1) {
          hoveredIndex = -1;
          onHover(null, e.clientX, e.clientY);
        }
        return;
      }

      const i = hits[0].index ?? -1;
      if (i !== hoveredIndex && i >= 0 && i < points.length) {
        hoveredIndex = i;
        onHover(points[i], e.clientX, e.clientY);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!mountRef.current) return;
      const wasDragging = isDragging;
      isDragging = false;

      if (wasDragging) {
        const rect = mountRef.current.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObject(cloud);
        if (hits.length > 0 && (hits[0].index ?? -1) >= 0) {
          const idx = hits[0].index ?? -1;
          if (idx >= 0 && idx < points.length) {
            onSelect(points[idx]);
            return;
          }
        }
      }

      onSelect(null);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camera.position.z = Math.min(12, Math.max(1.2, camera.position.z + e.deltaY * 0.0035));
    };

    const onResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    const onMouseLeave = () => {
      isDragging = false;
      onHover(null, 0, 0);
    };

    mountRef.current.addEventListener("mousemove", onMouseMove);
    mountRef.current.addEventListener("mousedown", onMouseDown);
    mountRef.current.addEventListener("mouseup", onMouseUp);
    mountRef.current.addEventListener("mouseleave", onMouseLeave);
    mountRef.current.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);

    let raf = 0;
    const animate = () => {
      if (animationPlayingRef.current) {
        cloud.rotation.y += 0.0008;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      mountRef.current?.removeEventListener("mousemove", onMouseMove);
      mountRef.current?.removeEventListener("mousedown", onMouseDown);
      mountRef.current?.removeEventListener("mouseup", onMouseUp);
      mountRef.current?.removeEventListener("mouseleave", onMouseLeave);
      mountRef.current?.removeEventListener("wheel", onWheel);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (mountRef.current?.contains(renderer.domElement)) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, [points, onHover, onSelect]);

  return (
    <div
      ref={mountRef}
      className="w-full h-[72vh] rounded-lg border border-border overflow-hidden"
    />
  );
}

interface StarmapViewProps {
  onOpenChatInViewer: (chatId: string) => Promise<void>;
}

export function StarmapView({ onOpenChatInViewer }: StarmapViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<StarmapPayload | null>(null);
  const [selected, setSelected] = useState<StarmapNode | null>(null);
  const [hovered, setHovered] = useState<StarmapNode | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [hoverPreviewData, setHoverPreviewData] = useState<PreviewData | null>(null);
  const [hoverPreviewLoading, setHoverPreviewLoading] = useState(false);
  const [metaConfig, setMetaConfig] = useState<MetadataAIConfig | null>(null);
  const [starmapConfig, setStarmapConfig] = useState<StarmapConfig | null>(null);
  const [queueStatus, setQueueStatus] = useState<EmbeddingQueueStatus | null>(null);
  const [animationPlaying, setAnimationPlaying] = useState(true);
  const [showParamsModal, setShowParamsModal] = useState(false);
  const [draftConfig, setDraftConfig] = useState<StarmapConfig | null>(null);
  const [savingParams, setSavingParams] = useState(false);
  const webglAvailable = useMemo(() => hasWebGL(), []);
  const previewCacheRef = useRef<Map<string, PreviewData>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [metaRes, starmapRes] = await Promise.all([
        chrome.runtime.sendMessage({ action: "getMetadataAIConfig" } as BackgroundRequest),
        chrome.runtime.sendMessage({ action: "getStarmapConfig" } as BackgroundRequest),
      ]);

      if (metaRes?.success) setMetaConfig(metaRes.data as MetadataAIConfig);
      if (starmapRes?.success) {
        const cfg = starmapRes.data as StarmapConfig;
        setStarmapConfig(cfg);
        setDraftConfig(cfg);
      }

      if (!metaRes?.success || !(metaRes.data as MetadataAIConfig).enabled) return;
      if (!starmapRes?.success || !(starmapRes.data as StarmapConfig).enabled) return;

      const dataRes = await chrome.runtime.sendMessage({
        action: "getStarmapData",
      } as BackgroundRequest);
      if (!dataRes?.success) {
        throw new Error(dataRes?.error || "Failed to load starmap data");
      }
      setPayload(dataRes.data as StarmapPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadQueueStatus = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        action: "getStarmapEmbeddingQueueStatus",
      } as BackgroundRequest);
      if (res?.success && res.data) {
        setQueueStatus(res.data as EmbeddingQueueStatus);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!starmapConfig?.enabled) return;
    loadQueueStatus();
    const timer = setInterval(() => {
      loadQueueStatus();
    }, 4000);
    return () => clearInterval(timer);
  }, [starmapConfig?.enabled, loadQueueStatus]);

  const persistStarmapConfig = useCallback(
    async (patch: Partial<StarmapConfig>, options?: { recompute?: boolean }) => {
      setSavingParams(true);
      try {
        const res = await chrome.runtime.sendMessage({
          action: "setStarmapConfig",
          config: patch,
        } as BackgroundRequest);
        if (!res?.success) {
          throw new Error(res?.error || "Failed to save starmap settings");
        }

        const next = { ...(starmapConfig || ({} as StarmapConfig)), ...patch } as StarmapConfig;
        setStarmapConfig(next);
        setDraftConfig(next);

        if (options?.recompute) {
          await load();
        } else {
          await loadQueueStatus();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingParams(false);
      }
    },
    [load, loadQueueStatus, starmapConfig],
  );

  const handleHover = useCallback((node: StarmapNode | null, x: number, y: number) => {
    setHovered(node);
    setHoverPos({ x, y });
  }, []);

  const handleSelect = useCallback((node: StarmapNode | null) => {
    setSelected(node);
  }, []);

  useEffect(() => {
    if (!hovered) {
      setHoverPreviewData(null);
      setHoverPreviewLoading(false);
      return;
    }

    const cached = previewCacheRef.current.get(hovered.chatId);
    if (cached) {
      setHoverPreviewData(cached);
      return;
    }

    let cancelled = false;
    setHoverPreviewData(null);
    setHoverPreviewLoading(true);

    chrome.runtime
      .sendMessage({ action: "getChatPreview", chatId: hovered.chatId } as BackgroundRequest)
      .then((resp) => {
        if (cancelled) return;
        if (resp?.success && resp.data) {
          const data = resp.data as PreviewData;
          previewCacheRef.current.set(hovered.chatId, data);
          setHoverPreviewData(data);
        }
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (!cancelled) setHoverPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hovered]);

  if (!webglAvailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>WebGL Unavailable</CardTitle>
          <CardDescription>
            Starmap requires WebGL. Enable hardware acceleration in your browser to use this
            feature.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Starmap</CardTitle>
          <CardDescription>Computing UMAP layout from your embeddings…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (metaConfig && !metaConfig.enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Starmap</CardTitle>
          <CardDescription>
            Enable AI Metadata first in Settings. Starmap depends on metadata-driven embeddings.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (starmapConfig && !starmapConfig.enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Starmap</CardTitle>
          <CardDescription>
            Starmap is disabled. Enable it in Settings to visualize your chat constellation.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Starmap</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={load}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const points = payload?.points ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Constellation</h3>
          <p className="text-xs text-muted-foreground">
            {payload?.stats.pointCount ?? 0} chats · {payload?.stats.clusterCount ?? 0} clusters ·{" "}
            {payload?.stats.durationMs ?? 0}ms · queued{" "}
            {(queueStatus?.pending ?? 0) + (queueStatus?.processing ?? 0)} · not shown{" "}
            {Math.max(0, (payload?.embeddedCount ?? 0) - (payload?.points.length ?? 0))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            title={animationPlaying ? "Pause animation" : "Play animation"}
            onClick={() => setAnimationPlaying((prev) => !prev)}
          >
            <Icon icon={animationPlaying ? ICONS.pause : ICONS.play} svgClass="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="Recompute layout"
            onClick={load}
            disabled={loading}
          >
            <Icon icon={ICONS.refresh} svgClass="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="Starmap parameters"
            onClick={() => setShowParamsModal(true)}
            disabled={!starmapConfig}
          >
            <Icon icon={ICONS.settings} svgClass="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Dialog open={showParamsModal} onOpenChange={setShowParamsModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Starmap Parameters</DialogTitle>
            <DialogDescription>
              Tune UMAP and clustering settings. Apply now to recompute immediately, or save as
              default for next runs.
            </DialogDescription>
          </DialogHeader>

          {draftConfig && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="starmap-neighbors">UMAP Neighbors</Label>
                <Input
                  id="starmap-neighbors"
                  type="number"
                  min={2}
                  max={200}
                  value={draftConfig.umapNeighbors}
                  onChange={(e) =>
                    setDraftConfig((prev) =>
                      prev
                        ? {
                            ...prev,
                            umapNeighbors: Number((e.target as HTMLInputElement).value || 15),
                          }
                        : prev,
                    )
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="starmap-min-dist">UMAP Min Dist</Label>
                <Input
                  id="starmap-min-dist"
                  type="number"
                  step="0.01"
                  min={0}
                  max={1}
                  value={draftConfig.umapMinDist}
                  onChange={(e) =>
                    setDraftConfig((prev) =>
                      prev
                        ? {
                            ...prev,
                            umapMinDist: Number((e.target as HTMLInputElement).value || 0.1),
                          }
                        : prev,
                    )
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="starmap-seed">UMAP Seed</Label>
                <Input
                  id="starmap-seed"
                  type="number"
                  value={draftConfig.umapSeed}
                  onChange={(e) =>
                    setDraftConfig((prev) =>
                      prev
                        ? { ...prev, umapSeed: Number((e.target as HTMLInputElement).value || 42) }
                        : prev,
                    )
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="starmap-cluster-mode">Cluster Mode</Label>
                <select
                  id="starmap-cluster-mode"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={draftConfig.clusterMode}
                  onChange={(e) =>
                    setDraftConfig((prev) =>
                      prev
                        ? {
                            ...prev,
                            clusterMode: (e.target as HTMLSelectElement).value as "auto" | "manual",
                          }
                        : prev,
                    )
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="manual">Manual</option>
                </select>
              </div>

              {draftConfig.clusterMode === "manual" && (
                <div className="space-y-2">
                  <Label htmlFor="starmap-cluster-k">Cluster K</Label>
                  <Input
                    id="starmap-cluster-k"
                    type="number"
                    min={1}
                    max={256}
                    value={draftConfig.clusterK}
                    onChange={(e) =>
                      setDraftConfig((prev) =>
                        prev
                          ? {
                              ...prev,
                              clusterK: Number((e.target as HTMLInputElement).value || 1),
                            }
                          : prev,
                      )
                    }
                  />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowParamsModal(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              disabled={!draftConfig || savingParams}
              onClick={() => {
                if (!draftConfig) return;
                void persistStarmapConfig(draftConfig, { recompute: false });
              }}
            >
              Save as default
            </Button>
            <Button
              disabled={!draftConfig || savingParams}
              onClick={() => {
                if (!draftConfig) return;
                void persistStarmapConfig(draftConfig, { recompute: true }).then(() => {
                  setShowParamsModal(false);
                });
              }}
            >
              Apply now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {points.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No points to render yet</CardTitle>
            <CardDescription>
              Embeddings may still be catching up. Check Starmap embedding queue status in Settings.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <StarmapCanvas
          points={points}
          animationPlaying={animationPlaying}
          onHover={handleHover}
          onSelect={handleSelect}
        />
      )}

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>{selected.metaTitle || selected.title || "(Untitled)"}</CardTitle>
            <CardDescription>
              {selected.source} · cluster {selected.clusterId} · {selected.metaSource}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {selected.description && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {selected.description}
              </p>
            )}
            {!selected.description && selected.synopsis && (
              <p className="text-sm text-muted-foreground leading-relaxed">{selected.synopsis}</p>
            )}
            {selected.categories.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Categories: {selected.categories.join(" · ")}
              </p>
            )}
            {selected.keywords.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Keywords: {selected.keywords.slice(0, 16).join(", ")}
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={() => onOpenChatInViewer(selected.chatId)}>Open in Viewer</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {hovered &&
        createPortal(
          <div
            className="fixed z-50 w-[400px] rounded-xl border border-border bg-card text-card-foreground shadow-xl pointer-events-none"
            style={{
              left: Math.min(hoverPos.x + 12, window.innerWidth - 408),
              top: Math.max(12, hoverPos.y + 12),
            }}
          >
            <ChatPreviewCard
              chat={
                {
                  id: hovered.chatId,
                  source: hovered.source,
                  title: hovered.title,
                  metaTitle: hovered.metaTitle,
                  lastSyncedTimestamp: hovered.lastSyncedTimestamp,
                  providerLastModifiedTimestamp: hovered.providerLastModifiedTimestamp,
                  params: hovered.params,
                } as ChatMeta
              }
              data={
                hoverPreviewData ||
                ({
                  metadata: {
                    chatId: hovered.chatId,
                    title: hovered.metaTitle || "",
                    description: hovered.description,
                    synopsis: hovered.synopsis,
                    categories: hovered.categories,
                    keywords: hovered.keywords,
                    source: hovered.metaSource,
                    generatedAt: hovered.generatedAt,
                    updatedAt: hovered.metadataUpdatedAt || Date.now(),
                  } as ChatMetadataRecord,
                  messageCount: 0,
                  createdAt: hovered.lastSyncedTimestamp || Date.now(),
                  models: [],
                } as PreviewData)
              }
              isLoading={hoverPreviewLoading}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
