import { Request, Response, NextFunction } from 'express';

export const requireDashboardAuth = (req: Request, res: Response, next: NextFunction) => {
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
  if (!DASHBOARD_PASSWORD) {
    // If DASHBOARD_PASSWORD is not set in env, allow open access
    return next();
  }
  
  const authHeader = req.headers['authorization'];
  let receivedPassword = '';
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    receivedPassword = authHeader.substring(7).trim();
  } else {
    const headerPass = req.headers['x-dashboard-password'];
    if (headerPass) {
       receivedPassword = (Array.isArray(headerPass) ? headerPass[0] : headerPass).trim();
    }
  }

  if (receivedPassword === DASHBOARD_PASSWORD) {
    return next();
  }

  return res.status(401).json({ 
    error: 'Unauthorized',
    dashboardPasswordRequired: true
  });
};
