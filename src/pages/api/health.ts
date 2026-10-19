
import type { APIRoute } from 'astro';
import { getHealthResponse } from '../../utils/health';

export const prerender = false;

export const GET: APIRoute = () => getHealthResponse();

