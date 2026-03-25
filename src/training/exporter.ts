import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { getLogger } from "../core/logger.js";
import type { BeerCanDB } from "../storage/database.js";
import type { Config } from "../config.js";
import type { BeerCanEngine } from "../index.js";
import type { TrainingProgress } from "./types.js";
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
   * Only exports skills/tools that the training agent created (tracked in progress).
   * Falls back to exporting all if not a training project.
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

    // Determine which skills/tools to filter by (training projects track what they created)
    const trainingProgress = project.context?.trainingProgress as TrainingProgress | undefined;
    const createdSkillNames = new Set(trainingProgress?.createdSkills ?? []);
    const createdToolNames = new Set(trainingProgress?.createdTools ?? []);
    const isTrainingProject = !!project.context?.isTrainee;

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

    // ── Collect KG entities and edges (use DB methods, not raw SQL) ──
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

    const edgesSeen = new Set<string>();
    const edges: AgentPackageKGEdge[] = [];
    for (const entity of kgEntities) {
      const entityEdges = db.getKGEdgesBoth(entity.id);
      for (const edge of entityEdges) {
        if (edge.projectId !== project.id) continue;
        if (edgesSeen.has(edge.id)) continue;
        edgesSeen.add(edge.id);
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

    // ── Collect skills (filter to project-created for training projects) ──
    const skillsDir = path.join(config.dataDir, "skills");
    const skills: AgentPackageSkill[] = [];
    if (fs.existsSync(skillsDir)) {
      const skillFiles = fs.readdirSync(skillsDir).filter((f: string) => f.endsWith(".json"));
      for (const file of skillFiles) {
        const skillName = file.replace(/\.json$/, "");
        // For training projects, only export skills the agent created
        if (isTrainingProject && createdSkillNames.size > 0 && !createdSkillNames.has(skillName)) {
          continue;
        }
        try {
          const content = fs.readFileSync(path.join(skillsDir, file), "utf-8");
          skills.push({ name: skillName, content });
        } catch (err: any) {
          logger.warn("exporter", `Failed to read skill: ${file}`, { error: err.message });
        }
      }
    }

    // ── Collect custom tools (filter to project-created for training projects) ──
    const toolsDir = path.join(config.dataDir, "tools");
    const tools: AgentPackageTool[] = [];
    if (fs.existsSync(toolsDir)) {
      const toolFiles = fs.readdirSync(toolsDir).filter(
        (f: string) => f.endsWith(".js") || f.endsWith(".mjs")
      );
      for (const file of toolFiles) {
        const toolName = file.replace(/\.(js|mjs)$/, "");
        if (isTrainingProject && createdToolNames.size > 0 && !createdToolNames.has(toolName)) {
          continue;
        }
        try {
          const content = fs.readFileSync(path.join(toolsDir, file), "utf-8");
          tools.push({ name: toolName, content });
        } catch (err: any) {
          logger.warn("exporter", `Failed to read tool: ${file}`, { error: err.message });
        }
      }
    }

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
   * Generates fresh UUIDs for all memories, KG entities, and edges
   * to prevent primary key collisions when importing the same package twice.
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

    // Import memories, KG, skills, and tools into the project
    await this.importDataIntoProject(project.id, agentPackage, db, config);

    logger.info("exporter", `Import complete`, {
      slug,
      memories: agentPackage.memories.length,
      entities: agentPackage.knowledgeGraphEntities.length,
      skills: agentPackage.skills.length,
      tools: agentPackage.tools.length,
    });

    return project;
  }

  // ── Import Global ──────────────────────────────────────

  /**
   * Import only skills and tools from a package globally (no project created).
   * Skills and tools are shared across all projects.
   * Memories and KG are skipped since they are project-scoped.
   */
  async importGlobal(
    packagePath: string,
    config: Config,
  ): Promise<{ skills: number; tools: number }> {
    const logger = getLogger();

    if (!fs.existsSync(packagePath)) {
      throw new Error(`Package file not found: ${packagePath}`);
    }

    const raw = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    const agentPackage = AgentPackageSchema.parse(raw);

    logger.info("exporter", `Global import from: ${packagePath}`);

    const skillCount = this.importSkillFiles(agentPackage, config);
    const toolCount = this.importToolFiles(agentPackage, config);

    logger.info("exporter", `Global import complete`, {
      skills: skillCount,
      tools: toolCount,
      skippedMemories: agentPackage.memories.length,
      skippedEntities: agentPackage.knowledgeGraphEntities.length,
    });

    return { skills: skillCount, tools: toolCount };
  }

  // ── Import Into Existing Project ──────────────────────

  /**
   * Import a package's data into an existing project.
   * Merges memories, KG, skills, and tools into the target project.
   */
  async importIntoProject(
    packagePath: string,
    projectSlug: string,
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

    const project = engine.getProject(projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    logger.info("exporter", `Importing into existing project: ${projectSlug}`, { packagePath });

    await this.importDataIntoProject(project.id, agentPackage, db, config);

    logger.info("exporter", `Import into ${projectSlug} complete`, {
      memories: agentPackage.memories.length,
      entities: agentPackage.knowledgeGraphEntities.length,
      skills: agentPackage.skills.length,
      tools: agentPackage.tools.length,
    });

    return project;
  }

  // ── Internal: shared import logic ─────────────────────

  private async importDataIntoProject(
    projectId: string,
    agentPackage: AgentPackage,
    db: BeerCanDB,
    config: Config,
  ): Promise<void> {
    const logger = getLogger();

    // Build ID remap tables (old ID → new UUID) to avoid PK collisions
    const memoryIdMap = new Map<string, string>();
    for (const mem of agentPackage.memories) {
      memoryIdMap.set(mem.id, uuid());
    }
    const entityIdMap = new Map<string, string>();
    for (const entity of agentPackage.knowledgeGraphEntities) {
      entityIdMap.set(entity.id, uuid());
    }
    const edgeIdMap = new Map<string, string>();
    for (const edge of agentPackage.knowledgeGraphEdges) {
      edgeIdMap.set(edge.id, uuid());
    }

    // ── Import memories ─────────────────────────────────────
    const { MemoryManager } = await import("../memory/index.js");
    const memoryManager = new MemoryManager(db);

    for (const mem of agentPackage.memories) {
      try {
        const newId = memoryIdMap.get(mem.id)!;
        const newSupersededBy = mem.supersededBy ? (memoryIdMap.get(mem.supersededBy) ?? null) : null;
        const entry = {
          ...mem,
          id: newId,
          projectId,
          sourceBloopId: null,
          supersededBy: newSupersededBy,
        };
        db.createMemoryEntry(entry as any);
        try {
          await memoryManager.getVectorStore().store(entry.id, `${entry.title}\n${entry.content}`);
        } catch {
          // Non-critical — vector indexing can fail without breaking import
        }
      } catch (err: any) {
        logger.warn("exporter", `Failed to import memory: ${mem.id}`, { error: err.message });
      }
    }

    // ── Import KG entities and edges ─────────────────────────
    for (const entity of agentPackage.knowledgeGraphEntities) {
      try {
        const newId = entityIdMap.get(entity.id)!;
        const newSourceMemoryId = entity.sourceMemoryId
          ? (memoryIdMap.get(entity.sourceMemoryId) ?? null)
          : null;
        db.createKGEntity({
          ...entity,
          id: newId,
          projectId,
          sourceBloopId: null,
          sourceMemoryId: newSourceMemoryId,
        } as any);
      } catch (err: any) {
        logger.warn("exporter", `Failed to import KG entity: ${entity.name}`, { error: err.message });
      }
    }

    for (const edge of agentPackage.knowledgeGraphEdges) {
      try {
        const newId = edgeIdMap.get(edge.id)!;
        const newSourceId = entityIdMap.get(edge.sourceId) ?? edge.sourceId;
        const newTargetId = entityIdMap.get(edge.targetId) ?? edge.targetId;
        db.createKGEdge({
          ...edge,
          id: newId,
          projectId,
          sourceId: newSourceId,
          targetId: newTargetId,
          sourceBloopId: null,
        } as any);
      } catch (err: any) {
        logger.warn("exporter", `Failed to import KG edge: ${edge.id}`, { error: err.message });
      }
    }

    // ── Import skills and tools (always global) ──────────────
    this.importSkillFiles(agentPackage, config);
    this.importToolFiles(agentPackage, config);
  }

  private importSkillFiles(agentPackage: AgentPackage, config: Config): number {
    const logger = getLogger();
    const skillsDir = path.join(config.dataDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    let count = 0;

    for (const skill of agentPackage.skills) {
      try {
        const skillPath = path.join(skillsDir, `${skill.name}.json`);
        if (!fs.existsSync(skillPath)) {
          fs.writeFileSync(skillPath, skill.content);
          count++;
        } else {
          logger.warn("exporter", `Skipped existing skill: ${skill.name}`);
        }
      } catch (err: any) {
        logger.warn("exporter", `Failed to import skill: ${skill.name}`, { error: err.message });
      }
    }
    return count;
  }

  private importToolFiles(agentPackage: AgentPackage, config: Config): number {
    const logger = getLogger();
    const toolsDir = path.join(config.dataDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    let count = 0;

    for (const tool of agentPackage.tools) {
      try {
        const toolPath = path.join(toolsDir, `${tool.name}.js`);
        if (!fs.existsSync(toolPath)) {
          fs.writeFileSync(toolPath, tool.content);
          count++;
        } else {
          logger.warn("exporter", `Skipped existing tool: ${tool.name}`);
        }
      } catch (err: any) {
        logger.warn("exporter", `Failed to import tool: ${tool.name}`, { error: err.message });
      }
    }
    return count;
  }
}
