import type { APIRoute } from 'astro';
import { getHealthResponse } from '../../utils/health';

export const prerender = false;

// Async now: the payload carries dependency reachability (#94). The response is
// still 200 whenever this process can render it, so the ALB, the container
// HEALTHCHECK and the uptime monitor keep reading liveness here.
export const GET: APIRoute = async () => getHealthResponse();

