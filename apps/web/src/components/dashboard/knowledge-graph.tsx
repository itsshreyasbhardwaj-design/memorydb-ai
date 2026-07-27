'use client';

/**
 * Interactive knowledge graph.
 *
 * A force-directed layout implemented directly on SVG — no D3, no canvas
 * library. The simulation is a standard three-force model:
 *
 *  - **repulsion** between every node pair (Coulomb-like, inverse square)
 *  - **attraction** along each edge (Hooke-like spring toward a rest length)
 *  - **centering** so disconnected components don't drift off-screen
 *
 * Velocities are damped each tick and the loop stops once total kinetic energy
 * falls below a threshold, so an idle graph costs nothing. Repulsion is O(n²),
 * which is fine at the node counts the API returns (capped at 150 by default);
 * beyond that a Barnes-Hut quadtree would be the next step.
 */
import * as React from 'react';
import type { KnowledgeGraph as GraphData } from '@memorydb/core';
import { cn, ENTITY_TYPE_COLORS } from '@/lib/utils';
import { EmptyState } from '@/components/ui/primitives';

interface SimNode {
  id: string;
  name: string;
  type: string;
  degree: number;
  mentionCount: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Pinned by a drag; excluded from force integration while held. */
  fixed: boolean;
}

interface SimEdge {
  source: string;
  target: string;
  weight: number;
  type: string;
}

const WIDTH = 900;
const HEIGHT = 560;

/* Force constants, tuned for a readable layout at 20-150 nodes. */
const REPULSION = 6000;
const SPRING_STRENGTH = 0.02;
const SPRING_LENGTH = 90;
const CENTER_PULL = 0.006;
const DAMPING = 0.86;
const MIN_ENERGY = 0.02;
const MAX_TICKS = 400;

