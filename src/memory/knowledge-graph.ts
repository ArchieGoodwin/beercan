import { v4 as uuid } from "uuid";
import type { BeerCanDB } from "../storage/database.js";
import type { KGEntity, KGEdge, EntityType, EdgeType, MemoryEntry } from "./schemas.js";

// ── Knowledge Graph ─────────────────────────────────────────
// Entity-relationship graph for multi-hop reasoning.
// Entities are unique per (name, project_id).
// Agents create entities and edges via memory tools.

export class KnowledgeGraph {
  constructor(private db: BeerCanDB) {}

  // ── Entity Operations ──────────────────────────────────

  /** Find or create an entity by name within a project (idempotent) */
  getOrCreateEntity(
    projectId: string,
    name: string,
    entityType: EntityType,
    description?: string,
    bloopId?: string,
  ): KGEntity {
    const existing = this.db.findKGEntityByName(projectId, name);
    if (existing) {
      // Update description if provided and entity had none
      if (description && !existing.description) {
        this.db.updateKGEntity(existing.id, { description });
        return { ...existing, description };
      }
      return existing;
    }

    const now = new Date().toISOString();
    const entity: KGEntity = {
      id: uuid(),
      projectId,
      name,
      entityType,
      description: description ?? null,
      properties: {},
      sourceBloopId: bloopId ?? null,
      sourceMemoryId: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.createKGEntity(entity);
    return entity;
  }

  getEntity(id: string): KGEntity | null {
    return this.db.getKGEntity(id);
  }

  findByName(projectId: string, name: string): KGEntity | null {
    return this.db.findKGEntityByName(projectId, name);
  }

  listEntities(projectId: string, type?: EntityType): KGEntity[] {
    return this.db.listKGEntities(projectId, type);
  }

  searchEntities(projectId: string, query: string): KGEntity[] {
    return this.db.searchKGEntities(projectId, query);
  }

  // ── Edge Operations ────────────────────────────────────

  createEdge(
    projectId: string,
    sourceId: string,
    targetId: string,
    edgeType: EdgeType,
    weight = 1.0,
    bloopId?: string,
    properties: Record<string, unknown> = {},
  ): KGEdge {
    const edge: KGEdge = {
      id: uuid(),
      projectId,
      sourceId,
      targetId,
      edgeType,
      weight,
      properties,
      sourceBloopId: bloopId ?? null,
      createdAt: new Date().toISOString(),
    };

    this.db.createKGEdge(edge);
    return edge;
  }

  getEdgesFrom(entityId: string): KGEdge[] {
    return this.db.getKGEdgesFrom(entityId);
  }

  getEdgesTo(entityId: string): KGEdge[] {
    return this.db.getKGEdgesTo(entityId);
  }

  // ── Graph Traversal ────────────────────────────────────

  /** BFS traversal to find neighbors up to a given depth */
  getNeighbors(
    entityId: string,
    depth = 2,
    edgeTypes?: EdgeType[],
  ): KGEntity[] {
    const maxDepth = Math.min(depth, 4); // Cap to prevent runaway queries
    const visited = new Set<string>([entityId]);
    let frontier = [entityId];

    for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const edges = this.db.getKGEdgesBoth(nodeId);
        for (const edge of edges) {
          if (edgeTypes && !edgeTypes.includes(edge.edgeType as EdgeType)) continue;

          const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push(neighborId);
          }
        }
      }

      frontier = nextFrontier;
    }

    // Remove the starting entity from results
    visited.delete(entityId);

    return Array.from(visited)
      .map((id) => this.db.getKGEntity(id))
      .filter((e): e is KGEntity => e !== null);
  }

  // ── Entity-Memory Linking ──────────────────────────────

  linkEntityToMemory(entityId: string, memoryId: string): void {
    this.db.createKGEntityMemoryLink(entityId, memoryId);
  }

  getMemoriesForEntity(entityId: string): MemoryEntry[] {
    const memoryIds = this.db.getKGEntityMemoryIds(entityId);
    return memoryIds
      .map((id) => this.db.getMemoryEntry(id))
      .filter((m): m is MemoryEntry => m !== null);
  }

  getEntitiesForMemory(memoryId: string): KGEntity[] {
    const entityIds = this.db.getKGMemoryEntityIds(memoryId);
    return entityIds
      .map((id) => this.db.getKGEntity(id))
      .filter((e): e is KGEntity => e !== null);
  }
}
