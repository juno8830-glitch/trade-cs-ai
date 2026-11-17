import { cfg } from './config.js';
import { Registry } from './agent/registry.js';
import { Router } from './router/index.js';
import { initPipeline } from './pipeline.js';

export const registry = new Registry(cfg);
export const router = new Router(registry, cfg);
initPipeline(router);
