export function getHealthReport() {
  return {
    status: 'ok',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

export function getHealthResponse(): Response {
  return new Response(JSON.stringify(getHealthReport()), {
    headers: { 'content-type': 'application/json' },
  });
}
