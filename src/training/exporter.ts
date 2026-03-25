import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { getLogger } from "../core/logger.js";
import type { BeerCanDB } from "../storage/database.js";
import type { Config } from "../config.js";
import type { BeerCanEngine } from "../index.js";
import {
  AgentPackageSchema,
  type AgentPackage,
  type AgentPackageMemory,
  type AgentPackageKGEntity,
  type AgentPackageKGEdge,
  type AgentPackageSkill,
  type AgentPackageTool,
} from "./types.js";

// ── Agent Exporter ────────────────────────────────────────────
// Exports a trained agent's state (memories, KG, skills, tools)
// into a portable JSON package, and imports packages into new instances.

export class AgentExporter {

  // ── Export ──────────────────────────────────────────────

  /**
   * Export a project's agent state to a JSON package file.
   */
  async export(
    projectSlug: string,
    db: BeerCanDB,
    config: Config,
    outputPath: string,
  ): Promise<void> {
    const logger = getLogger();
    const project = db.getProjectBySlug(projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    logger.info("exporter", `Exporting agent: ${projectSlug}`, { outputPath });

    // ── Collect memories ──────────────────────────────────
    const memoryEntries = db.listMemoryEntries(project.id);
    const memories: AgentPackageMemory[] = memoryEntries.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      memoryType: m.memoryType,
      title: m.title,
      content: m.content,
      sourceBloopId: m.sourceBloopId,
      supersededBy: m.supersededBy,
      confidence: m.confidence,
      tags: m.tags,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    // ── Collect KG entities and edges ──────────────────────
    const kgEntities = db.listKGEntities(project.id);
    const entities: AgentPackageKGEntity[] = kgEntities.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      name: e.name,
      entityType: e.entityType,
      description: e.description,
      properties: e.properties,
      sourceBloopId: e.sourceBloopId,
      sourceMemoryId: e.sourceMemoryId,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));

    const edges: AgentPackageKGEdge[] = [];
    for (const entity of kgEntities) {
      const entityEdges = this.getEdgesForEntity(db, entity.id, project.id);
      for (const edge of entityEdges) {
        if (!edges.find((e) => e.id === edge.id)) {
          edges.push({
            id: edge.id,
            projectId: edge.projectId,
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            edgeType: edge.edgeType,
            weight: edge.weight,
            properties: edge.properties,
            sourceBloopId: edge.sourceBloopId,
            createdAt: edge.createdAt,
          });
        }
      }
    }

    // ── Collect skills ──────────────────────────────────────
    const skillsDir = path.join(config.dataDir, "skills");
    const skills: AgentPackageSkill[] = [];
    if (fs.existsSync(skillsDir)) {
      const skillFiles = fs.readdirSync(skillsDir).filter((f: string) => f.endsWith(".json"));
      for (const file of skillFiles) {
        try {
          const content = fs.readFileSync(path.join(skillsDir, file), "utf-8");
          skills.push({ name: file.replace(/\.json$/, ""), content });
        } catch (err: any) {
          logger.warn("exporter", `Failed to read skill: ${file}`, { error: err.message });
        }
      }
    }

    // ── Collect custom tools ────────────────────────────────
    const toolsDir = path.join(config.dataDir, "tools");
    const tools: AgentPackageTool[] = [];
    if (fs.existsSync(toolsDir)) {
      const toolFiles = fs.readdirSync(toolsDir).filter(
        (f: string) => f.endsWith(".js") || f.endsWith(".mjs")
      );
      for (const file of toolFiles) {
        try {
          const content = fs.readFileSync(path.join(toolsDir, file), "utf-8");
          tools.push({ name: file.replace(/\.(js|mjs)$/, ""), content });
        } catch (err: any) {
          logger.warn("exporter", `Failed to read tool: ${file}`, { error: err.message });
        }
      }
    }

    // ── Build training progress (if training project) ───────
    const trainingProgress = project.context?.trainingProgress as any;

    // ── Assemble package ────────────────────────────────────
    const agentPackage: AgentPackage = {
      version: "1",
      exportedAt: new Date().toISOString(),
      agentName: project.name,
      agentSlug: project.slug,
      trainingProgress: trainingProgress ?? undefined,
      memories,
      knowledgeGraphEntities: entities,
      knowledgeGraphEdges: edges,
      skills,
      tools,
      projectContext: project.context ?? {},
    };

    // Validate schema
    AgentPackageSchema.parse(agentPackage);

