import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err);

  if (err.message.startsWith('Missing required parameter:')) {
    res.status(400).json({ error: err.message, code: 'missing_parameter' });
    return;
  }

  if (err.message === 'Invalid password') {
    res.status(401).json({ error: err.message, code: 'unauthorized' });
    return;
  }

  if (err.message?.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
    return;
  }

  if (err.message?.startsWith('ComfyUI returned status')) {
    res.status(502).json({ error: 'ComfyUI service error', code: 'comfyui_unreachable' });
    return;
  }

  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}