export function KnowledgeGraphView({
  graph,
  loading,
  onSelectEntity,
  className,
}: {
  graph: GraphData | null;
  loading?: boolean;
  onSelectEntity?: (entityId: string) => void;
  className?: string;
}) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const nodesRef = React.useRef<SimNode[]>([]);
  const frameRef = React.useRef<number | undefined>(undefined);
  const dragRef = React.useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [transform, setTransform] = React.useState({ x: 0, y: 0, k: 1 });

  const edges: SimEdge[] = React.useMemo(
    () =>
      (graph?.edges ?? []).map((edge) => ({
        source: edge.sourceId,
        target: edge.targetId,
        weight: edge.weight,
        type: edge.type,
      })),
    [graph],
  );

  /* ---- Seed the simulation whenever the graph data changes ---- */
  React.useEffect(() => {
    if (!graph?.nodes.length) {
      nodesRef.current = [];
      forceRender();
      return;
    }

    const maxDegree = Math.max(...graph.nodes.map((node) => node.degree), 1);

    // Seed on a circle rather than at random: the layout converges faster and,
    // being deterministic, the same graph always settles the same way.
    nodesRef.current = graph.nodes.map((node, index) => {
      const angle = (index / graph.nodes.length) * Math.PI * 2;
      const spread = Math.min(WIDTH, HEIGHT) * 0.32;
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        degree: node.degree,
        mentionCount: node.mentionCount,
        x: WIDTH / 2 + Math.cos(angle) * spread,
        y: HEIGHT / 2 + Math.sin(angle) * spread,
        vx: 0,
        vy: 0,
        // Area, not radius, scales with degree so a 4x-connected node doesn't
        // render 4x as visually heavy.
        radius: 5 + Math.sqrt(node.degree / maxDegree) * 13,
        fixed: false,
      };
    });

    let ticks = 0;

    const step = (): void => {
      const nodes = nodesRef.current;
      const byId = new Map(nodes.map((node) => [node.id, node]));
      let energy = 0;

      // Repulsion — every pair pushes apart.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b) continue;

          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distanceSq = dx * dx + dy * dy;

          // Coincident nodes would divide by zero; nudge them apart.
          if (distanceSq < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distanceSq = dx * dx + dy * dy || 1;
          }

          const distance = Math.sqrt(distanceSq);
          const force = REPULSION / distanceSq;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;

          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      // Attraction along edges, weighted by relation strength.
      for (const edge of edges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target) continue;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const displacement = distance - SPRING_LENGTH;
        const force = displacement * SPRING_STRENGTH * (0.4 + edge.weight);

        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      // Integrate.
      for (const node of nodes) {
        if (node.fixed) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }

        node.vx += (WIDTH / 2 - node.x) * CENTER_PULL;
        node.vy += (HEIGHT / 2 - node.y) * CENTER_PULL;

        node.vx *= DAMPING;
        node.vy *= DAMPING;

        node.x += node.vx;
        node.y += node.vy;

        // Keep nodes inside the viewport.
        node.x = Math.max(node.radius + 4, Math.min(WIDTH - node.radius - 4, node.x));
        node.y = Math.max(node.radius + 4, Math.min(HEIGHT - node.radius - 4, node.y));

        energy += node.vx * node.vx + node.vy * node.vy;
      }

      forceRender();
      ticks++;

      // Stop once settled — an idle graph should not burn a frame budget.
      if (energy > MIN_ENERGY && ticks < MAX_TICKS) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = undefined;
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [graph, edges]);

  /** Restart the simulation, e.g. after a drag displaces the layout. */
  const reheat = React.useCallback(() => {
    if (frameRef.current !== undefined) return;
    let ticks = 0;

    const step = (): void => {
      const nodes = nodesRef.current;
      let energy = 0;
      for (const node of nodes) {
        if (node.fixed) continue;
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;
        energy += node.vx * node.vx + node.vy * node.vy;
      }
      forceRender();
      ticks++;
      frameRef.current = energy > MIN_ENERGY && ticks < 120 ? requestAnimationFrame(step) : undefined;
    };
    frameRef.current = requestAnimationFrame(step);
  }, []);

  /* ---- Pointer interaction ---- */

  const toSvgPoint = React.useCallback((event: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const scaleY = HEIGHT / rect.height;
    return {
      x: ((event.clientX - rect.left) * scaleX - transform.x) / transform.k,
      y: ((event.clientY - rect.top) * scaleY - transform.y) / transform.k,
    };
  }, [transform]);

  const handlePointerDown = (event: React.PointerEvent, node: SimNode): void => {
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const point = toSvgPoint(event);
    node.fixed = true;
    dragRef.current = { id: node.id, offsetX: node.x - point.x, offsetY: node.y - point.y };
  };

  const handlePointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const node = nodesRef.current.find((candidate) => candidate.id === drag.id);
    if (!node) return;
    const point = toSvgPoint(event);
    node.x = point.x + drag.offsetX;
    node.y = point.y + drag.offsetY;
    forceRender();
  };

  const handlePointerUp = (): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const node = nodesRef.current.find((candidate) => candidate.id === drag.id);
    if (node) node.fixed = false;
    dragRef.current = null;
    reheat();
  };

  const handleWheel = (event: React.WheelEvent): void => {
    event.preventDefault();
    setTransform((current) => {
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k = Math.max(0.4, Math.min(3, current.k * factor));
      return { ...current, k };
    });
  };

  const nodes = nodesRef.current;
  const byId = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  /** Neighbours of the focused node, used to dim everything unrelated. */
  const focused = hovered ?? selected;
  const neighbours = React.useMemo(() => {
    if (!focused) return null;
    const set = new Set<string>([focused]);
    for (const edge of edges) {
      if (edge.source === focused) set.add(edge.target);
      if (edge.target === focused) set.add(edge.source);
    }
    return set;
  }, [focused, edges]);

  if (loading) {
    return (
      <div className={cn('flex h-[560px] items-center justify-center', className)}>
        <div className="shimmer size-full rounded-[var(--radius-card)]" />
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No entities extracted yet"
          description="Store memories mentioning people, projects, or technologies and the graph builds itself."
        />
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[560px] w-full touch-none select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
        role="img"
        aria-label={`Knowledge graph with ${graph.nodes.length} entities and ${graph.edges.length} relationships`}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-border-strong)" />
          </marker>
        </defs>

        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {/* Edges first so nodes always paint on top. */}
          <g>
            {edges.map((edge, index) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;

              const isActive = !neighbours || (neighbours.has(edge.source) && neighbours.has(edge.target));

              return (
                <line
                  key={index}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={isActive ? 'var(--color-border-strong)' : 'var(--color-border)'}
                  strokeWidth={0.6 + edge.weight * 1.8}
                  strokeOpacity={isActive ? 0.65 : 0.12}
                  markerEnd={isActive && edge.type !== 'related_to' ? 'url(#arrow)' : undefined}
                />
              );
            })}
          </g>

          <g>
            {nodes.map((node) => {
              const color = ENTITY_TYPE_COLORS[node.type] ?? 'var(--color-fg-subtle)';
              const isActive = !neighbours || neighbours.has(node.id);
              const isFocused = focused === node.id;

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  className="cursor-pointer"
                  opacity={isActive ? 1 : 0.2}
                  onPointerDown={(event) => handlePointerDown(event, node)}
                  onPointerEnter={() => setHovered(node.id)}
                  onPointerLeave={() => setHovered(null)}
                  onClick={() => {
                    setSelected((current) => (current === node.id ? null : node.id));
                    onSelectEntity?.(node.id);
                  }}
                >
                  {isFocused && (
                    <circle r={node.radius + 6} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.5} />
                  )}
                  <circle
                    r={node.radius}
                    fill={color}
                    fillOpacity={0.85}
                    stroke="var(--color-canvas)"
                    strokeWidth={1.5}
                  />
                  {/* Label only the significant nodes, or the focused one — a
                      fully labelled graph is unreadable. */}
                  {(node.radius > 9 || isFocused) && (
                    <text
                      y={node.radius + 12}
                      textAnchor="middle"
                      className="pointer-events-none"
                      fill="var(--color-fg-muted)"
                      fontSize={10}
                      fontWeight={isFocused ? 600 : 400}
                    >
                      {node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* Legend */}
      <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px]">
        {Array.from(new Set(graph.nodes.map((node) => node.type))).slice(0, 6).map((type) => (
          <span key={type} className="flex items-center gap-1.5 text-[var(--color-fg-subtle)]">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: ENTITY_TYPE_COLORS[type] ?? 'var(--color-fg-subtle)' }}
              aria-hidden
            />
            {type}
          </span>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-4 right-4 text-[11px] text-[var(--color-fg-subtle)]">
        drag nodes · scroll to zoom · {graph.stats.nodeCount} entities · {graph.stats.edgeCount} relations
      </div>
    </div>
  );
}