    // Write to file
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(agentPackage, null, 2));

    logger.info("exporter", `Export complete`, {
      projectSlug,
      outputPath,
      memories: memories.length,
      entities: entities.length,
      edges: edges.length,
      skills: skills.length,
      tools: tools.length,
    });
  }

  // ── Import ──────────────────────────────────────────────

  /**
   * Import a packaged agent into a new project.
   */
  async import(
    packagePath: string,
    targetSlug: string,
    engine: BeerCanEngine,
    db: BeerCanDB,
    config: Config,
  ): Promise<import("../schemas.js").Project> {
    const logger = getLogger();

    if (!fs.existsSync(packagePath)) {
      throw new Error(`Package file not found: ${packagePath}`);
    }

    const raw = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    const agentPackage = AgentPackageSchema.parse(raw);

    const slug = targetSlug || agentPackage.agentSlug;

    logger.info("exporter", `Importing agent: ${slug}`, { packagePath });

    // Check for existing project
    const existing = engine.getProject(slug);
    if (existing) {
      throw new Error(`Project already exists: ${slug}. Use a different --name slug.`);
    }

    // Determine work dir from package context if present
    const packageWorkDir = agentPackage.projectContext?.workDir as string | undefined;

    // Create the project
    const project = engine.createProject({
      name: agentPackage.agentName,
      slug,
      description: `Imported agent from ${path.basename(packagePath)}`,
      workDir: packageWorkDir,
      system: false,
      context: {
        ...agentPackage.projectContext,
        importedFrom: packagePath,
        importedAt: new Date().toISOString(),
        trainingProgress: agentPackage.trainingProgress,
      },
    });

    logger.info("exporter", `Created project: ${slug}`, { projectId: project.id });

    // ── Import memories ─────────────────────────────────────
    const { MemoryManager } = await import("../memory/index.js");
    const memoryManager = new MemoryManager(db);

    for (const mem of agentPackage.memories) {
      try {
        // Re-map projectId to new project
        const entry = {
          ...mem,
          id: mem.id, // preserve IDs for KG edge references
          projectId: project.id,
          sourceBloopId: null, // can't reference bloops from old project
        };
        db.createMemoryEntry(entry as any);
        // Store vector for the memory
        try {
          await memoryManager.getVectorStore().store(entry.id, `${entry.title}\n${entry.content}`);
        } catch {
          // Non-critical
        }
      } catch (err: any) {
        logger.warn("exporter", `Failed to import memory: ${mem.id}`, { error: err.message });
      }
    }

    // ── Import KG entities and edges ─────────────────────────
    for (const entity of agentPackage.knowledgeGraphEntities) {
      try {
        db.createKGEntity({
          ...entity,
          projectId: project.id,
          sourceBloopId: null,
          sourceMemoryId: null,
        } as any);
      } catch (err: any) {
        logger.warn("exporter", `Failed to import KG entity: ${entity.name}`, { error: err.message });
      }
    }

    for (const edge of agentPackage.knowledgeGraphEdges) {
      try {
        db.createKGEdge({
          ...edge,
          projectId: project.id,
          sourceBloopId: null,
        } as any);
      } catch (err: any) {
        logger.warn("exporter", `Failed to import KG edge: ${edge.id}`, { error: err.message });
      }
    }

    // ── Import skills ────────────────────────────────────────
    const skillsDir = path.join(config.dataDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    for (const skill of agentPackage.skills) {
      try {
        const skillPath = path.join(skillsDir, `${skill.name}.json`);
        // Don't overwrite existing skills
        if (!fs.existsSync(skillPath)) {
          fs.writeFileSync(skillPath, skill.content);
        } else {
          logger.warn("exporter", `Skipped existing skill: ${skill.name}`);
        }
      } catch (err: any) {
        logger.warn("exporter", `Failed to import skill: ${skill.name}`, { error: err.message });
      }
    }

    // ── Import custom tools ──────────────────────────────────
    const toolsDir = path.join(config.dataDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    for (const tool of agentPackage.tools) {
      try {
        const toolPath = path.join(toolsDir, `${tool.name}.js`);
        if (!fs.existsSync(toolPath)) {
          fs.writeFileSync(toolPath, tool.content);
        } else {
          logger.warn("exporter", `Skipped existing tool: ${tool.name}`);
        }
      } catch (err: any) {
        logger.warn("exporter", `Failed to import tool: ${tool.name}`, { error: err.message });
      }
    }

    logger.info("exporter", `Import complete`, {
      slug,
      memories: agentPackage.memories.length,
      entities: agentPackage.knowledgeGraphEntities.length,
      skills: agentPackage.skills.length,
      tools: agentPackage.tools.length,
    });

    return project;
  }

  // ── Internal ─────────────────────────────────────────────

  private getEdgesForEntity(
    db: BeerCanDB,
    entityId: string,
    projectId: string,
  ): AgentPackageKGEdge[] {
    // Query edges where this entity is the source
    try {
      const rawDb = db.getDb();
      const rows = rawDb.prepare(
        "SELECT * FROM kg_edges WHERE project_id = ? AND (source_id = ? OR target_id = ?)"
      ).all(projectId, entityId, entityId) as any[];

      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        sourceId: row.source_id,
        targetId: row.target_id,
        edgeType: row.edge_type,
        weight: row.weight,
        properties: {},
        sourceBloopId: row.source_loop_id,
        createdAt: row.created_at,
      }));
    } catch {
      return [];
    }
  }
}
