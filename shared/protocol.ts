import { z } from 'zod';
export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/), name: z.string().min(1).max(100), path: z.string().min(1),
  runtime: z.enum(['static', 'command']), pathPrefix:z.enum(['root','task']).default('root'), refresh:z.enum(['reload','restart']).default('reload'), buildCommand: z.array(z.string()).default([]),
  startCommand: z.array(z.string()).default([]), port: z.number().int().min(1024).max(65535),
  readyPath: z.string().regex(/^\/(?!\/)/).default('/'),
  previewPath: z.string().regex(/^\/(?!\/)[^\\\r\n]*$/).default('/'),
  environment: z.record(z.string(),z.string()).default({}), safePreview: z.literal(true),
  exclude: z.array(z.string().regex(/^[\w.\/-]+$/)).default([])
});
export type Project = z.infer<typeof projectSchema>;
export const configSchema = z.object({hub: z.string().url(), user: z.string().min(1), token: z.string().min(32), dataDir: z.string(), projects: z.array(projectSchema)});
export type Config = z.infer<typeof configSchema>;
export const requestSchema = z.discriminatedUnion('method', [
  z.object({method:z.literal('projects'),params:z.object({})}),
  z.object({method:z.literal('models'),params:z.object({})}),
  z.object({method:z.literal('create'),params:z.object({projectId:z.string()})}),
  ...(['status','diff','stop','discard','restart','start-preview','stop-preview','interactive-preview'] as const).map(method=>z.object({method:z.literal(method),params:z.object({taskId:z.string().uuid()})})),
  z.object({method:z.literal('chat'),params:z.object({taskId:z.string().uuid(),prompt:z.string().min(1).max(20000),selection:z.string().max(12000).optional(),model:z.string().trim().min(1).max(256).optional()})}),
  z.object({method:z.literal('apply'),params:z.object({taskId:z.string().uuid(),revision:z.string().length(64),files:z.array(z.string()).min(1),approved:z.literal(true)})}),
  z.object({method:z.literal('restore'),params:z.object({taskId:z.string().uuid(),approved:z.literal(true)})}),
  z.object({method:z.literal('preview'),params:z.object({taskId:z.string().uuid(),path:z.string().startsWith('/').max(4096)})})
]);
export function redact(value: string) { return value.replace(/(bearer\s+)[\w.\-]+/gi,'$1[REDACTED]').replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,'$1[REDACTED]'); }
