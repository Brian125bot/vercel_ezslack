const PLACEHOLDER_PATTERNS = [
  'MY_GEMINI_API_KEY', 'xoxb-myslackbottoken',
  'my_slack_signing_secret', 'MY_SIGNING_SECRET',
  'my_dashboard_password', 'changeme', 'placeholder',
  'workflow_internal_secret_placeholder', 'my_workflow_internal_secret',
];

export function isPlaceholder(val: string): boolean {
  const lower = val.toLowerCase();
  return PLACEHOLDER_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

interface CriticalVars {
  GEMINI_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DASHBOARD_PASSWORD: string;
  WORKFLOW_INTERNAL_SECRET?: string;
  DATABASE_URL?: string;
  CLOUD_SQL_CONNECTION_NAME?: string;
  SQL_HOST?: string;
  APP_URL?: string;
}

interface MissingVar {
  name: string;
  reason: 'missing' | 'placeholder';
}

function readCriticalVars(): CriticalVars {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || '',
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN?.trim() || '',
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET?.trim() || '',
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD?.trim() || '',
    WORKFLOW_INTERNAL_SECRET: process.env.WORKFLOW_INTERNAL_SECRET?.trim() || undefined,
    DATABASE_URL: process.env.DATABASE_URL?.trim() || undefined,
    CLOUD_SQL_CONNECTION_NAME: process.env.CLOUD_SQL_CONNECTION_NAME?.trim() || undefined,
    SQL_HOST: process.env.SQL_HOST?.trim() || undefined,
    APP_URL: process.env.APP_URL?.trim() || undefined,
  };
}

function checkVar(name: string, value?: string): MissingVar | null {
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
  const vars = readCriticalVars();
  const isProduction = process.env.NODE_ENV === 'production';
  const isVercel = process.env.VERCEL === '1';
  const missing: MissingVar[] = [];

  const check = (name: string, value?: string) => {
    const result = checkVar(name, value);
    if (result) missing.push(result);
  };

  // CRITICAL vars: hard-fail on ALL platforms including Vercel, regardless of
  // NODE_ENV. This prevents silent security failures (open signature
  // verification / open dashboard access) if an operator forgets to set them.
  check('GEMINI_API_KEY', vars.GEMINI_API_KEY);
  check('SLACK_BOT_TOKEN', vars.SLACK_BOT_TOKEN);
  check('SLACK_SIGNING_SECRET', vars.SLACK_SIGNING_SECRET);

  // WORKFLOW_INTERNAL_SECRET is required in production and whenever VERCEL=1
  if (isProduction || isVercel) {
    check('WORKFLOW_INTERNAL_SECRET', vars.WORKFLOW_INTERNAL_SECRET);
  }

  // DASHBOARD_PASSWORD: warn-only everywhere. Open-access dev mode is allowed,
  // but we surface a security warning so operators are not caught off guard.
  const checkDashboard = (value: string) => {
    const result = checkVar('DASHBOARD_PASSWORD', value);
    if (!result) return;
    const msg = result.reason === 'placeholder'
      ? `DASHBOARD_PASSWORD is set to a placeholder value — dashboard will be unprotected`
      : `DASHBOARD_PASSWORD not set — dashboard authentication is disabled (open access)`;
    console.warn(`[ENV] ⚠️ ${msg}. See .env.example.`);
  };
  checkDashboard(vars.DASHBOARD_PASSWORD);

  // Database durable state: require at least one connection source on all
  // platforms (including Vercel) so approval/goal/run state is not silently lost.
  const dbConfigured = !!(vars.DATABASE_URL || vars.CLOUD_SQL_CONNECTION_NAME || vars.SQL_HOST);
  if (!dbConfigured) {
    missing.push({ name: 'DATABASE_URL / CLOUD_SQL_CONNECTION_NAME / SQL_HOST', reason: 'missing' });
  } else if (isProduction) {
    for (const { name, val } of [
      { name: 'DATABASE_URL', val: vars.DATABASE_URL },
      { name: 'CLOUD_SQL_CONNECTION_NAME', val: vars.CLOUD_SQL_CONNECTION_NAME },
      { name: 'SQL_HOST', val: vars.SQL_HOST },
    ]) {
      if (val && isPlaceholder(val)) {
        missing.push({ name, reason: 'placeholder' });
      }
    }
  }

  if (isProduction) {
    if (!vars.APP_URL) {
      missing.push({ name: 'APP_URL', reason: 'missing' });
    } else if (isPlaceholder(vars.APP_URL)) {
      missing.push({ name: 'APP_URL', reason: 'placeholder' });
    }
  }

  if (missing.length > 0) {
    const varDescriptions: Record<string, string> = {
      'GEMINI_API_KEY': 'AI agent backend (required for agent logic)',
      'SLACK_BOT_TOKEN': 'Slack bot authentication (required for Slack integration)',
      'SLACK_SIGNING_SECRET': 'Slack request verification (required for request security)',
      'WORKFLOW_INTERNAL_SECRET': 'Internal workflow authentication (required for internal endpoint execution)',
      'DATABASE_URL / CLOUD_SQL_CONNECTION_NAME / SQL_HOST': 'Database connection (required for durable state)',
      'APP_URL': 'Application URL (required for webhook callbacks)',
    };

    for (const { name, reason } of missing) {
      const desc = varDescriptions[name] || '';
      let reasonText: string;
      if (name === 'SLACK_SIGNING_SECRET') {
        reasonText = `${name} is missing or a placeholder. Signature verification is disabled`;
      } else {
        reasonText = reason === 'placeholder'
          ? `${name} is missing or a placeholder`
          : `${name} is missing`;
      }
      const descSuffix = desc ? ` — ${desc}` : '';
      console.error(`[ENV] ❌ [FATAL] ${reasonText}${descSuffix}. See .env.example.`);
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
