const PLACEHOLDER_PATTERNS = [
  'MY_GEMINI_API_KEY', 'xoxb-myslackbottoken',
  'my_slack_signing_secret', 'MY_SIGNING_SECRET',
  'my_dashboard_password', 'changeme', 'placeholder',
];

function isPlaceholder(val: string): boolean {
  const lower = val.toLowerCase();
  return PLACEHOLDER_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

interface CriticalVars {
  GEMINI_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DASHBOARD_PASSWORD: string;
  DATABASE_URL?: string;
  CLOUD_SQL_CONNECTION_NAME?: string;
  SQL_HOST?: string;
  APP_URL?: string;
}

interface MissingVar {
  name: string;
  reason: 'missing' | 'empty' | 'placeholder';
}

function readCriticalVars(): CriticalVars {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || '',
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN?.trim() || '',
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET?.trim() || '',
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD?.trim() || '',
    DATABASE_URL: process.env.DATABASE_URL?.trim() || undefined,
    CLOUD_SQL_CONNECTION_NAME: process.env.CLOUD_SQL_CONNECTION_NAME?.trim() || undefined,
    SQL_HOST: process.env.SQL_HOST?.trim() || undefined,
    APP_URL: process.env.APP_URL?.trim() || undefined,
  };
}

function checkVar(name: string, value: string): MissingVar | null {
  if (!value) return { name, reason: 'missing' };
  if (isPlaceholder(value)) return { name, reason: 'placeholder' };
  return null;
}

const OPTIONAL_WARN_VARS: Array<{ key: string; desc: string }> = [
  { key: 'TAVILY_API_KEY', desc: 'Web search adapter (Tavily)' },
  { key: 'GITHUB_TOKEN', desc: 'GitHub Issues adapter' },
  { key: 'EMAIL_WEBHOOK_URL', desc: 'Email adapter' },
  { key: 'SANDBOX_API_KEY', desc: 'Code sandbox adapter' },
];

export function validateEnv(): void {
  if (process.env.VERCEL === '1') {
    return;
  }

  const vars = readCriticalVars();
  const isProduction = process.env.NODE_ENV === 'production';
  const missing: MissingVar[] = [];

  const check = (name: string, value: string) => {
    const result = checkVar(name, value);
    if (result) missing.push(result);
  };

  check('GEMINI_API_KEY', vars.GEMINI_API_KEY);
  check('SLACK_BOT_TOKEN', vars.SLACK_BOT_TOKEN);
  check('SLACK_SIGNING_SECRET', vars.SLACK_SIGNING_SECRET);

  const checkDashboard = (value: string) => {
    const result = checkVar('DASHBOARD_PASSWORD', value);
    if (!result) return;
    if (isProduction) {
      missing.push(result);
    } else {
      const msg = result.reason === 'placeholder'
        ? `DASHBOARD_PASSWORD is set to a placeholder value — dashboard will be unprotected`
        : `DASHBOARD_PASSWORD not set — dashboard authentication is disabled (open access)`;
      console.warn(`[ENV] ⚠️ ${msg}`);
    }
  };
  checkDashboard(vars.DASHBOARD_PASSWORD);

  const dbConfigured = !!(vars.DATABASE_URL || vars.CLOUD_SQL_CONNECTION_NAME || vars.SQL_HOST);
  if (!dbConfigured) {
    if (isProduction) {
      missing.push({ name: 'DATABASE_URL / CLOUD_SQL_CONNECTION_NAME / SQL_HOST', reason: 'missing' });
    } else {
      console.warn('[ENV] ⚠️ No database configuration found — server will start with in-memory state only');
    }
  }

  if (isProduction && !vars.APP_URL) {
    missing.push({ name: 'APP_URL', reason: 'missing' });
  }

  if (missing.length > 0) {
    for (const { name, reason } of missing) {
      const msg = reason === 'placeholder'
        ? `${name} is set to a placeholder value (e.g., "MY_GEMINI_API_KEY")`
        : `${name} is not set`;
      console.error(`[ENV] ❌ ${msg}`);
    }
    console.error('\n[FATAL] Server startup blocked: required environment variables are missing or invalid.');
    process.exit(1);
  }

  for (const { key, desc } of OPTIONAL_WARN_VARS) {
    const val = process.env[key]?.trim();
    if (!val) {
      console.warn(`[ENV] ⚠️ ${key} not set — ${desc} will be disabled`);
    } else if (isPlaceholder(val)) {
      console.warn(`[ENV] ⚠️ ${key} is set to a placeholder value — ${desc} will likely fail`);
    }
  }

  if (!isProduction && !vars.APP_URL) {
    console.warn('[ENV] ⚠️ APP_URL not set — webhook callbacks will use http://localhost:3000 (dev mode only)');
  }
}
