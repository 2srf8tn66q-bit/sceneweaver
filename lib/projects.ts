// 项目持久化：用 IndexedDB(idb-keyval) 存改编项目，防刷新丢失。
// 复用 copychat 的「key 前缀 + CRUD + entries 过滤」模式
//（来源：COPY CHAT/copy-chat-app/src/services/storage.ts）。

import { get, set, del, entries } from "idb-keyval";
import type { Screenplay } from "./screenplay/types";

const PROJECT_PREFIX = "project:";

export interface Project {
  id: string;
  title: string;
  novel: string;
  screenplay: Screenplay | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export async function saveProject(project: Project): Promise<void> {
  await set(`${PROJECT_PREFIX}${project.id}`, project);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return get<Project>(`${PROJECT_PREFIX}${id}`);
}

/** 所有项目，按更新时间倒序（最近编辑在前）。 */
export async function getAllProjects(): Promise<Project[]> {
  const all = await entries<string, Project>();
  return all
    .filter(([key]) => (key as string).startsWith(PROJECT_PREFIX))
    .map(([, value]) => value)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(id: string): Promise<void> {
  await del(`${PROJECT_PREFIX}${id}`);
}

/** 新建空项目（导入小说时调用）。标题默认取小说首行，可传入覆盖。 */
export function newProject(novel: string, title?: string): Project {
  const firstLine =
    novel
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? "";
  const t = title?.trim() || firstLine?.slice(0, 20) || "未命名改编";
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: t,
    novel,
    screenplay: null,
    createdAt: now,
    updatedAt: now,
  };
}
