import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { projectService } from '../services/project.service.js';

const repositoryUrlField = z
  .union([
    z.string().trim().max(2048).url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'Repository URL must use http or https.'),
    z.literal(''),
    z.null(),
  ])
  .optional()
  .transform((value) => (value === '' ? null : value));

const descriptionField = z
  .union([z.string().trim().max(1000, 'Description must be 1000 characters or fewer.'), z.null()])
  .optional()
  .transform((value) => (value === '' ? null : value));

const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.').max(100, 'Project name must be 100 characters or fewer.'),
  description: descriptionField,
  repositoryUrl: repositoryUrlField,
}).strict();

const updateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.').max(100, 'Project name must be 100 characters or fewer.').optional(),
  description: descriptionField,
  repositoryUrl: repositoryUrlField,
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: 'Provide at least one project field to update.',
});

const projectIdSchema = z.string().uuid('Project ID must be a valid UUID.');

function parseProjectId(id: unknown): string {
  const result = projectIdSchema.safeParse(id);
  if (!result.success) {
    throw new AppError('Project ID must be a valid UUID.', 400, 'INVALID_PROJECT_ID');
  }
  return result.data;
}

export const listProjects: RequestHandler = async (request, response) => {
  response.status(200).json(await projectService.list(requireUserId(request.userId)));
};

export const getProject: RequestHandler = async (request, response) => {
  response.status(200).json(await projectService.get(parseProjectId(request.params.id), requireUserId(request.userId)));
};

export const createProject: RequestHandler = async (request, response) => {
  const input = createProjectSchema.parse(request.body);
  const project = await projectService.create(requireUserId(request.userId), input);
  response.status(201).json(project);
};

export const updateProject: RequestHandler = async (request, response) => {
  const input = updateProjectSchema.parse(request.body);
  const project = await projectService.update(parseProjectId(request.params.id), requireUserId(request.userId), input);
  response.status(200).json(project);
};

export const deleteProject: RequestHandler = async (request, response) => {
  await projectService.remove(parseProjectId(request.params.id), requireUserId(request.userId));
  response.status(204).send();
};

function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  }
  return userId;
}
