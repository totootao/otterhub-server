import { Hono } from "hono";
import { listRoutes } from "./file/list";
import { downloadRoutes } from "./file/download";
import { rawRoutes } from "./file/raw";
import { thumbRoutes } from "./file/thumb";
import { metaRoutes } from "./file/meta";
import { actionRoutes } from "./file/action";
import { analyzeRoutes } from "./file/analyze";
import { browserRoutes } from "./file/browser";
import type { Env } from "../types/hono";

export const fileRoutes = new Hono<{ Bindings: Env }>();

fileRoutes.route("/", listRoutes);
fileRoutes.route("/", downloadRoutes);
fileRoutes.route("/", rawRoutes);
fileRoutes.route("/", thumbRoutes);
fileRoutes.route("/", metaRoutes);
fileRoutes.route("/", actionRoutes);
fileRoutes.route("/", analyzeRoutes);
fileRoutes.route("/browser", browserRoutes);
