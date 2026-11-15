import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { stackDoctorService } from '../services/stack-doctor.service.js';

const uuid = z.string().uuid();
function parse(value: unknown, label: string) {
  const result = uuid.safeParse(value);
  if (!result.success) throw new AppError(`${label} must be a valid UUID.`, 400, 'INVALID_ID');
  return result.data;
}
function userId(value: string | undefined) {
  if (!value) throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
  return value;
}
export const runStackDoctorScan: RequestHandler = async (request, response) => response.status(201).json(await stackDoctorService.scan(parse(request.params.projectId, 'Project ID'), userId(request.userId)));
export const getStackDoctorHistory: RequestHandler = async (request, response) => response.status(200).json(await stackDoctorService.history(parse(request.params.projectId, 'Project ID'), userId(request.userId)));
export const compareStackDoctorScan: RequestHandler = async (request, response) => response.status(200).json(await stackDoctorService.compare(parse(request.params.projectId, 'Project ID'), userId(request.userId), parse(request.params.scanId, 'Scan ID')));
